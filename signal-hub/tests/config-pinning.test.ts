import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test, TestContext } from "node:test";

import { CaptureEnvelope } from "../contracts/ingest.js";
import { Snapshot, validateSnapshot } from "../src/config.js";
import { executable, planMessages } from "../src/queue.js";
import { runExtraction } from "../src/signal.js";
import { openStore } from "../src/storage.js";

function configuration(): Snapshot {
    return validateSnapshot({
        routes: [{
            routeId: "route", name: "Pinned route", enabled: true, serverId: "2", channelId: "3", targetChannelId: "5",
            replacements: [{ find: "hello", replaceWith: "pinned entry" }],
        }],
        signal: {
            enabled: true, model: "pinned-model", timeoutMs: 1000, targetChannelId: "6", indexTargetChannelId: "7",
            routes: [{ routeId: "route", enabled: true, tickerWhitelistEnabled: true, tickerWhitelist: ["AAPL"] }],
        },
    });
}

function fixture(context: TestContext, snapshot = configuration()) {
    const store = openStore(":memory:");
    context.after(() => store.close());
    store.installConfig(snapshot);
    const event: CaptureEnvelope = {
        schemaVersion: 2, eventId: "pinning:100", eventType: "MESSAGE_CREATE", capturedAt: new Date().toISOString(),
        accountId: "1", serverId: "2", channelId: "3", excludedServerIds: [],
        message: { id: "100", channel_id: "3", guild_id: "2", author: { id: "4" }, content: "hello", type: 0 },
    };
    store.ingest(event, JSON.stringify(event));
    planMessages(store, []);
    return { store, snapshot, event, delivery: store.claim("deliver"), extraction: store.claim("extract") };
}

test("queued deliveries keep their original target and body while exposing current topology", context => {
    const { store, snapshot, delivery } = fixture(context);
    const current = store.installConfig({
        ...snapshot,
        routes: [{ ...snapshot.routes[0], targetChannelId: "8", replacements: [{ find: "hello", replaceWith: "changed entry", caseSensitive: false }] }],
    });
    const execution = executable(store, delivery, []);
    assert.ok(execution);
    assert.equal(execution.config.hash, delivery.config_hash);
    assert.equal(execution.route.targetChannelId, "5");
    assert.match(JSON.parse(delivery.body).content, /pinned entry/);
    assert.equal(execution.currentConfig.hash, current.hash);
    assert.equal(execution.currentConfig.snapshot.routes[0].targetChannelId, "8");
    assert.equal(executable(store, { ...delivery, target: "8" }, []), undefined);
});

test("queued Signal deliveries validate ordinary and index targets against the pinned snapshot", context => {
    const { store, snapshot, extraction } = fixture(context);
    store.installConfig({ ...snapshot, signal: { ...snapshot.signal, targetChannelId: "8", indexTargetChannelId: "9" } });
    for (const target of ["6", "7"]) {
        store.enqueue(extraction.message_key, "signal", "route", target, 0, { content: "signal" }, extraction.config_hash);
        const job = store.claim("signal");
        const execution = executable(store, job, []);
        assert.ok(execution);
        assert.equal(execution.config.hash, extraction.config_hash);
        assert.equal(executable(store, { ...job, target: "8" }, []), undefined);
        assert.equal(executable(store, { ...job, target: "9" }, []), undefined);
    }
});

test("messages pin their admission configuration before planning across a refresh", context => {
    const { store, snapshot, event, delivery } = fixture(context);
    const pending = { ...event, eventId: "pinning:101", message: { ...event.message, id: "101" } };
    store.ingest(pending, JSON.stringify(pending));
    store.installConfig({ ...snapshot, routes: [{ ...snapshot.routes[0], targetChannelId: "8" }] });
    planMessages(store, []);
    const job = store.db.prepare("SELECT * FROM jobs WHERE message_key='discord:2:3:101' AND kind='deliver'").get() as any;
    assert.equal(job.target, "5");
    assert.equal(job.config_hash, delivery.config_hash);
    assert.ok(executable(store, job, []));
});

test("a new overlapping route vetoes already queued delivery and extraction until configuration is repaired", context => {
    const { store, snapshot, delivery, extraction } = fixture(context);
    store.installConfig({ ...snapshot, routes: [...snapshot.routes, { ...snapshot.routes[0], routeId: "overlap", targetChannelId: "9" }] });
    assert.equal(executable(store, delivery, []), undefined);
    assert.equal(executable(store, extraction, []), undefined);
    store.installConfig(snapshot);
    assert.ok(executable(store, delivery, []));
    assert.ok(executable(store, extraction, []));
});

test("current route removal, disabling and source selector changes veto pinned work", context => {
    const { store, snapshot, delivery, extraction } = fixture(context);
    const route = snapshot.routes[0];
    const cases: Array<[string, Snapshot["routes"]]> = [
        ["removed", []],
        ["disabled", [{ ...route, enabled: false }]],
        ["server changed", [{ ...route, serverId: "20" }]],
        ["channel changed", [{ ...route, channelId: "30" }]],
        ["sender changed", [{ ...route, senderId: "40" }]],
    ];
    for (const [name, routes] of cases) {
        store.installConfig({ ...snapshot, routes, signal: { ...snapshot.signal, routes: [] } });
        assert.equal(executable(store, delivery, []), undefined, name);
        assert.equal(executable(store, extraction, []), undefined, name);
    }
});

test("current global and route Signal switches veto extraction and Signal delivery only", context => {
    const { store, snapshot, delivery, extraction } = fixture(context);
    const cases: Array<[string, Snapshot["signal"]]> = [
        ["global disabled", { ...snapshot.signal, enabled: false }],
        ["route disabled", { ...snapshot.signal, routes: [{ ...snapshot.signal.routes[0], enabled: false }] }],
        ["route no longer selected", { ...snapshot.signal, routes: [], routeIds: [] }],
    ];
    for (const [name, signal] of cases) {
        store.installConfig({ ...snapshot, signal });
        assert.equal(executable(store, extraction, []), undefined, name);
        assert.equal(executable(store, { ...extraction, kind: "signal", target: "6" }, []), undefined, name);
        assert.ok(executable(store, delivery, []), name);
    }
});

test("current pause, exclusions and source-account safety still veto pinned work", context => {
    const { store, event, delivery } = fixture(context);
    store.setMetadata("paused", "true");
    assert.equal(executable(store, delivery, []), undefined);
    store.setMetadata("paused", "false");
    assert.ok(executable(store, delivery, []));
    assert.equal(executable(store, delivery, [event.serverId]), undefined);
    assert.ok(executable(store, delivery, ["99"]));
    for (const unsafe of [{ ...event, accountId: "4" }, { ...event, excludedServerIds: [event.serverId] }]) {
        store.db.prepare("UPDATE messages SET envelope=? WHERE message_key=?").run(JSON.stringify(unsafe), delivery.message_key);
        assert.equal(executable(store, delivery, []), undefined);
    }
});

test("known outputs and ambiguous sender identities cannot execute pinned jobs", context => {
    const { store, event, delivery } = fixture(context);
    store.db.prepare("INSERT INTO sender_history VALUES(?,?,?,?,?)").run("bot:4", event.channelId, "", event.serverId, Date.now());
    assert.equal(executable(store, delivery, []), undefined);
    store.db.prepare("DELETE FROM sender_history").run();
    assert.ok(executable(store, delivery, []));
    store.db.prepare("INSERT INTO sink_deliveries VALUES(?,?,?,?,?,?,?,?,?)")
        .run("output", delivery.id, "bot:4", event.channelId, "nonce", "sent", event.message.id, Date.now(), Date.now());
    assert.equal(executable(store, delivery, []), undefined);
});

test("absent, missing and corrupt pins fail closed despite a valid active configuration", context => {
    const { store, snapshot, delivery } = fixture(context);
    store.installConfig({ ...snapshot, signal: { ...snapshot.signal, model: "current-model" } });
    for (const config_hash of [undefined, null, "", "missing-snapshot"]) {
        assert.equal(executable(store, { ...delivery, config_hash }, []), undefined);
    }
    store.db.prepare("UPDATE config_snapshots SET body=? WHERE hash=?").run("{broken", delivery.config_hash);
    assert.ok(store.config());
    assert.equal(executable(store, delivery, []), undefined);
});

test("extraction retries retain pinned model, endpoint, replacements, whitelist and delivery configuration", { timeout: 5000 }, async context => {
    const requests: Array<{ path: string | undefined; body: any; }> = [];
    const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        requests.push({ path: request.url, body: JSON.parse(body) });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            kind: "signal", reason: "New entry", signals: [{ kind: "equity_entry", ticker: "AAPL", side: "long", entryPrice: 100 }],
        }) } }] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    context.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const snapshot = configuration();
    snapshot.signal.providerBaseUrl = `http://127.0.0.1:${address.port}/pinned/v1`;
    const { store, extraction } = fixture(context, snapshot);
    store.installConfig({
        ...snapshot,
        routes: [{ ...snapshot.routes[0], name: "Changed route", replacements: [{ find: "hello", replaceWith: "changed entry", caseSensitive: false }] }],
        signal: {
            ...snapshot.signal, model: "changed-model", timeoutMs: 2000, providerBaseUrl: `http://127.0.0.1:${address.port}/changed/v1`,
            targetChannelId: "8", indexTargetChannelId: "9",
            routes: [{ ...snapshot.signal.routes[0], tickerWhitelist: ["MSFT"] }],
        },
    });
    const execution = executable(store, extraction, []);
    assert.ok(execution);
    assert.equal(execution.config.snapshot.signal.timeoutMs, 1000);
    await runExtraction(store, extraction, "test-key", []);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/pinned/v1/chat/completions");
    assert.equal(requests[0].body.model, "pinned-model");
    const input = requests[0].body.messages.map((message: any) => message.content).join("\n");
    assert.match(input, /pinned entry/);
    assert.doesNotMatch(input, /changed entry/);
    const signals = store.db.prepare("SELECT * FROM jobs WHERE kind='signal'").all() as any[];
    assert.equal(signals.length, 1);
    assert.equal(signals[0].target, "6");
    assert.equal(signals[0].config_hash, extraction.config_hash);
    assert.match(JSON.parse(signals[0].body).content, /Pinned route/);
    assert.equal((store.db.prepare("SELECT state FROM jobs WHERE id=?").get(extraction.id) as any).state, "done");
});
