import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

import type { CaptureEnvelope } from "../contracts/ingest.js";
import { validateSnapshot } from "../src/config.js";
import { createLocalRouteTest, localServiceStatus } from "../src/diagnostics.js";
import { createDiscordSender } from "../src/discord.js";
import { createHubHttp } from "../src/http.js";
import { executable, planMessages } from "../src/queue.js";
import { openStore } from "../src/storage.js";

function configuration() {
    return validateSnapshot({ routes: [
        { routeId: "futu", name: "futu-news", enabled: true, serverId: "2", channelId: "3", targetChannelId: "5" },
        { routeId: "other", name: "other", enabled: true, serverId: "2", channelId: "4", targetChannelId: "6" },
    ], signal: { enabled: true, model: "test", targetChannelId: "7", routeIds: ["futu", "other"] } });
}

test("test mode only forwards fresh futu-news and rechecks already planned deliveries", context => {
    const store = openStore(":memory:");
    context.after(() => store.close());
    store.installConfig(configuration());
    const cutoff = new Date(Date.now() - 1000).toISOString();
    store.setMetadata("forward_after", cutoff);
    store.setMetadata("test_mode", "true");
    for (const [id, channelId, timestamp] of [["100", "3", new Date().toISOString()], ["101", "4", new Date().toISOString()], ["102", "3", new Date(0).toISOString()]] as const) {
        const event: CaptureEnvelope = { schemaVersion: 2, eventId: `test:${id}`, eventType: "RECOVERY", capturedAt: new Date().toISOString(), accountId: "1", serverId: "2", channelId, excludedServerIds: [], message: { id, author: { id: "9" }, content: "news", timestamp } };
        store.ingest(event, JSON.stringify(event));
    }
    planMessages(store, []);
    const jobs = store.db.prepare("SELECT kind,target FROM jobs").all() as { kind: string; target: string; }[];
    assert.deepEqual(jobs.map(row => ({ ...row })), [{ kind: "deliver", target: "5" }]);
    assert.equal((store.db.prepare("SELECT state FROM messages WHERE message_key='discord:2:4:101'").get() as any).state, "test_mode_filtered");
    assert.equal((store.db.prepare("SELECT state FROM messages WHERE message_key='discord:2:3:102'").get() as any).state, "before_forward_cutoff");
    const job = store.claim("deliver");
    assert.ok(executable(store, job, []));
    assert.equal(executable(store, { ...job, kind: "signal", target: "7" }, []), undefined);
    assert.equal(localServiceStatus(store, []).routes.find(route => route.routeId === "other")?.enabled, false);
    assert.equal(createLocalRouteTest(store, "00000000-0000-0000-0000-000000000001", "other", []).error, "test_mode_filtered");
    store.setMetadata("test_mode", "false");
    assert.equal(localServiceStatus(store, []).routes.find(route => route.routeId === "other")?.enabled, true);
    planMessages(store, []);
    assert.equal(store.db.prepare("SELECT * FROM jobs").all().length, 1, "Disabling test mode must not replay previously filtered messages");
    store.setMetadata("test_mode", "true");
    store.installConfig({ ...configuration(), routes: configuration().routes.filter(route => route.routeId !== "futu"), signal: { ...configuration().signal, enabled: false, routeIds: [] } });
    assert.equal(executable(store, job, []), undefined, "Missing futu-news configuration must fail closed");
});

test("the local test-mode switch authenticates, persists through its callback and returns updated status", async context => {
    const store = openStore(":memory:");
    store.installConfig(configuration());
    const changes: boolean[] = [];
    const server = createHubHttp(store, { pairingToken: "test-token", adminToken: "", setTestMode: enabled => { changes.push(enabled); store.setMetadata("test_mode", String(enabled)); } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    context.after(async () => { await new Promise<void>(done => server.close(() => done())); store.close(); });
    const endpoint = `http://127.0.0.1:${(server.address() as any).port}/api/local/test-mode`;
    const send = (input: unknown, authenticated = true) => fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: "Bearer test-token" } : {}) }, body: JSON.stringify(input) });
    assert.equal((await send({ enabled: true }, false)).status, 401);
    assert.equal((await send({ enabled: "true" })).status, 400);
    const response = await send({ enabled: true });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).testMode, true);
    assert.deepEqual(changes, [true]);
    assert.equal((await (await send({ enabled: false })).json()).testMode, false);
});

test("test mode retains messages until the first valid configuration identifies futu-news", context => {
    const store = openStore(":memory:");
    context.after(() => store.close());
    store.setMetadata("test_mode", "true");
    const event: CaptureEnvelope = { schemaVersion: 2, eventId: "waiting:100", eventType: "MESSAGE_CREATE", capturedAt: new Date().toISOString(), accountId: "1", serverId: "2", channelId: "3", excludedServerIds: [], message: { id: "100", author: { id: "9" }, content: "news", timestamp: new Date().toISOString() } };
    store.ingest(event, JSON.stringify(event));
    planMessages(store, []);
    assert.equal((store.db.prepare("SELECT state FROM messages").get() as any).state, "waiting_config");
    store.installConfig(configuration());
    planMessages(store, []);
    assert.equal(store.db.prepare("SELECT * FROM jobs WHERE kind='deliver'").all().length, 1);
});

test("enabling test mode while Discord preflight is in flight prevents another route from sending", async context => {
    const store = openStore(":memory:");
    context.after(() => store.close());
    store.installConfig(configuration());
    const event: CaptureEnvelope = { schemaVersion: 2, eventId: "race:100", eventType: "MESSAGE_CREATE", capturedAt: new Date().toISOString(), accountId: "1", serverId: "2", channelId: "4", excludedServerIds: [], message: { id: "100", author: { id: "9" }, content: "other news", timestamp: new Date().toISOString() } };
    store.ingest(event, JSON.stringify(event));
    planMessages(store, []);
    let posts = 0;
    const sender = createDiscordSender(store, { botToken: "test" }, [], (async (input, init) => {
        if (init?.method === "POST") { posts++; return Response.json({ id: "200", channel_id: "6" }); }
        store.setMetadata("test_mode", "true");
        return Response.json(String(input).endsWith("/users/@me") ? { id: "8", bot: true } : { id: "6", guild_id: "2" });
    }) as typeof fetch);
    const job = store.claim("deliver");
    await sender.send(job);
    assert.equal(posts, 0);
    assert.equal((store.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id) as any).state, "held");
});
