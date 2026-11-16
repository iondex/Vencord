import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CaptureEnvelope, validateCapture, validateServiceUrl } from "../contracts/ingest.js";
import { flushAlerts } from "../src/alerts.js";
import { adaptRouteWire, createConfigSync, digest, Snapshot, validateSnapshot } from "../src/config.js";
import { createDiscordSender } from "../src/discord.js";
import { createHubHttp } from "../src/http.js";
import { planMessages } from "../src/queue.js";
import { evaluateText, renderMessage } from "../src/routing.js";
import { runExtraction } from "../src/signal.js";
import { openStore } from "../src/storage.js";

function capture(id = "100", changes: Partial<CaptureEnvelope> = {}): CaptureEnvelope {
    return {
        schemaVersion: 2, eventId: `test:${id}`, eventType: "MESSAGE_CREATE", capturedAt: new Date().toISOString(),
        accountId: "1", serverId: "2", channelId: "3", excludedServerIds: [],
        message: { id, channel_id: "3", guild_id: "2", author: { id: "4", bot: true }, content: "hello", type: 0 }, ...changes,
    };
}

function configuration(): Snapshot {
    return validateSnapshot({
        routes: [{ routeId: "route", name: "Test", enabled: true, serverId: "2", channelId: "3", targetChannelId: "5" }],
        signal: { enabled: false, model: "test-model" }, profiles: [],
    });
}

function fixture(context: any) {
    const directory = mkdtempSync(join(tmpdir(), "signal-hub-test-"));
    const store = openStore(join(directory, "hub.sqlite3"));
    context.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    return store;
}

function ingest(store: ReturnType<typeof openStore>, event: CaptureEnvelope) { return store.ingest(event, JSON.stringify(event)); }
function rows(store: ReturnType<typeof openStore>, table: string) { return store.db.prepare(`SELECT * FROM ${table}`).all() as any[]; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }

test("durable receipts, cross-account canonical deduplication and conflicting events", context => {
    const store = fixture(context);
    const event = capture();
    assert.equal(ingest(store, event).durable, true);
    assert.equal(ingest(store, event).duplicate, true);
    ingest(store, { ...event, accountId: "99", eventId: "other-account" });
    assert.equal(rows(store, "receipts").length, 2);
    assert.equal(rows(store, "messages").length, 1);
    assert.throws(() => ingest(store, { ...event, message: { ...event.message, content: "changed" } }), /event_id_conflict/);
    assert.equal(rows(store, "receipts").length, 2);
});

test("raw archive precedes configuration, routing, self filtering and unknown message types", context => {
    const store = fixture(context);
    ingest(store, capture());
    planMessages(store, []);
    assert.equal(rows(store, "messages")[0].state, "waiting_config");
    store.installConfig(configuration());
    planMessages(store, []);
    assert.equal(rows(store, "jobs").length, 1);
    ingest(store, capture("101", { message: { id: "101", type: 9999, author: { id: "4" } } }));
    ingest(store, capture("102", { message: { id: "102", author: { id: "1" }, content: "self" } }));
    planMessages(store, []);
    assert.equal(rows(store, "receipts").length, 3);
    assert.equal(rows(store, "messages").find(row => row.message_key.endsWith(":101")).state, "archived_unsupported");
    assert.equal(rows(store, "messages").find(row => row.message_key.endsWith(":102")).state, "filtered_self");
    assert.equal(rows(store, "jobs").length, 1);
});

test("empty exclusions are valid; cycles including Signal and cross-server routes are rejected", () => {
    const config = configuration();
    assert.doesNotThrow(() => validateSnapshot(config));
    assert.throws(() => validateSnapshot({ ...config, routes: [{ ...config.routes[0], targetChannelId: "3" }] }), /unsafe_route_cycle/);
    assert.throws(() => validateSnapshot({ ...config, routes: [...config.routes, { ...config.routes[0], routeId: "reverse", serverId: "99", channelId: "5", targetChannelId: "3" }] }), /unsafe_route_cycle/);
    assert.throws(() => validateSnapshot({ ...config, signal: { ...config.signal, enabled: true, routeIds: ["route"], targetChannelId: "3" } }), /unsafe_route_cycle/);
});

test("X links require a matching source route and keep text or embed-only URLs through delivery", async context => {
    const store = fixture(context);
    const config = configuration();
    store.installConfig(config);
    const decisions: string[] = [];
    const logDecision = (_event: string, fields: any) => decisions.push(fields.state);
    ingest(store, capture("100", { channelId: "99", message: { id: "100", author: { id: "4" }, content: "https://x.com/example/status/123" } }));
    planMessages(store, [], 100, logDecision);
    assert.equal(rows(store, "messages")[0].state, "no_matching_route");
    assert.equal(rows(store, "jobs").length, 0);
    assert.equal(rows(store, "route_receipts").length, 0);
    const urls = ["https://x.com/example/status/124", "https://twitter.com/example/status/125", "https://x.com/example/status/126"];
    const messages = [
        { content: urls[0] },
        { content: null, embeds: [{ url: urls[1], title: "Embed only" }] },
        { content: "", embeds: [{ url: urls[2], description: "Link preview" }] },
    ];
    for (const [index, message] of messages.entries()) {
        const id = String(101 + index);
        ingest(store, capture(id, { message: { id, type: 0, author: { id: "4" }, ...message } }));
    }
    planMessages(store, [], 100, logDecision);
    planMessages(store, [], 100, logDecision);
    assert.deepEqual(decisions, ["no_matching_route", "routed", "routed", "routed"]);
    const posted: any[] = [];
    const sender = createDiscordSender(store, { botToken: "test-token" }, [], (async (input: any, init?: RequestInit) => {
        if (String(input).endsWith("/users/@me")) return json({ id: "8", bot: true });
        if (String(input).endsWith("/channels/5")) return json({ id: "5", guild_id: "2" });
        if (init?.method === "POST") {
            posted.push(JSON.parse(String(init.body)));
            return json({ id: String(200 + posted.length), channel_id: "5" });
        }
        throw new Error("unexpected test request");
    }) as typeof fetch);
    for (let index = 0; index < urls.length; index++) {
        await sender.send(store.claim("deliver"));
        assert.deepEqual(posted.at(-1).allowed_mentions, { parse: [] });
    }
    for (const url of urls) assert.ok(posted.some(body => body.content.includes(url) || body.embeds?.some((embed: any) => embed.url === url)));
    assert.ok(rows(store, "jobs").every(job => job.state === "sent"));
    assert.equal(rows(store, "route_receipts").length, 3);
});

test("channel profiles use the configured webhook identity and preserve rich news embeds", async context => {
    const store = fixture(context);
    const config = configuration();
    config.profiles = [{ targetChannelId: "5", displayName: "富途资讯", avatarUrl: "https://cdn.test/futu.png" }];
    store.installConfig(config);
    ingest(store, capture("100", { message: { id: "100", content: "", author: { id: "4" }, embeds: [{ title: "新闻", description: "正文", color: 5763719 }] } }));
    planMessages(store, []);
    const sent: any[] = [];
    const sender = createDiscordSender(store, { botToken: "test", webhooks: { "5": "https://discord.com/api/webhooks/10/test-token" } }, [], (async (input: any, init?: RequestInit) => {
        if (init?.method === "POST") { sent.push(JSON.parse(String(init.body))); return json({ id: "200", channel_id: "5" }); }
        if (String(input).includes("/webhooks/10/")) return json({ id: "10", channel_id: "5" });
        if (String(input).endsWith("/channels/5")) return json({ id: "5", guild_id: "2" });
        throw new Error("unexpected request");
    }) as typeof fetch);
    await sender.send(store.claim("deliver"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].username, "富途资讯");
    assert.equal(sent[0].avatar_url, "https://cdn.test/futu.png");
    assert.equal(sent[0].content, "");
    assert.deepEqual(sent[0].embeds, [{ title: "新闻", description: "正文", color: 5763719 }]);
    assert.equal(rows(store, "sender_history")[0].identity, "webhook:10");
});

test("a configured channel identity never silently falls back to the bot account", async context => {
    const store = fixture(context);
    const config = configuration();
    config.profiles = [{ targetChannelId: "5", displayName: "富途资讯", avatarUrl: "" }];
    store.installConfig(config);
    ingest(store, capture()); planMessages(store, []);
    let calls = 0;
    const sender = createDiscordSender(store, { botToken: "test" }, [], (async () => { calls++; throw new Error("unexpected request"); }) as typeof fetch);
    await sender.send(store.claim("deliver"));
    assert.equal(calls, 0);
    assert.equal(rows(store, "jobs")[0].error, "missing_discord_webhook");
});

test("own outputs cannot generate jobs before ACK, after ACK, after restart or during replay", async context => {
    const store = fixture(context);
    store.installConfig(configuration());
    ingest(store, capture());
    planMessages(store, []);
    let observedBeforeSendAck = false;
    const fetcher = (async (input: any, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/users/@me")) return json({ id: "8", bot: true });
        if (url.endsWith("/channels/5")) return json({ id: "5", guild_id: "2", type: 0 });
        if (init?.method === "POST") {
            const request = JSON.parse(String(init.body));
            const loop = capture("200", { channelId: "5", message: { id: "200", channel_id: "5", guild_id: "2", author: { id: "8", bot: true }, nonce: request.nonce, content: request.content } });
            const active = store.config()!.snapshot;
            active.routes.push({ ...active.routes[0], routeId: "unexpected-new-source", channelId: "5", targetChannelId: "6" });
            store.installConfig(active);
            ingest(store, loop);
            planMessages(store, []);
            assert.equal(rows(store, "messages").find(row => row.message_key.endsWith(":200")).state, "self_generated");
            assert.equal(rows(store, "jobs").length, 1);
            observedBeforeSendAck = true;
            return json({ id: "200", channel_id: "5" });
        }
        throw new Error("unexpected HTTP call");
    }) as typeof fetch;
    const sent: any[] = [];
    const sender = createDiscordSender(store, { botToken: "test-token" }, [], fetcher, (event, fields) => {
        assert.equal(rows(store, "jobs")[0].state, "sent", "Success is logged only after the delivery is committed");
        sent.push({ event, ...fields });
    });
    await sender.send(store.claim("deliver"));
    assert.equal(observedBeforeSendAck, true);
    assert.equal(rows(store, "sink_deliveries")[0].state, "sent");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].event, "delivery_sent");
    assert.equal(sent[0].routeId, "route");
    assert.equal(sent[0].messageId, "200");
    assert.equal(store.ownOutput(capture("200", { channelId: "5", message: { id: "200", author: { id: "8" } } })), "self_generated");
    const restartedSender = createDiscordSender(store, { botToken: "rotated-token" }, [], fetcher);
    void restartedSender;
    assert.equal(store.ownOutput(capture("201", { channelId: "5", message: { id: "201", author: { id: "8" }, content: "ambiguous" } })), "safety_pending");
    assert.equal(store.ownOutput(capture("202", { channelId: "3", message: { id: "202", author: { id: "8" }, content: "same shared bot elsewhere" } })), undefined);
    assert.equal(store.ownOutput(capture("203", { channelId: "5", message: { id: "203", author: { id: "9" }, webhook_id: "10" } })), undefined);
});

test("lost response is uncertain and never blindly resent; durable intent still guards loops", async context => {
    const store = fixture(context);
    store.installConfig(configuration()); ingest(store, capture()); planMessages(store, []);
    let sends = 0;
    const sender = createDiscordSender(store, { botToken: "test-token" }, [], (async (input: any, init?: RequestInit) => {
        if (String(input).endsWith("/users/@me")) return json({ id: "8", bot: true });
        if (String(input).endsWith("/channels/5")) return json({ id: "5", guild_id: "2" });
        if (init?.method === "POST") { sends++; throw new Error("connection reset after write"); }
        return json([]);
    }) as typeof fetch);
    await sender.send(store.claim("deliver"));
    assert.equal(rows(store, "jobs")[0].state, "uncertain");
    assert.equal(store.claim("deliver"), undefined);
    await sender.reconcile();
    assert.equal(sends, 1);
    assert.equal(store.ownOutput(capture("201", { channelId: "5", message: { id: "201", author: { id: "8" } } })), "safety_pending");
});

test("retrying a rejected webhook through a Bot updates intent identity and remains reconcilable", async context => {
    const store = fixture(context);
    store.installConfig(configuration()); ingest(store, capture()); planMessages(store, []);
    let botNonce = "";
    const fetcher = (async (input: any, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/users/@me")) return json({ id: "8", bot: true });
        if (url.endsWith("/channels/5")) return json({ id: "5", guild_id: "2" });
        if (url.includes("/webhooks/9/") && init?.method !== "POST") return json({ id: "9", channel_id: "5" });
        if (init?.method === "POST") {
            if (url.includes("/webhooks/")) return json({ message: "rejected" }, 403);
            botNonce = JSON.parse(String(init.body)).nonce;
            throw new Error("connection lost after Bot send");
        }
        if (url.includes("/messages?")) return json([{ id: "200", channel_id: "5", nonce: botNonce, author: { id: "8" } }]);
        throw new Error("unexpected test request");
    }) as typeof fetch;
    const events: any[] = [];
    const log = (event: string, fields: any) => events.push({ event, ...fields });
    const webhookSender = createDiscordSender(store, { botToken: "test", webhooks: { "5": "https://discord.com/api/webhooks/9/test-only" } }, [], fetcher, log);
    await webhookSender.send(store.claim("deliver"));
    assert.equal(rows(store, "sink_deliveries")[0].identity, "webhook:9");
    assert.equal(rows(store, "sink_deliveries")[0].state, "rejected");
    store.db.prepare("UPDATE jobs SET due_at=0 WHERE state='pending'").run();
    const botSender = createDiscordSender(store, { botToken: "test" }, [], fetcher, log);
    await botSender.send(store.claim("deliver"));
    assert.equal(rows(store, "sink_deliveries")[0].identity, "bot:8");
    assert.equal(rows(store, "jobs")[0].state, "uncertain");
    assert.deepEqual(rows(store, "sender_history").map(row => row.identity).sort(), ["bot:8", "webhook:9"]);
    assert.equal(events.length, 0, "Rejected and uncertain sends cannot report success");
    await botSender.reconcile();
    assert.equal(rows(store, "jobs")[0].state, "sent");
    assert.equal(rows(store, "sink_deliveries")[0].message_id, "200");
    assert.deepEqual(events, [{ event: "delivery_sent", jobId: rows(store, "jobs")[0].id, target: "5", messageId: "200", reconciled: true }]);
});

test("ready retries and periodic repairs run before subsequently admitted fresh work", context => {
    const store = fixture(context);
    store.installConfig(configuration()); ingest(store, capture()); planMessages(store, []);
    const first = store.claim("deliver");
    store.retryDelivery(first.id, "test rejection");
    store.db.prepare("UPDATE jobs SET due_at=? WHERE id=?").run(Date.now() - 1000, first.id);
    for (const id of ["101", "102", "103"]) ingest(store, capture(id));
    planMessages(store, []);
    assert.equal(store.claim("deliver").id, first.id);
    store.db.prepare("UPDATE jobs SET state='retry_wait',due_at=? WHERE id=?").run(Date.now() - 500, first.id);
    assert.equal(store.recoverDeliveries(), 1);
    assert.equal(store.claim("deliver").id, first.id);
});

test("lease recovery differentiates work before and during external send", context => {
    const store = fixture(context);
    store.installConfig(configuration()); ingest(store, capture()); planMessages(store, []);
    const job = store.claim("deliver");
    store.db.prepare("UPDATE jobs SET lease_until=0 WHERE id=?").run(job.id);
    store.recoverLeases();
    assert.equal(rows(store, "jobs")[0].state, "pending");
    store.db.prepare("UPDATE jobs SET state='sending',lease_until=0 WHERE id=?").run(job.id);
    store.recoverLeases();
    assert.equal(rows(store, "jobs")[0].state, "uncertain");
});

test("route removal, exclusion changes and unresolved identities veto old jobs before POST", async context => {
    const store = fixture(context);
    store.installConfig(configuration()); ingest(store, capture()); planMessages(store, []);
    const config = configuration(); config.routes = [];
    store.installConfig(config);
    let calls = 0;
    const sender = createDiscordSender(store, {}, [], (async () => { calls++; throw new Error(); }) as typeof fetch);
    await sender.send(store.claim("deliver"));
    assert.equal(calls, 0);
    assert.equal(rows(store, "jobs")[0].state, "held");
});

test("configuration sync checks all pages twice; failure preserves cache and forwarding", async context => {
    const store = fixture(context);
    store.installConfig(configuration());
    const initialHash = store.config()!.hash;
    const reports: string[] = [];
    const fail = createConfigSync("https://config.test", undefined, snapshot => store.installConfig(snapshot), code => reports.push(code), (async () => json({}, 503)) as typeof fetch);
    await fail();
    assert.equal(store.config()!.hash, initialHash);
    assert.deepEqual(reports, ["config_sync_failed_using_cache"]);
    ingest(store, capture()); planMessages(store, []);
    assert.equal(rows(store, "jobs").length, 1);
    let routeCalls = 0;
    const emptySync = createConfigSync("https://config.test", undefined, snapshot => store.installConfig(snapshot), () => {}, (async (input: any) => {
        const url = new URL(input);
        if (url.pathname === "/routes") { routeCalls++; return json({ routes: [], total: 0, page: 1 }); }
        if (url.pathname.endsWith("signal-config")) return json({ enabled: false });
        return json({ profiles: [] });
    }) as typeof fetch);
    await Promise.all([emptySync(), emptySync()]);
    assert.equal(routeCalls, 2);
    assert.equal(store.config()!.snapshot.routes.length, 0);
});

test("paginated CF routes are completely fetched and candidate failure leaves the prior snapshot intact", async context => {
    const store = fixture(context);
    store.installConfig(configuration());
    const previous = store.config()!.hash;
    const pages: number[] = [];
    let failSecondPage = false;
    const route = configuration().routes[0];
    const sync = createConfigSync("https://config.test", undefined, snapshot => store.installConfig(snapshot), () => {}, (async (input: any) => {
        const url = new URL(input);
        if (url.pathname === "/routes") {
            const page = Number(url.searchParams.get("page"));
            pages.push(page);
            if (page === 2 && failSecondPage) return json({}, 503);
            return json({ page, total: 2, routes: [page === 1 ? route : { ...route, routeId: "second", channelId: "7", targetChannelId: "8" }] });
        }
        if (url.pathname.endsWith("signal-config")) return json({ enabled: false });
        return json({ profiles: [] });
    }) as typeof fetch);
    failSecondPage = true;
    await sync();
    assert.equal(store.config()!.hash, previous);
    pages.length = 0;
    failSecondPage = false;
    await sync();
    assert.deepEqual(pages, [1, 2, 1, 2]);
    assert.equal(store.config()!.snapshot.routes.length, 2);
});

test("content, nullable embeds, media, polls, components and long Unicode render within Discord limits", () => {
    const route = configuration().routes[0];
    const messages = [
        { content: null, embeds: [{ description: "embed only", image: { url: "https://cdn.test/image.png" } }] },
        { attachments: [{ url: "https://cdn.test/audio.ogg", content_type: "audio/ogg" }] },
        { sticker_items: [{ id: "55", name: "Sticker" }] },
        { poll: { question: { text: "Question?" }, answers: [{ poll_media: { text: "Answer" } }] } },
        { components: [{ type: 17, components: [{ content: "components v2" }] }] },
        { content: "😀".repeat(3000) },
    ];
    for (const message of messages) {
        const rendering = renderMessage(capture("100", { message: { id: "100", ...message } }), route);
        assert.equal(rendering.reason, "routed");
        assert.ok(rendering.parts.length);
        for (const part of rendering.parts) { assert.ok(part.content.length <= 2000); assert.deepEqual(part.allowed_mentions.parse, []); }
    }
    assert.equal(renderMessage(capture("100", { message: { id: "100", flags: 64, content: "ephemeral" } }), route).reason, "archived_unsupported");
});

test("CF wire snake_case policies retain filtering and image suppression", () => {
    const config = configuration();
    const route = adaptRouteWire({ ...config.routes[0], filters: undefined, filterChinese: undefined, forwardImages: undefined,
        filter_keywords: ["blocked"], filter_chinese: true, forward_images: false });
    const adapted = validateSnapshot({ ...config, routes: [route] }).routes[0];
    assert.deepEqual(adapted.filters, ["blocked"]);
    assert.equal(adapted.filterChinese, true);
    assert.equal(adapted.forwardImages, false);
    assert.equal(renderMessage(capture("100", { message: { id: "100", content: "blocked" } }), adapted).reason, "keyword_blocked");
});

test("successful extraction is reused without a key when generating durable delivery jobs", async context => {
    const store = fixture(context);
    const config = configuration();
    config.signal = { ...config.signal, enabled: true, routeIds: ["route"], targetChannelId: "6" };
    store.installConfig(config); ingest(store, capture()); planMessages(store, []);
    const job = store.claim("extract");
    store.db.prepare("INSERT INTO extractions VALUES(?,?,?,?)").run(job.message_key, "route", JSON.stringify({ kind: "signal", signals: [{ kind: "equity_entry", ticker: "AAPL" }] }), Date.now());
    await runExtraction(store, job, undefined, []);
    assert.equal(rows(store, "jobs").find(row => row.kind === "extract").state, "done");
    assert.equal(rows(store, "jobs").filter(row => row.kind === "signal").length, 1);
});

test("route replacements and reply labels are shared by forwarding and bounded model input", () => {
    const route = configuration().routes[0];
    route.replacements = [{ find: "alias", replaceWith: "SPY", caseSensitive: false }];
    const message = { id: "100", content: "New ALIAS entry", embeds: [{ rawDescription: "Alias entry details" }], referenced_message: { content: "alias old entry" } };
    const evaluated = evaluateText(message, route);
    assert.equal(evaluated.reason, "routed");
    assert.equal(evaluated.text, "New SPY entry\nSPY entry details");
    assert.match(evaluated.signalContent, /\[MAIN\]\nNew SPY entry/);
    assert.match(evaluated.signalContent, /\n\n\[REPLY CONTEXT MAIN\]\nSPY old entry/);
    assert.ok(!evaluated.signalContent.toLowerCase().includes("alias"));
    assert.equal(message.content, "New ALIAS entry");
    route.filters = ["old entry"];
    assert.equal(evaluateText(message, route).reason, "keyword_blocked");
    route.filters = [];
    route.filterChinese = true;
    route.replacements = [{ find: "alias", replaceWith: "中文", caseSensitive: false }];
    assert.equal(evaluateText(message, route).reason, "chinese_blocked");
    route.filterChinese = false;
    assert.ok(evaluateText({ content: "x".repeat(20_000) }, route).signalContent.length <= 12_000);
});

test("CF-compatible underlying whitelist keeps primary delivery and adds the index copy", async context => {
    const store = fixture(context);
    const config = configuration();
    config.signal = { ...config.signal, enabled: true, targetChannelId: "6", indexTargetChannelId: "7",
        routes: [{ routeId: "route", enabled: true, tickerWhitelistEnabled: true, tickerWhitelist: [" $spy "] }] };
    store.installConfig(config); ingest(store, capture()); planMessages(store, []);
    const job = store.claim("extract");
    store.db.prepare("INSERT INTO extractions VALUES(?,?,?,?)").run(job.message_key, "route", JSON.stringify({ kind: "signal", signals: [
        { kind: "option_entry", ticker: "SPY261115C00600000", underlyingTicker: "SPY", expiration: "2026-11-15", strike: 600, side: "call" },
        { kind: "equity_entry", ticker: "AAPL", side: "long" },
    ] }), Date.now());
    await runExtraction(store, job, undefined, []);
    const deliveries = rows(store, "jobs").filter(row => row.kind === "signal");
    assert.deepEqual(deliveries.map(row => row.target).sort(), ["6", "7"]);
    assert.equal(deliveries[0].body, deliveries[1].body);
    const body = JSON.parse(deliveries[0].body);
    assert.match(body.content, /SPY261115C00600000/);
    assert.ok(!body.content.includes("AAPL"));
    assert.deepEqual(body.allowed_mentions.parse, []);
});

test("reconciliation rotates unresolved Bot records and skips unmatchable webhooks", async context => {
    const store = fixture(context);
    const insert = store.db.prepare("INSERT INTO sink_deliveries VALUES(?,?,?,?,?,'uncertain','',?,?)");
    for (let index = 0; index < 51; index++) {
        const key = String(index).padStart(3, "0");
        insert.run(key, `job:${key}`, "bot:8", "5", `nonce:${key}`, Date.now(), Date.now());
    }
    insert.run("webhook", "webhook-job", "webhook:9", "10", "unknown", Date.now(), Date.now());
    let calls = 0;
    const sender = createDiscordSender(store, { botToken: "test" }, [], (async () => {
        calls++;
        return json([{ id: "900", channel_id: "5", nonce: "nonce:050", author: { id: "8" } }]);
    }) as typeof fetch);
    await sender.reconcile();
    assert.equal(calls, 50);
    await sender.reconcile();
    assert.equal(calls, 51);
    assert.equal((store.db.prepare("SELECT state FROM sink_deliveries WHERE delivery_key='050'").get() as any).state, "sent");
    assert.equal((store.db.prepare("SELECT state FROM sink_deliveries WHERE delivery_key='webhook'").get() as any).state, "uncertain");
});

test("five exponential retries persist every attempt before periodic repair schedules delivery again", async context => {
    const store = fixture(context);
    store.installConfig(configuration()); ingest(store, capture()); planMessages(store, []);
    let sends = 0;
    const sender = createDiscordSender(store, { botToken: "test" }, [], (async (input: any, init?: RequestInit) => {
        if (String(input).endsWith("/users/@me")) return json({ id: "8", bot: true });
        if (String(input).endsWith("/channels/5")) return json({ id: "5", guild_id: "2" });
        assert.equal(init?.method, "POST");
        sends++;
        return sends <= 6 ? json({ retry_after: 0.1 }, 429) : json({ id: "900", channel_id: "5" });
    }) as typeof fetch);
    for (let attempt = 0; attempt < 6; attempt++) {
        const job = store.claim("deliver");
        assert.ok(job);
        const before = Date.now();
        await sender.send(job);
        const saved = rows(store, "jobs")[0];
        assert.equal(saved.retry_count, attempt + 1);
        assert.equal(saved.state, attempt < 5 ? "pending" : "retry_wait");
        assert.ok(saved.due_at >= before + (attempt < 5 ? 1000 * 2 ** attempt : 300_000));
        assert.equal(store.claim("deliver"), undefined);
        if (attempt < 5) store.db.prepare("UPDATE jobs SET due_at=0").run();
        store.setMetadata("discord_rate_limit:5", "0");
    }
    assert.equal(sends, 6);
    assert.equal(rows(store, "delivery_attempts").length, 6);
    assert.ok(rows(store, "delivery_attempts").every(row => row.status === 429 && row.outcome === "rejected"));
    assert.equal(store.recoverDeliveries(), 0);
    store.db.prepare("UPDATE jobs SET due_at=0").run();
    assert.equal(store.recoverDeliveries(), 1);
    assert.equal(rows(store, "jobs")[0].recovery_cycles, 1);
    assert.equal(rows(store, "jobs")[0].retry_count, 0);
    await sender.send(store.claim("deliver"));
    assert.equal(rows(store, "jobs")[0].state, "sent");
    assert.equal(rows(store, "delivery_attempts").length, 7);
    assert.equal((store.deliveries()[0] as any).message_id, "900");
});

test("all matching routes have an audit record including policy skips and conflicts", context => {
    const store = fixture(context);
    const config = configuration();
    config.routes[0].filters = ["blocked"];
    store.installConfig(config);
    ingest(store, capture("100", { message: { id: "100", content: "blocked" } }));
    planMessages(store, []);
    assert.equal(rows(store, "route_receipts")[0].decision, "keyword_blocked");
    assert.equal(rows(store, "jobs").length, 0);
    config.routes.push({ ...config.routes[0], routeId: "other", targetChannelId: "6" });
    store.installConfig(config);
    ingest(store, capture("101")); planMessages(store, []);
    assert.equal(rows(store, "route_receipts").filter(row => row.decision === "route_conflict").length, 2);
    assert.equal(rows(store, "jobs").length, 0);
    assert.equal(store.deliveries().length, 3);
    config.routes.pop();
    store.installConfig(config);
    planMessages(store, []);
    assert.equal(rows(store, "messages").find(row => row.message_key.endsWith(":101")).state, "routed");
    assert.equal(rows(store, "jobs").length, 1);
});

test("authenticated ingestion ACKs exact persisted hash; malformed and invalid input get distinct diagnostics", async context => {
    const store = fixture(context);
    const server = createHubHttp(store, { pairingToken: "pair", adminToken: "admin", maxBodyBytes: 4096 });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    context.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const raw = JSON.stringify(capture());
    assert.equal((await fetch(`${base}/forward`, { method: "POST", body: raw })).status, 401);
    const post = (body: string) => fetch(`${base}/forward`, { method: "POST", headers: { Authorization: "Bearer pair" }, body });
    const response = await post(raw);
    assert.equal(response.status, 202);
    assert.equal((await response.json()).hash, digest(raw));
    store.installConfig(configuration()); planMessages(store, []);
    assert.equal((await fetch(`${base}/api/deliveries`, { headers: { Authorization: "Bearer pair" } })).status, 401);
    const audit = await (await fetch(`${base}/api/deliveries`, { headers: { Authorization: "Bearer admin" } })).json();
    assert.equal(audit.deliveries.length, 1);
    assert.equal(audit.deliveries[0].state, "pending");
    assert.equal(audit.deliveries[0].body, undefined);
    const attempts = await (await fetch(`${base}/api/deliveries?jobId=${audit.deliveries[0].job_id}`, { headers: { Authorization: "Bearer admin" } })).json();
    assert.deepEqual(attempts.attempts, []);
    assert.equal((await fetch(`${base}/api/deliveries?jobId=invalid`, { headers: { Authorization: "Bearer admin" } })).status, 400);
    const trace = await (await fetch(`${base}/api/deliveries?messageKey=discord:2:3:100`, { headers: { Authorization: "Bearer admin" } })).json();
    assert.equal(trace.message.state, "routed");
    assert.equal(trace.receipts.length, 1);
    assert.equal(trace.deliveries[0].job_id, audit.deliveries[0].job_id);
    assert.equal(JSON.stringify(trace).includes("hello"), false);
    assert.equal((await fetch(`${base}/api/deliveries?messageKey=invalid`, { headers: { Authorization: "Bearer admin" } })).status, 400);
    assert.equal((await post("{")).status, 400);
    assert.equal((await post("{}")).status, 422);
    assert.equal((await post("x".repeat(5000))).status, 413);
    assert.equal(rows(store, "quarantine").length, 3);
    const status = await (await fetch(`${base}/api/status`, { headers: { Authorization: "Bearer admin" } })).json();
    assert.equal(status.quarantined.reduce((total: number, row: any) => total + row.total, 0), 3);
    assert.equal(status.backlog.jobs[0].state, "pending");
    assert.ok(status.backlog.jobs[0].oldestAt <= status.observedAt);
    assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: "Bearer pair" } })).status, 401);
});

for (const tokens of [{ pairingToken: "", adminToken: "" }, { pairingToken: "pair", adminToken: "" }, { pairingToken: "", adminToken: "admin" }, { pairingToken: "pair", adminToken: "admin" }]) {
    test(`HTTP authentication is optional per endpoint: ingestion ${tokens.pairingToken ? "protected" : "open"}, admin ${tokens.adminToken ? "protected" : "open"}`, async context => {
        const store = fixture(context);
        const server = createHubHttp(store, tokens);
        server.listen(0, "127.0.0.1"); await once(server, "listening");
        context.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
        const base = `http://127.0.0.1:${(server.address() as any).port}`;
        const body = JSON.stringify(capture());
        assert.equal((await fetch(`${base}/forward`, { method: "POST", body })).status, tokens.pairingToken ? 401 : 202);
        assert.equal((await fetch(`${base}/forward`, { method: "POST", body, headers: { Authorization: "Bearer wrong" } })).status, tokens.pairingToken ? 401 : 202);
        const headers = tokens.pairingToken ? { Authorization: `Bearer ${tokens.pairingToken}` } : undefined;
        const response = await fetch(`${base}/forward`, { method: "POST", body, headers });
        assert.equal(response.status, 202);
        assert.equal((await response.json()).hash, digest(body));
        for (const path of ["/api/status", "/api/deliveries", "/api/pause", "/api/resume"]) {
            const method = ["/api/pause", "/api/resume"].includes(path) ? "POST" : "GET";
            assert.equal((await fetch(`${base}${path}`, { method })).status, tokens.adminToken ? 401 : 200);
            assert.equal((await fetch(`${base}${path}`, { method, headers: { Authorization: "Bearer wrong" } })).status, tokens.adminToken ? 401 : 200);
            assert.equal((await fetch(`${base}${path}`, { method, headers: tokens.adminToken ? { Authorization: `Bearer ${tokens.adminToken}` } : undefined })).status, 200);
        }
        assert.equal((await fetch(`${base}/forward`, { method: "POST", body, headers: { ...headers, Origin: "https://browser.test" } })).status, 403);
        assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${tokens.adminToken}`, Origin: "https://browser.test" } })).status, 403);
    });
}

test("DingTalk application errors remain queued even with HTTP 200", async context => {
    const store = fixture(context);
    store.alert("test_fault", "Fault");
    const now = Date.now() + 1000;
    await flushAlerts(store, "https://alert.test", (async () => json({ errcode: 310000 })) as typeof fetch, now);
    assert.equal(rows(store, "alerts")[0].sent_at, 0);
    await flushAlerts(store, "https://alert.test", (async () => json({ errcode: 0 })) as typeof fetch, now + 30_000);
    assert.ok(rows(store, "alerts")[0].sent_at > 0);
});

test("LAN URLs and nullable raw fields are accepted without allowing credentials in URLs", () => {
    assert.equal(validateServiceUrl("http://192.168.1.50:49321/forward").hostname, "192.168.1.50");
    assert.equal(validateServiceUrl("https://hub.lan/forward").protocol, "https:");
    assert.throws(() => validateServiceUrl("file:///tmp/hub"));
    assert.throws(() => validateServiceUrl("http://token:secret@hub.lan/forward"));
    assert.equal(validateCapture(capture("100", { message: { id: "100", content: null, arbitraryNewField: {} } })), true);
    assert.equal(validateCapture(capture("100", { message: { id: 9007199254740994 } })), false);
});
