import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

import type { CaptureEnvelope } from "../contracts/ingest.js";
import { validateSnapshot } from "../src/config.js";
import { createDashboard } from "../src/dashboard.js";
import { planMessages } from "../src/queue.js";
import { readStatistics } from "../src/statistics.js";
import { openStore } from "../src/storage.js";

function fixture() {
    const store = openStore(":memory:");
    store.installConfig(validateSnapshot({ routes: [
        { routeId: "futu", name: "futu-news", enabled: true, serverId: "2", channelId: "3", targetChannelId: "5" },
        { routeId: "other", name: "其他资讯", enabled: true, serverId: "2", channelId: "4", targetChannelId: "6" },
    ], signal: { enabled: false } }));
    for (const [id, channelId] of [["100", "3"], ["101", "4"]]) {
        const event: CaptureEnvelope = { schemaVersion: 2, eventId: `dashboard:${id}`, eventType: "MESSAGE_CREATE", capturedAt: new Date().toISOString(), accountId: "1", serverId: "2", channelId, excludedServerIds: [], message: { id, content: "private-message-sentinel", timestamp: new Date().toISOString(), author: { id: "9" } } };
        store.ingest(event, JSON.stringify(event));
        if (id === "100") store.ingest({ ...event, eventId: "second-observation" }, JSON.stringify({ ...event, eventId: "second-observation" }));
    }
    planMessages(store, []);
    const jobs = store.db.prepare("SELECT * FROM jobs ORDER BY route_id").all() as { id: string; route_id: string; target: string; }[];
    const now = Date.now();
    for (const job of jobs) {
        const sent = job.route_id === "futu";
        store.db.prepare("UPDATE jobs SET state=? WHERE id=?").run(sent ? "sent" : "retry_wait", job.id);
        store.db.prepare("INSERT INTO delivery_attempts(job_id,started_at,finished_at,outcome,error) VALUES(?,?,?,?,?)").run(job.id, now - 100, now - 10, sent ? "sent" : "preflight_failed", sent ? "" : "missing_discord_webhook");
        if (sent) store.db.prepare("INSERT INTO sink_deliveries VALUES(?,?,?,?,?,'sent','200',?,?)").run(job.id, job.id, "9", job.target, "nonce", now - 100, now - 10);
    }
    store.alert("test_failure", "private-alert-body-sentinel");
    return store;
}

test("statistics distinguish observations, messages, delivered jobs and failed attempts without exposing message bodies", context => {
    const store = fixture();
    context.after(() => store.close());
    const data = readStatistics(store);
    assert.equal(data.summary.messages, 2);
    assert.equal(data.summary.receipts, 3);
    assert.equal(data.summary.delivered, 1);
    assert.equal(data.summary.queued, 1);
    assert.equal(data.summary.successRate24h, 0.5);
    assert.equal(data.traffic.hour.failedAttempts, 1);
    assert.equal(data.deliveryDurationP95Ms, 90);
    assert.equal(data.routes.find(route => route.routeId === "other")?.attention, 1);
    assert.equal(data.routes.find(route => route.routeId === "futu")?.sent, 1);
    assert.equal(data.timeline.length, 60);
    assert.equal(data.timeline.reduce((sum, minute) => sum + minute.captured, 0), 2);
    assert.equal(data.timeline.reduce((sum, minute) => sum + minute.delivered, 0), 1);
    assert.equal(data.health, "degraded");
    assert.doesNotMatch(JSON.stringify(data), /private-message-sentinel|private-alert-body-sentinel|nonce|envelope|authorization/i);
});

test("the monitor serves its HTML and assets, rejects mutations, and returns read-only health and statistics", async context => {
    const store = fixture();
    const server = createDashboard(store);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    context.after(async () => { await new Promise<void>(done => server.close(() => done())); store.close(); });
    const base = `http://127.0.0.1:${(server.address() as { port: number; }).port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /消息流水|路由状态/);
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.equal((await fetch(`${base}/dashboard.css`)).status, 200);
    assert.equal((await fetch(`${base}/dashboard.js`)).status, 200);
    assert.equal((await fetch(`${base}/api/status`)).headers.get("cache-control"), "no-store");
    const stats = await (await fetch(`${base}/api/status`)).json();
    assert.equal(stats.summary.messages, 2);
    assert.ok(stats.resources.rssBytes > 0);
    assert.equal((await (await fetch(`${base}/healthz`)).json()).ok, true);
    assert.equal((await fetch(`${base}/api/local/test-mode`, { method: "POST", body: '{"enabled":true}' })).status, 405);
    assert.equal(store.metadata("test_mode"), undefined);
    assert.equal((await fetch(`${base}/../secrets.json`)).status, 404);
    assert.equal(await (await fetch(base, { method: "HEAD" })).text(), "");
});
