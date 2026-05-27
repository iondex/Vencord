/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ForwarderStatsSnapshot {
    forwarded: number;
    failed: number;
    filteredSelf: number;
    filteredNonGuild: number;
    filteredDiscord: number;
}

type FilterReason = "self" | "non-guild" | "discord";

export interface ForwarderStats {
    recordForwardAttempt(ok: boolean): void;
    recordFiltered(reason: FilterReason): void;
    snapshot(): ForwarderStatsSnapshot;
}

interface ForwardableMessage {
    id?: string;
    channel_id?: string;
    guild_id?: string | null;
    author?: {
        id?: string;
    } | null;
}

interface ForwardableChannel {
    guild_id?: string | null;
    type?: number;
}

export interface ForwardCheckInput {
    optimistic?: boolean;
    message?: ForwardableMessage | null;
    channel?: ForwardableChannel | null;
    currentUserId?: string | null;
    discordShouldNotify: boolean;
}

export function createForwarderStats(): ForwarderStats {
    const values: ForwarderStatsSnapshot = {
        forwarded: 0,
        failed: 0,
        filteredSelf: 0,
        filteredNonGuild: 0,
        filteredDiscord: 0,
    };

    return {
        recordForwardAttempt(ok) {
            if (ok) {
                values.forwarded++;
            } else {
                values.failed++;
            }
        },
        recordFiltered(reason) {
            if (reason === "self") values.filteredSelf++;
            if (reason === "non-guild") values.filteredNonGuild++;
            if (reason === "discord") values.filteredDiscord++;
        },
        snapshot() {
            return { ...values };
        },
    };
}

export function createHealthUrl(serverUrl: string) {
    try {
        const url = new URL(serverUrl);
        url.pathname = "/healthz";
        url.search = "";
        url.hash = "";

        return url.toString();
    } catch {
        return null;
    }
}

export function hasGuildContext(message: ForwardableMessage | null | undefined, channel: ForwardableChannel | null | undefined) {
    return Boolean(message?.guild_id || channel?.guild_id);
}

export function getForwardSkipReason({ optimistic, message, channel, currentUserId, discordShouldNotify }: ForwardCheckInput): FilterReason | null {
    if (optimistic) return "discord";
    if (!message?.id || !message.channel_id) return "discord";
    if (message.author?.id === currentUserId) return "self";
    if (!hasGuildContext(message, channel)) return "non-guild";
    if (!discordShouldNotify) return "discord";

    return null;
}

export function shouldForwardGuildNotification(input: ForwardCheckInput) {
    return getForwardSkipReason(input) === null;
}
