/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "assert/strict";

import { buildChannelExport, collectCachedMessages, createExportFilename, isSupportedGuildChannel } from "./logic";

function message(id: string, timestamp: string, extra: Record<string, unknown> = {}) {
    const raw = {
        id,
        channel_id: "channel-1",
        timestamp,
        state: "SENT",
        content: `message-${id}`,
        attachments: [],
        ...extra,
    };

    return {
        ...raw,
        toJS: () => ({ ...raw, nestedBigInt: 42n }),
    };
}

const newest = message("103", "2026-07-31T12:03:00.000Z");
const middle = message("102", "2026-07-31T12:02:00.000Z");
const oldest = message("101", "2026-07-31T12:01:00.000Z");
const pending = message("local-pending", "2026-07-31T12:04:00.000Z", { state: "SENDING" });

const cache = {
    hasMoreBefore: true,
    hasMoreAfter: false,
    _array: [middle, newest, pending],
    _map: {
        "102": middle,
    },
    _before: {
        _messages: [oldest, middle],
        _map: {
            "101": oldest,
        },
    },
    _after: {
        _messages: [newest],
        _map: {},
    },
};

const collected = collectCachedMessages(cache);
assert.deepEqual(collected.map(item => item.id), ["103", "102", "101"]);

const exported = buildChannelExport({
    exportedAt: "2026-07-31T13:00:00.000Z",
    guild: { id: "guild-1", name: "Guild" },
    channel: { id: "channel-1", name: "general", type: 0, guild_id: "guild-1" },
    cache,
});

assert.deepEqual(exported.export, {
    format: "vencord-channel-cache",
    version: 1,
    exportedAt: "2026-07-31T13:00:00.000Z",
    order: "newest-first",
    payloadKind: "discord-client-message-record",
    completeness: "loaded-cache-only",
    hasMoreBefore: true,
    hasMoreAfter: false,
    messageCount: 3,
    newestTimestamp: "2026-07-31T12:03:00.000Z",
    oldestTimestamp: "2026-07-31T12:01:00.000Z",
});
assert.deepEqual(exported.guild, { id: "guild-1", name: "Guild" });
assert.deepEqual(exported.channel, { id: "channel-1", name: "general", type: 0, guild_id: "guild-1" });
assert.deepEqual(exported.messages.map(item => item.id), ["103", "102", "101"]);
assert.equal(exported.messages[0].nestedBigInt, "42");
assert.equal("toJS" in exported.messages[0], false);

for (const type of [0, 5, 10, 11, 12]) {
    assert.equal(isSupportedGuildChannel({ guild_id: "guild-1", type }), true);
}
for (const type of [1, 2, 3, 4, 13, 14, 15]) {
    assert.equal(isSupportedGuildChannel({ guild_id: "guild-1", type }), false);
}
assert.equal(isSupportedGuildChannel({ type: 0 }), false);

assert.equal(
    createExportFilename("Guild/Name", "general:chat", "2026-07-31T13:00:00.000Z"),
    "Guild-Name-general-chat-2026-07-31.json",
);
