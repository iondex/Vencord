/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import {
    buildChannelDirectory,
    ChannelBatchQueue,
    collectCachedMessages,
    createApiUrl,
    createChannelMetadata,
    createMessageLogRecord,
    FLUSH_INTERVAL_MS,
    MAX_BATCH_RECORDS,
    parseEnabledChannels,
    serializeEnabledChannels,
    TARGET_BATCH_BYTES,
    validateHealthResult,
    validateLogResult,
} from "./logic";

interface ScheduledTimer {
    callback: () => void;
    delay: number;
}

function createScheduler() {
    const timers: ScheduledTimer[] = [];

    return {
        timers,
        setTimer(callback: () => void, delay: number) {
            const timer = { callback, delay };
            timers.push(timer);
            return timer;
        },
        clearTimer(timer: unknown) {
            const index = timers.indexOf(timer as ScheduledTimer);
            if (index !== -1) timers.splice(index, 1);
        },
        runNext() {
            const timer = timers.shift();
            assert(timer, "expected a scheduled timer");
            timer.callback();
            return timer.delay;
        }
    };
}

function record(id: string, content = "message") {
    return createMessageLogRecord({
        id,
        channel_id: "10",
        content,
        timestamp: "2026-07-31T12:00:00.000Z",
        toJS() {
            return {
                id,
                channel_id: "10",
                content,
                timestamp: "2026-07-31T12:00:00.000Z",
            };
        }
    }, "2026-07-31T13:00:00.000Z", {
        eventType: "cache",
        payloadKind: "snapshot",
        payloadSource: "message-store",
    })!;
}

assert.deepEqual(record("100"), {
    type: "message",
    messageId: "100",
    observedAt: "2026-07-31T13:00:00.000Z",
    eventType: "cache",
    payloadKind: "snapshot",
    payloadSource: "message-store",
    payload: {
        id: "100",
        channel_id: "10",
        content: "message",
        timestamp: "2026-07-31T12:00:00.000Z",
    }
});
assert.deepEqual(createMessageLogRecord({
    id: "100",
    channel_id: "10",
    content: "edited",
    edited_timestamp: "2026-07-31T13:00:00.000Z",
}, "2026-07-31T13:00:01.000Z", {
    eventType: "update",
    payloadKind: "patch",
    payloadSource: "flux-event",
}), {
    type: "message",
    messageId: "100",
    observedAt: "2026-07-31T13:00:01.000Z",
    eventType: "update",
    payloadKind: "patch",
    payloadSource: "flux-event",
    payload: {
        id: "100",
        channel_id: "10",
        content: "edited",
        edited_timestamp: "2026-07-31T13:00:00.000Z",
    },
});
assert.equal(createMessageLogRecord(
    { id: "pending", channel_id: "10", state: "SENDING" },
    "now",
    { eventType: "create", payloadKind: "snapshot", payloadSource: "flux-event" },
), null);
assert.equal(createMessageLogRecord({
    id: "broken",
    channel_id: "10",
    toJS() {
        throw new Error("broken record");
    }
}, "2026-07-31T13:00:00.000Z", {
    eventType: "cache",
    payloadKind: "snapshot",
    payloadSource: "message-store",
}), null);

assert.equal(createApiUrl("http://127.0.0.1:49322", "/api/health"), "http://127.0.0.1:49322/api/health");
assert.equal(createApiUrl("http://localhost:5000/", "/api/channels/10/status"), "http://localhost:5000/api/channels/10/status");
assert.equal(createApiUrl("https://example.com", "/api/health"), null);
assert.equal(createApiUrl("http://192.168.1.2:49322", "/api/health"), null);
assert.equal(createApiUrl("http://127.0.0.1:49322", "/api/channels/status"), "http://127.0.0.1:49322/api/channels/status");

assert.deepEqual(createChannelMetadata(
    "10",
    { id: "10", guild_id: "1", name: "current-channel" },
    { id: "1", name: "Current Guild" },
    { channelId: "10", guildId: "1", channelName: "saved-channel", guildName: "Saved Guild" },
), {
    id: "10",
    guildId: "1",
    guildName: "Current Guild",
    channelName: "current-channel",
});
assert.deepEqual(createChannelMetadata(
    "10",
    null,
    null,
    { channelId: "10", guildId: "1", channelName: "saved-channel", guildName: "Saved Guild" },
), {
    id: "10",
    guildId: "1",
    guildName: "Saved Guild",
    channelName: "saved-channel",
});
assert.deepEqual(createChannelMetadata(
    "10",
    { id: "10", guild_id: "1", name: "" },
    { id: "1", name: "" },
    { channelId: "10", guildId: "1", channelName: "saved-channel", guildName: "Saved Guild" },
), {
    id: "10",
    guildId: "1",
    guildName: "Saved Guild",
    channelName: "saved-channel",
});

const enabled = [
    { channelId: "10", guildId: "1", channelName: "general", guildName: "Guild" },
    { channelId: "11", guildId: "1", channelName: "thread", guildName: "Guild" },
];
const remoteStatuses = [{
    channelId: "10",
    guildId: "1",
    guildName: "Guild",
    channelName: "general",
    messageCount: 20,
    eventCount: 24,
    deletedCount: 1,
    oldestMessageAt: "2026-07-01T00:00:00.000Z",
    newestMessageAt: "2026-07-31T00:00:00.000Z",
}, {
    channelId: "12",
    guildId: "1",
    guildName: "Guild",
    channelName: "archive",
    messageCount: 10,
    eventCount: 12,
    deletedCount: 0,
    oldestMessageAt: "2026-06-01T00:00:00.000Z",
    newestMessageAt: "2026-06-30T00:00:00.000Z",
}];
assert.deepEqual(buildChannelDirectory(
    [enabled[0]],
    [enabled[1]],
    remoteStatuses,
).map(item => [item.channelId, item.state, item.status?.messageCount ?? null]), [
    ["10", "recording", 20],
    ["11", "closing", null],
    ["12", "stopped", 10],
]);

assert.deepEqual(parseEnabledChannels(serializeEnabledChannels(enabled)), enabled);
assert.deepEqual(parseEnabledChannels("invalid"), []);
assert.equal(validateHealthResult({
    ok: true,
    status: 200,
    body: JSON.stringify({ ok: true, service: "vencord-channel-logger", version: 2 }),
}), true);
assert.equal(validateHealthResult({ ok: true, status: 200, body: "ok" }), false);
assert.deepEqual(validateLogResult({
    ok: true,
    status: 200,
    body: JSON.stringify({ ok: true, received: 2 }),
}, 2), {
    ok: true,
    status: 200,
    body: JSON.stringify({ ok: true, received: 2 }),
});
assert.equal(validateLogResult({ ok: true, status: 200, body: "ok" }, 2).ok, false);
assert.equal(validateLogResult({
    ok: true,
    status: 200,
    body: JSON.stringify({ ok: true, received: 1 }),
}, 2).ok, false);

const cachedMessage = { id: "500", channel_id: "10" };
assert.deepEqual(collectCachedMessages({
    _array: [cachedMessage],
    _map: { "500": cachedMessage },
    _before: { _messages: [{ id: "499", channel_id: "10" }] },
    _after: { _map: { "501": { id: "501", channel_id: "10" } } },
}).map(message => message.id), ["499", "500", "501"]);

async function testCountFlush() {
    const scheduler = createScheduler();
    const batches: any[][] = [];
    const queue = new ChannelBatchQueue(async (_channelId, records) => {
        batches.push(records);
        return { ok: true, status: 200, body: "ok" };
    }, scheduler);

    for (let index = 0; index < MAX_BATCH_RECORDS - 1; index++) {
        queue.enqueue("10", record(String(1000 + index)));
    }
    assert.equal(batches.length, 0);
    assert.equal(scheduler.timers[0].delay, FLUSH_INTERVAL_MS);

    queue.enqueue("10", record("9999"));
    await queue.idle("10");
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, MAX_BATCH_RECORDS);
    assert.equal(queue.status("10").pendingRecords, 0);
}

async function testByteFlush() {
    const scheduler = createScheduler();
    const batches: any[][] = [];
    const queue = new ChannelBatchQueue(async (_channelId, records) => {
        batches.push(records);
        return { ok: true, status: 200, body: "ok" };
    }, scheduler);

    const largeContent = "x".repeat(Math.ceil(TARGET_BATCH_BYTES / 2));
    queue.enqueue("10", record("200", largeContent));
    queue.enqueue("10", record("201", largeContent));
    await queue.idle("10");
    assert.equal(batches.length, 2);
    assert.equal(batches[0].length, 1);
    assert.equal(batches[1].length, 1);
}

async function testTimerFlush() {
    const scheduler = createScheduler();
    const batches: any[][] = [];
    const queue = new ChannelBatchQueue(async (_channelId, records) => {
        batches.push(records);
        return { ok: true, status: 200, body: "ok" };
    }, scheduler);

    queue.enqueue("10", record("300"));
    assert.equal(scheduler.runNext(), FLUSH_INTERVAL_MS);
    await queue.idle("10");
    assert.equal(batches.length, 1);
}

async function testFailureRetention() {
    const scheduler = createScheduler();
    let attempt = 0;
    const queue = new ChannelBatchQueue(async () => {
        attempt++;
        return attempt === 1
            ? { ok: false, status: 507, body: "disk full" }
            : { ok: true, status: 200, body: "ok" };
    }, scheduler);

    queue.enqueue("10", record("400"));
    scheduler.runNext();
    await queue.idle("10");
    assert.equal(queue.status("10").pendingRecords, 1);
    assert.match(queue.status("10").lastError ?? "", /507.*disk full/);
    for (let index = 0; index < MAX_BATCH_RECORDS; index++) {
        queue.enqueue("10", record(String(5000 + index)));
    }
    assert.equal(attempt, 1);
    assert.equal(scheduler.timers.length, 1);
    assert.equal(scheduler.runNext(), 1000);
    await queue.idle("10");
    assert.equal(queue.status("10").pendingRecords, 0);
    assert.equal(queue.status("10").lastError, null);
}

async function testPauseAndResume() {
    const scheduler = createScheduler();
    let sent = 0;
    const queue = new ChannelBatchQueue(async () => {
        sent++;
        return { ok: true, status: 200, body: "ok" };
    }, scheduler);

    queue.pause();
    queue.enqueue("10", record("500"));
    assert.equal(scheduler.timers.length, 0);
    queue.resume();
    await queue.idle("10");
    assert.equal(sent, 1);
}

async function testCloseAndReopenChannel() {
    const scheduler = createScheduler();
    const batches: any[][] = [];
    let resolveFirst!: (result: { ok: boolean; status: number; body: string; }) => void;
    const firstResult = new Promise<{ ok: boolean; status: number; body: string; }>(resolve => {
        resolveFirst = resolve;
    });
    const queue = new ChannelBatchQueue(async (_channelId, records) => {
        batches.push(records);
        if (batches.length === 1) return firstResult;
        return { ok: true, status: 200, body: "ok" };
    }, scheduler);

    queue.enqueue("10", record("600"));
    scheduler.runNext();
    queue.closeChannel("10");
    assert.equal(queue.status("10").pendingRecords, 1);
    queue.enqueue("10", record("blocked"));
    assert.equal(queue.status("10").pendingRecords, 1);

    queue.openChannel("10");
    queue.enqueue("10", record("601"));
    resolveFirst({ ok: true, status: 200, body: "ok" });
    await queue.idle("10");
    assert.deepEqual(batches.map(batch => batch.map(item => item.messageId)), [["600"], ["601"]]);
    assert.equal(queue.status("10").pendingRecords, 0);
}

async function main() {
    await testCountFlush();
    await testByteFlush();
    await testTimerFlush();
    await testFailureRetention();
    await testPauseAndResume();
    await testCloseAndReopenChannel();
}

void main();
