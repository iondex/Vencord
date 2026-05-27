/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "assert/strict";

import {
    createForwarderStats,
    createHealthUrl,
    shouldForwardGuildNotification,
} from "./logic";

assert.equal(createHealthUrl("http://127.0.0.1:49321/forward"), "http://127.0.0.1:49321/healthz");
assert.equal(createHealthUrl("https://example.test/custom/path?x=1"), "https://example.test/healthz");
assert.equal(createHealthUrl("not a url"), null);

const stats = createForwarderStats();
stats.recordForwardAttempt(true);
stats.recordForwardAttempt(false);
stats.recordFiltered("self");
stats.recordFiltered("non-guild");

assert.deepEqual(stats.snapshot(), {
    forwarded: 1,
    failed: 1,
    filteredSelf: 1,
    filteredNonGuild: 1,
    filteredDiscord: 0,
});

assert.equal(shouldForwardGuildNotification({
    optimistic: false,
    message: {
        id: "msg-1",
        channel_id: "chan-1",
        guild_id: "guild-1",
        author: { id: "user-1" },
    },
    channel: { guild_id: "guild-1", type: 0 },
    currentUserId: "me",
    discordShouldNotify: true,
}), true);

assert.equal(shouldForwardGuildNotification({
    optimistic: false,
    message: {
        id: "msg-dm",
        channel_id: "dm-1",
        author: { id: "user-1" },
    },
    channel: { type: 1 },
    currentUserId: "me",
    discordShouldNotify: true,
}), false);

assert.equal(shouldForwardGuildNotification({
    optimistic: false,
    message: {
        id: "msg-self",
        channel_id: "chan-1",
        guild_id: "guild-1",
        author: { id: "me" },
    },
    channel: { guild_id: "guild-1", type: 0 },
    currentUserId: "me",
    discordShouldNotify: true,
}), false);
