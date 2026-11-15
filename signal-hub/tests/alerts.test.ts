import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, TestContext } from "node:test";

import { flushAlerts, refreshHealthAlerts } from "../src/alerts.js";
import { openStore } from "../src/storage.js";
import { createWatchdog } from "../src/watchdog.js";

function fixture(context: TestContext) {
    const directory = mkdtempSync(join(tmpdir(), "hub-alerts-"));
    const path = join(directory, "hub.sqlite3");
    let store = openStore(path);
    const notifications: string[] = [];
    const fetcher = (async (_input: any, init: RequestInit) => {
        notifications.push(JSON.parse(String(init.body)).text.content);
        return Response.json({ errcode: 0 });
    }) as typeof fetch;
    context.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    return { directory, get store() { return store; }, notifications, fetcher, restart() { store.close(); store = openStore(path); } };
}

test("DingTalk batches duplicate faults, fast-tracks severe incidents and repeats unresolved faults without flooding", async context => {
    const state = fixture(context);
    const now = Date.now() + 1000;
    for (let index = 0; index < 10; index++) state.store.alert(`warning_${index}`, "Configuration needs attention");
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now);
    assert.equal(state.notifications.length, 1);
    assert.ok(state.notifications[0].includes("warning_0"));
    assert.ok(state.notifications[0].includes("warning_9"));
    state.store.alert("new_warning", "New warning");
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now + 31_000);
    assert.equal(state.notifications.length, 1);
    state.store.alert("delivery_uncertain", "Check delivery state", "critical");
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now + 32_000);
    assert.equal(state.notifications.length, 2);
    assert.ok(state.notifications[1].includes("严重"));
    assert.ok(state.notifications[1].includes("new_warning"));
    state.store.alert("delivery_uncertain", "Check delivery state", "critical");
    state.restart();
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now + 33_000);
    assert.equal(state.notifications.length, 2);
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now + 332_000);
    assert.equal(state.notifications.length, 3);
    assert.ok(state.notifications[2].includes("delivery_uncertain"));
    assert.equal(state.notifications[2].includes("warning_0"), false);
    state.store.resolveAlert("delivery_uncertain");
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now + 632_000);
    assert.equal(state.notifications.length, 4);
    assert.ok(state.notifications[3].includes("恢复"));
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now + 932_000);
    assert.equal(state.notifications.length, 4);
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now + 1_800_000);
    assert.equal(state.notifications.length, 5);
    assert.ok(state.notifications[4].includes("warning_0"));
});

test("severity escalation bypasses the normal digest cooldown but bursts share a short send limit", async context => {
    const state = fixture(context);
    const now = Date.now() + 1000;
    state.store.alert("blocked", "Blocked");
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now);
    state.store.alert("blocked", "Now severe", "critical");
    state.store.alert("other", "Another severe fault", "critical");
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now + 10_000);
    assert.equal(state.notifications.length, 1);
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now + 30_000);
    assert.equal(state.notifications.length, 2);
    assert.ok(state.notifications[1].includes("Now severe"));
    assert.ok(state.notifications[1].includes("Another severe fault"));
});

test("unnotified transient faults do not emit recovery messages and a new incident cancels stale recovery", async context => {
    const state = fixture(context);
    const now = Date.now() + 1000;
    state.store.alert("transient", "Transient");
    state.store.resolveAlert("transient");
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now);
    assert.equal(state.notifications.length, 0);
    state.store.alert("persistent", "Persistent", "critical");
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now + 1000);
    state.store.resolveAlert("persistent");
    state.store.alert("persistent", "Failed again", "critical");
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now + 31_000);
    assert.equal(state.notifications.length, 2);
    assert.ok(state.notifications[1].includes("Failed again"));
    assert.equal(state.notifications[1].includes("恢复"), false);
});

test("resolving a fault while the digest request is in flight never reactivates the fault", async context => {
    const state = fixture(context);
    const now = Date.now() + 1000;
    state.store.alert("in_flight", "Fault", "critical");
    await flushAlerts(state.store, "https://alert.test", (async () => {
        state.store.resolveAlert("in_flight");
        return Response.json({ errcode: 0 });
    }) as typeof fetch, now);
    const original = state.store.db.prepare("SELECT active FROM alerts WHERE code='in_flight'").get() as any;
    assert.equal(original.active, 0);
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now + 300_000);
    assert.equal(state.notifications.length, 1);
    assert.ok(state.notifications[0].includes("in_flight_recovered"));
});

test("a severity upgrade during a notification request cannot inherit the old warning reminder delay", async context => {
    const state = fixture(context);
    const now = Date.now() + 1000;
    state.store.alert("changing", "Warning");
    await flushAlerts(state.store, "https://alert.test", (async () => {
        state.store.alert("changing", "Critical now", "critical");
        return Response.json({ errcode: 0 });
    }) as typeof fetch, now);
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now + 30_000);
    assert.equal(state.notifications.length, 1);
    assert.ok(state.notifications[0].includes("Critical now"));
});

test("health alerts detect overdue ready jobs and only recover when all affected deliveries recover", async context => {
    const state = fixture(context);
    const now = Date.now() + 1000;
    state.store.setMetadata("config_hash", "fixture");
    state.store.setMetadata("config_synced_at", String(now));
    state.store.db.prepare("INSERT INTO messages(message_key,envelope,state,created_at) VALUES('source','{}','routed',?)").run(now - 120_000);
    const first = state.store.enqueue("source", "deliver", "route", "target1", 0, {}, "fixture");
    const second = state.store.enqueue("source", "deliver", "route", "target2", 0, {}, "fixture");
    refreshHealthAlerts(state.store, now);
    assert.ok((state.store.status().activeAlerts as any[]).some(row => row.code === "delivery_backlog" && row.severity === "critical"));
    state.store.db.prepare("UPDATE jobs SET state='uncertain',error='send_outcome_unknown'").run();
    state.store.alert("delivery_uncertain", "Unknown delivery outcome", "critical");
    await flushAlerts(state.store, "https://alert.test", state.fetcher, now);
    state.store.db.prepare("UPDATE jobs SET state='sent',error='' WHERE id=?").run(first);
    refreshHealthAlerts(state.store, now + 30_000);
    assert.ok((state.store.status().activeAlerts as any[]).some(row => row.code === "delivery_uncertain"));
    state.store.db.prepare("UPDATE jobs SET state='sent',error='' WHERE id=?").run(second);
    refreshHealthAlerts(state.store, now + 60_000);
    assert.equal((state.store.status().activeAlerts as any[]).some(row => row.code === "delivery_uncertain"), false);
    assert.ok((state.store.status().activeAlerts as any[]).some(row => row.code === "delivery_uncertain_recovered"));
});

test("watchdog persists outage notifications, repeats sustained failures and sends one recovery", async context => {
    const state = fixture(context);
    const now = Date.now() + 1000;
    writeFileSync(join(state.directory, "heartbeat.json"), "{broken");
    let check = createWatchdog(state.directory, "https://alert.test", state.fetcher);
    await check(now); await check(now + 30_000);
    assert.equal(state.notifications.length, 0);
    await check(now + 60_000);
    assert.equal(state.notifications.length, 1);
    check = createWatchdog(state.directory, "https://alert.test", state.fetcher);
    await check(now + 90_000); await check(now + 120_000); await check(now + 150_000);
    assert.equal(state.notifications.length, 1);
    await check(now + 360_000);
    assert.equal(state.notifications.length, 2);
    assert.ok(state.notifications[1].includes("still missing"));
    writeFileSync(join(state.directory, "heartbeat.json"), JSON.stringify({ time: now + 390_000 }));
    await check(now + 390_000);
    assert.equal(state.notifications.length, 3);
    assert.ok(state.notifications[2].includes("recovered"));
    check = createWatchdog(state.directory, "https://alert.test", state.fetcher);
    await check(now + 420_000);
    assert.equal(state.notifications.length, 3);
});
