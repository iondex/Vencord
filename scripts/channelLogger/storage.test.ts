/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ChannelLogStore } from "./storage";

async function main() {
    const directory = await mkdtemp(join(tmpdir(), "vencord-channel-logger-"));

    try {
    const store = new ChannelLogStore(directory, () => "2026-07-31T14:00:00.000Z");
    const firstPayload = {
        id: "100",
        channel_id: "10",
        content: "first",
        timestamp: "2026-07-31T12:00:00.000Z",
        attachments: [{ id: "attachment-1", url: "https://cdn.discordapp.com/file" }]
    };

    assert.deepEqual(store.log("10", [
        {
            type: "message", messageId: "100", observedAt: "2026-07-31T12:00:00.000Z",
            eventType: "load", payloadKind: "snapshot", payloadSource: "flux-event", payload: firstPayload,
        },
        {
            type: "message", messageId: "100", observedAt: "2026-07-31T12:01:00.000Z",
            eventType: "load", payloadKind: "snapshot", payloadSource: "flux-event", payload: firstPayload,
        },
        { type: "delete", messageId: "missing", observedAt: "2026-07-31T12:01:30.000Z" },
    ], {
        guildId: "1",
        guildName: "Guild",
        channelName: "general",
    }), {
        received: 3,
        inserted: 1,
        updated: 0,
        duplicates: 1,
        deleted: 0,
        ignoredDeletes: 1,
    });

    assert.deepEqual(store.log("10", [
        {
            type: "message",
            messageId: "100",
            observedAt: "2026-07-31T12:02:00.000Z",
            eventType: "update",
            payloadKind: "snapshot",
            payloadSource: "message-store",
            payload: { ...firstPayload, content: "edited" }
        },
        {
            type: "message",
            messageId: "101",
            observedAt: "2026-07-31T12:03:00.000Z",
            eventType: "create",
            payloadKind: "snapshot",
            payloadSource: "flux-event",
            payload: {
                id: "101",
                channel_id: "10",
                content: "newest",
                timestamp: "2026-07-31T12:03:00.000Z",
            }
        },
        { type: "delete", messageId: "100", observedAt: "2026-07-31T12:04:00.000Z" },
        { type: "delete", messageId: "100", observedAt: "2026-07-31T12:05:00.000Z" },
    ], {
        guildId: "1",
        guildName: "Guild",
        channelName: "general",
    }), {
        received: 4,
        inserted: 1,
        updated: 1,
        duplicates: 0,
        deleted: 1,
        ignoredDeletes: 1,
    });

    assert.deepEqual(store.status("10"), {
        channelId: "10",
        guildId: "1",
        guildName: "Guild",
        channelName: "general",
        messageCount: 2,
        versionCount: 3,
        eventCount: 3,
        deletedCount: 1,
        duplicateCount: 1,
        oldestMessageAt: "2026-07-31T12:00:00.000Z",
        newestMessageAt: "2026-07-31T12:03:00.000Z",
        firstObservedAt: "2026-07-31T12:00:00.000Z",
        lastObservedAt: "2026-07-31T12:05:00.000Z",
        lastWriteAt: "2026-07-31T14:00:00.000Z",
    });
    assert.deepEqual(store.listStatuses(), [store.status("10")]);

    const exported = Array.from(store.exportMessages("10"));
    assert.deepEqual(exported.map(item => item.payload.id), ["101", "100"]);
    assert.equal(exported[1].payload.content, "edited");
    assert.equal(exported[1].logger.deletedAt, "2026-07-31T12:04:00.000Z");
    assert.equal(exported[1].logger.versionCount, 2);

    const versions = Array.from(store.exportVersions("10"));
    assert.deepEqual(versions.map(item => [item.messageId, item.payload.content]), [
        ["101", "newest"],
        ["100", "edited"],
        ["100", "first"],
    ]);

    const firstMessagePage = store.readMessagePage("10", null, 1);
    assert.deepEqual(firstMessagePage.items.map(item => item.payload.id), ["101"]);
    assert.equal(firstMessagePage.nextCursor, "101");
    const secondMessagePage = store.readMessagePage("10", firstMessagePage.nextCursor, 1);
    assert.deepEqual(secondMessagePage.items.map(item => item.payload.id), ["100"]);
    assert.equal(secondMessagePage.nextCursor, null);

    const firstVersionPage = store.readVersionPage("10", null, 1);
    assert.deepEqual(firstVersionPage.items.map(item => item.payload.content), ["newest"]);
    assert(firstVersionPage.nextCursor);
    const secondVersionPage = store.readVersionPage("10", firstVersionPage.nextCursor, 1);
    assert.deepEqual(secondVersionPage.items.map(item => item.payload.content), ["edited"]);
    assert(secondVersionPage.nextCursor);
    const thirdVersionPage = store.readVersionPage("10", secondVersionPage.nextCursor, 1);
    assert.deepEqual(thirdVersionPage.items.map(item => item.payload.content), ["first"]);
    assert.equal(thirdVersionPage.nextCursor, null);

    const dedupMetadata = {
        guildId: "2",
        guildName: "Dedup Guild",
        channelName: "dedup",
    };
    const originalPayload = {
        id: "200",
        channel_id: "20",
        content: "original",
        author: { id: "300", username: "user" },
        timestamp: "2026-07-30T10:00:00.000Z",
    };
    assert.equal(store.log("20", [{
        type: "message",
        messageId: "200",
        observedAt: "2026-07-31T10:00:00.000Z",
        eventType: "load",
        payloadKind: "snapshot",
        payloadSource: "flux-event",
        payload: originalPayload,
    }], dedupMetadata).inserted, 1);

    const reorderedPayload = {
        timestamp: originalPayload.timestamp,
        author: { username: "user", id: "300" },
        content: "original",
        channel_id: "20",
        id: "200",
    };
    assert.deepEqual(store.log("20", [{
        type: "message",
        messageId: "200",
        observedAt: "2026-07-31T10:01:00.000Z",
        eventType: "load",
        payloadKind: "snapshot",
        payloadSource: "flux-event",
        payload: reorderedPayload,
    }], dedupMetadata), {
        received: 1,
        inserted: 0,
        updated: 0,
        duplicates: 1,
        deleted: 0,
        ignoredDeletes: 0,
    });

    assert.equal(store.log("20", [{
        type: "message",
        messageId: "200",
        observedAt: "2026-07-31T10:02:00.000Z",
        eventType: "update",
        payloadKind: "snapshot",
        payloadSource: "message-store",
        payload: { ...originalPayload, content: "edited" },
    }], dedupMetadata).updated, 1);
    assert.deepEqual(store.log("20", [{
        type: "message",
        messageId: "200",
        observedAt: "2026-07-31T10:03:00.000Z",
        eventType: "update",
        payloadKind: "snapshot",
        payloadSource: "message-store",
        payload: originalPayload,
    }], dedupMetadata), {
        received: 1,
        inserted: 0,
        updated: 1,
        duplicates: 0,
        deleted: 0,
        ignoredDeletes: 0,
    });
    assert.equal(store.status("20").versionCount, 2);
    assert.equal(store.status("20").duplicateCount, 1);

    assert.deepEqual(store.log("20", [
        { type: "delete", messageId: "200", observedAt: "2026-07-31T10:04:00.000Z" },
        { type: "delete", messageId: "200", observedAt: "2026-07-31T10:05:00.000Z" },
        { type: "delete", messageId: "201", observedAt: "2026-07-31T10:06:00.000Z" },
    ], dedupMetadata), {
        received: 3,
        inserted: 0,
        updated: 0,
        duplicates: 0,
        deleted: 1,
        ignoredDeletes: 2,
    });
    store.log("20", [{
        type: "message",
        messageId: "200",
        observedAt: "2026-07-31T10:07:00.000Z",
        eventType: "cache",
        payloadKind: "snapshot",
        payloadSource: "message-store",
        payload: originalPayload,
    }], dedupMetadata);
    const reloadedDeletedMessage = Array.from(store.exportMessages("20"))[0];
    assert.equal(reloadedDeletedMessage.logger.deletedAt, "2026-07-31T10:04:00.000Z");
    assert.equal(reloadedDeletedMessage.payload.content, "original");

    const eventMetadata = {
        guildId: "3",
        guildName: "Event Guild",
        channelName: "events",
    };
    const eventOriginal = {
        id: "300",
        channel_id: "30",
        content: "original",
        author: { id: "301", username: "author" },
        timestamp: "2026-07-31T11:00:00.000Z",
    };
    store.log("30", [{
        type: "message",
        messageId: "300",
        observedAt: "2026-07-31T11:00:00.000Z",
        eventType: "load",
        payloadKind: "snapshot",
        payloadSource: "flux-event",
        payload: eventOriginal,
    }], eventMetadata);
    const rawUpdatePatch = {
        id: "300",
        channel_id: "30",
        content: "edited",
        edited_timestamp: "2026-07-31T11:01:00.000Z",
    };
    store.log("30", [{
        type: "message",
        messageId: "300",
        observedAt: "2026-07-31T11:01:00.000Z",
        eventType: "update",
        payloadKind: "patch",
        payloadSource: "flux-event",
        payload: rawUpdatePatch,
    }], eventMetadata);
    assert.equal(Array.from(store.exportMessages("30"))[0].payload.content, "original");
    assert.equal(store.status("30").versionCount, 1);

    const clientSnapshot = { ...eventOriginal, content: "edited", editedTimestamp: "2026-07-31T11:01:00.000Z" };
    store.log("30", [{
        type: "message",
        messageId: "300",
        observedAt: "2026-07-31T11:01:01.000Z",
        eventType: "update",
        payloadKind: "snapshot",
        payloadSource: "message-store",
        payload: clientSnapshot,
    }], eventMetadata);
    store.log("30", [{
        type: "message",
        messageId: "300",
        observedAt: "2026-07-31T11:02:00.000Z",
        eventType: "update",
        payloadKind: "patch",
        payloadSource: "flux-event",
        payload: rawUpdatePatch,
    }], eventMetadata);
    assert.equal(Array.from(store.exportMessages("30"))[0].payload.content, "edited");
    assert.equal(store.status("30").versionCount, 2);
    assert.deepEqual(Array.from((store as any).exportEvents("30")).map((event: any) => ({
        eventType: event.eventType,
        payloadKind: event.payloadKind,
        payloadSource: event.payloadSource,
        content: event.payload.content,
        hasAuthor: event.payload.author != null,
    })), [{
        eventType: "update",
        payloadKind: "patch",
        payloadSource: "flux-event",
        content: "edited",
        hasAuthor: false,
    }, {
        eventType: "update",
        payloadKind: "snapshot",
        payloadSource: "message-store",
        content: "edited",
        hasAuthor: true,
    }, {
        eventType: "update",
        payloadKind: "patch",
        payloadSource: "flux-event",
        content: "edited",
        hasAuthor: false,
    }, {
        eventType: "load",
        payloadKind: "snapshot",
        payloadSource: "flux-event",
        content: "original",
        hasAuthor: true,
    }]);

    store.log("40", [{
        type: "message",
        messageId: "400",
        observedAt: "2026-07-31T12:00:00.000Z",
        eventType: "update",
        payloadKind: "patch",
        payloadSource: "flux-event",
        payload: { id: "400", channel_id: "40", content: "patch only" },
    }], {
        guildId: "4",
        guildName: "Patch Guild",
        channelName: "patch-only",
    });
    assert.equal((store.status("40") as any).eventCount, 1);
    assert.equal(store.status("40").messageCount, 0);
    assert(store.listStatuses().some(status => status.channelId === "40"));

    store.close();

    const legacyDirectory = join(directory, "legacy");
    await mkdir(legacyDirectory);
    const legacyDatabase = new DatabaseSync(join(legacyDirectory, "channel-logger.sqlite3"));
    legacyDatabase.exec("CREATE TABLE channel_stats (channel_id TEXT PRIMARY KEY)");
    legacyDatabase.close();
    assert.throws(
        () => new ChannelLogStore(legacyDirectory),
        /unsupported channel logger database schema.*new --dir|remove/i,
    );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

void main();
