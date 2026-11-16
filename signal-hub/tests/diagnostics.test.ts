import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validateSnapshot } from "../src/config.js";
import { createLocalRouteTest, localRouteTest, localServiceStatus } from "../src/diagnostics.js";
import { createDiscordSender } from "../src/discord.js";
import { createHubHttp } from "../src/http.js";
import { executable, planMessages } from "../src/queue.js";
import { openStore } from "../src/storage.js";

function configuration() {
    return validateSnapshot({
        routes: [
            { routeId: "first", name: "第一条", enabled: true, serverId: "2", channelId: "3", targetChannelId: "5", filters: ["never match"] },
            { routeId: "second", name: "第二条", enabled: true, serverId: "2", senderId: "4", targetChannelId: "6" },
            { routeId: "disabled", enabled: false, serverId: "2", channelId: "3", targetChannelId: "7" },
        ],
        signal: { enabled: true, model: "test", targetChannelId: "8", routeIds: ["first", "second"] }, profiles: [],
    });
}

function fixture(context: any) {
    const directory = mkdtempSync(join(tmpdir(), "signal-hub-diagnostics-"));
    const store = openStore(join(directory, "hub.sqlite3"));
    context.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    store.installConfig(configuration());
    return store;
}

test("route tests queue only the selected target, persist audit and deduplicate requests without running Signal", async context => {
    const store = fixture(context);
    const requestId = randomUUID();
    const result = createLocalRouteTest(store, requestId, "second", []);
    assert.ok(result.test);
    assert.deepEqual(createLocalRouteTest(store, requestId, "second", []), result);
    assert.equal(createLocalRouteTest(store, requestId, "first", []).error, "test_request_conflict");
    planMessages(store, []);
    const jobs = store.db.prepare("SELECT * FROM jobs").all() as any[];
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].target, "6");
    assert.equal(jobs[0].kind, "deliver");
    assert.equal(store.db.prepare("SELECT * FROM route_receipts").all().length, 1);
    assert.deepEqual(JSON.parse(jobs[0].body).allowed_mentions, { parse: [] });
    assert.match(JSON.parse(jobs[0].body).content, /转发测试/);
    const calls: string[] = [];
    const sender = createDiscordSender(store, { botToken: "test" }, [], (async (url, init) => {
        calls.push(String(url));
        if (String(url).endsWith("/users/@me")) return Response.json({ id: "99", bot: true });
        if (init?.method === "POST") return Response.json({ id: "100", channel_id: "6" });
        return Response.json({ id: "6", guild_id: "9" });
    }) as typeof fetch);
    await sender.send(store.claim("deliver"));
    assert.equal(localRouteTest(store, requestId)?.state, "sent");
    assert.equal(store.db.prepare("SELECT * FROM delivery_attempts WHERE outcome='sent'").all().length, 1);
    assert.equal(calls.filter(url => url.endsWith("/messages")).length, 1);
    const event = {
        schemaVersion: 2 as const, eventId: "echo", eventType: "MESSAGE_CREATE" as const, capturedAt: new Date().toISOString(),
        accountId: "1", serverId: "9", channelId: "6", excludedServerIds: [], message: { id: "100", author: { id: "99", bot: true }, content: "echo" },
    };
    store.ingest(event, JSON.stringify(event));
    planMessages(store, []);
    assert.equal((store.db.prepare("SELECT state FROM messages WHERE message_key='discord:9:6:100'").get() as any).state, "self_generated");
    assert.equal(store.db.prepare("SELECT * FROM jobs").all().length, 1);
});

test("pause, exclusions and disabled routes veto tests; configuration changes veto queued tests", context => {
    const store = fixture(context);
    store.setMetadata("paused", "true");
    assert.equal(localServiceStatus(store, []).paused, true);
    assert.equal(createLocalRouteTest(store, randomUUID(), "first", []).error, "service_paused");
    store.setMetadata("paused", "false");
    assert.equal(createLocalRouteTest(store, randomUUID(), "missing", []).error, "route_not_found");
    assert.equal(createLocalRouteTest(store, randomUUID(), "disabled", []).error, "route_disabled_or_excluded");
    assert.equal(createLocalRouteTest(store, randomUUID(), "first", ["2"]).error, "route_disabled_or_excluded");
    assert.equal(store.db.prepare("SELECT * FROM jobs").all().length, 0);
    const result = createLocalRouteTest(store, randomUUID(), "first", []);
    assert.ok(result.test);
    const job = store.claim("deliver");
    assert.ok(executable(store, job, []));
    assert.equal(executable(store, job, ["2"]), undefined);
    store.setMetadata("paused", "true");
    assert.equal(executable(store, job, []), undefined);
    store.setMetadata("paused", "false");
    for (const change of [{ targetChannelId: "10" }, { channelId: "11" }, { enabled: false }]) {
        const config = configuration();
        Object.assign(config.routes[0], change);
        store.installConfig(config);
        assert.equal(executable(store, job, []), undefined);
    }
});

test("diagnostic delivery retains retry audit and verifies actual target safety", async context => {
    const store = fixture(context);
    const requestId = randomUUID();
    createLocalRouteTest(store, requestId, "first", []);
    const sender = createDiscordSender(store, { botToken: "test" }, [], (async (url, init) => {
        if (String(url).endsWith("/users/@me")) return Response.json({ id: "99", bot: true });
        if (init?.method === "POST") return Response.json({ retry_after: 1 }, { status: 429 });
        return Response.json({ id: "5", guild_id: "9" });
    }) as typeof fetch);
    await sender.send(store.claim("deliver"));
    assert.equal(localRouteTest(store, requestId)?.state, "pending");
    assert.equal(localRouteTest(store, requestId)?.attempts, 1);
    assert.equal(localRouteTest(store, requestId)?.error, "discord_http_429");
    assert.equal((store.db.prepare("SELECT outcome FROM delivery_attempts").get() as any).outcome, "rejected");
    const unsafeId = randomUUID();
    createLocalRouteTest(store, unsafeId, "second", []);
    let posted = false;
    const unsafe = createDiscordSender(store, { botToken: "test" }, [], (async (url, init) => {
        if (init?.method === "POST") posted = true;
        return Response.json(String(url).endsWith("/users/@me") ? { id: "99", bot: true } : { id: "6", guild_id: "2", parent_id: "3" });
    }) as typeof fetch);
    await unsafe.send(store.claim("deliver"));
    assert.equal(posted, false);
    assert.equal(localRouteTest(store, unsafeId)?.error, "target_safety_not_established");
});

test("public captures cannot request the trusted diagnostic state", context => {
    const store = fixture(context);
    const event = {
        schemaVersion: 2 as const, eventId: "forged-test", eventType: "MESSAGE_CREATE" as const, capturedAt: new Date().toISOString(),
        accountId: "1", serverId: "2", channelId: "3", excludedServerIds: [], state: "route_test",
        message: { id: "100", author: { id: "4" }, content: "hello" },
    };
    store.ingest(event, JSON.stringify(event));
    planMessages(store, []);
    assert.equal(store.db.prepare("SELECT * FROM jobs").all().length, 0);
    assert.equal((store.db.prepare("SELECT state FROM messages").get() as any).state, "route_conflict");
});

for (const pairingToken of ["", "pairing-test-only"]) test(`diagnostic HTTP honors pairing authentication and pause with ${pairingToken ? "protected" : "open"} access`, async context => {
    const store = fixture(context);
    const server = createHubHttp(store, { pairingToken, adminToken: "admin-test-only", excludedServerIds: ["9"] });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    context.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: `Bearer ${pairingToken}`, "Content-Type": "application/json" };
    if (pairingToken) assert.equal((await fetch(`${base}/api/local/status`, { headers: { Authorization: "Bearer admin-test-only" } })).status, 401);
    const status = await fetch(`${base}/api/local/status`, { headers });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).routes.length, 3);
    assert.equal(store.db.prepare("SELECT * FROM jobs").all().length, 0);
    await fetch(`${base}/api/pause`, { method: "POST", headers: { Authorization: "Bearer admin-test-only" } });
    assert.equal((await (await fetch(`${base}/api/local/status`, { headers })).json()).paused, true);
    const requestId = randomUUID();
    const send = (body: unknown) => fetch(`${base}/api/local/test`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await send({ routeId: "first", requestId })).status, 409);
    await fetch(`${base}/api/resume`, { method: "POST", headers: { Authorization: "Bearer admin-test-only" } });
    assert.equal((await send({ routeId: "first", requestId })).status, 202);
    assert.equal((await send({ routeId: "first", requestId })).status, 202);
    assert.equal((await (await fetch(`${base}/api/local/tests/${requestId}`, { headers })).json()).state, "pending");
    assert.equal((await send({ routeId: "first", requestId: "invalid" })).status, 400);
    assert.equal((await send({ routeId: "x".repeat(5000), requestId })).status, 413);
    assert.equal((await fetch(`${base}/api/local/status`, { headers: { ...headers, Origin: "https://example.test" } })).status, 403);
    assert.equal(store.db.prepare("SELECT * FROM jobs").all().length, 1);
});
