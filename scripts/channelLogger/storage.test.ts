/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelLogStore } from "./storage";

async function main() {
    const directory = await mkdtemp(join(tmpdir(), "vencord-channel-logger-"));

    try {
    const store = new ChannelLogStore(directory, () => "2026-07-31T14:00:00.000Z");
    const firstPayload = {
        id: "100",
        channel_id: "10",
        content: "first",
        attachments: [{ id: "attachment-1", url: "https://cdn.discordapp.com/file" }]
    };

    assert.deepEqual(store.log("10", [
        { type: "message", messageId: "100", observedAt: "2026-07-31T12:00:00.000Z", payload: firstPayload },
        { type: "message", messageId: "100", observedAt: "2026-07-31T12:01:00.000Z", payload: firstPayload },
        { type: "delete", messageId: "missing", observedAt: "2026-07-31T12:01:30.000Z" },
    ]), {
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
            payload: { ...firstPayload, content: "edited" }
        },
        {
            type: "message",
            messageId: "101",
            observedAt: "2026-07-31T12:03:00.000Z",
            payload: { id: "101", channel_id: "10", content: "newest" }
        },
        { type: "delete", messageId: "100", observedAt: "2026-07-31T12:04:00.000Z" },
        { type: "delete", messageId: "100", observedAt: "2026-07-31T12:05:00.000Z" },
    ]), {
        received: 4,
        inserted: 1,
        updated: 1,
        duplicates: 0,
        deleted: 1,
        ignoredDeletes: 1,
    });

    assert.deepEqual(store.status("10"), {
        channelId: "10",
        messageCount: 2,
        versionCount: 3,
        deletedCount: 1,
        duplicateCount: 1,
        firstObservedAt: "2026-07-31T12:00:00.000Z",
        lastObservedAt: "2026-07-31T12:05:00.000Z",
        lastWriteAt: "2026-07-31T14:00:00.000Z",
    });

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

        store.close();
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

void main();
