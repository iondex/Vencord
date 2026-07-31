/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

interface MessageLike {
    id?: string;
    state?: string;
    timestamp?: Date | string | number;
    toJS?(): unknown;
}

interface MessageCacheLike {
    _messages?: MessageLike[];
    _map?: Record<string, MessageLike>;
}

export interface ChannelMessagesLike {
    hasMoreBefore?: boolean;
    hasMoreAfter?: boolean;
    _array?: MessageLike[];
    _map?: Record<string, MessageLike>;
    _before?: MessageCacheLike;
    _after?: MessageCacheLike;
}

interface ChannelExportInput {
    exportedAt: string;
    guild: unknown;
    channel: unknown;
    cache: ChannelMessagesLike;
}

interface ChannelLike {
    guild_id?: string | null;
    type?: number;
}

const SUPPORTED_GUILD_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);

export function isSupportedGuildChannel(
    channel: ChannelLike | null | undefined,
): channel is ChannelLike & { guild_id: string; type: number; } {
    return Boolean(channel?.guild_id && channel.type != null && SUPPORTED_GUILD_CHANNEL_TYPES.has(channel.type));
}

function sanitizeFilenamePart(value: string) {
    return value
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[. -]+|[. -]+$/g, "")
        .slice(0, 80) || "unknown";
}

export function createExportFilename(guildName: string, channelName: string, exportedAt: string) {
    const date = exportedAt.slice(0, 10);
    return `${sanitizeFilenamePart(guildName)}-${sanitizeFilenamePart(channelName)}-${date}.json`;
}

function timestampValue(message: MessageLike) {
    const value = message.timestamp;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) return parsed;
    }

    if (message.id && /^\d+$/.test(message.id)) {
        return Number(BigInt(message.id) >> 22n);
    }

    return 0;
}

function values(map?: Record<string, MessageLike>) {
    return map ? Object.values(map) : [];
}

export function collectCachedMessages(cache: ChannelMessagesLike): MessageLike[] {
    const candidates = [
        ...(cache._array ?? []),
        ...values(cache._map),
        ...(cache._before?._messages ?? []),
        ...values(cache._before?._map),
        ...(cache._after?._messages ?? []),
        ...values(cache._after?._map),
    ];
    const unique = new Map<string, MessageLike>();

    for (const message of candidates) {
        if (!message?.id || message.state === "SENDING" || message.state === "SEND_FAILED") continue;
        if (!unique.has(message.id)) unique.set(message.id, message);
    }

    return Array.from(unique.values()).sort((a, b) => timestampValue(b) - timestampValue(a));
}

export function toJsonValue(value: unknown) {
    const seen = new WeakSet<object>();

    return JSON.parse(JSON.stringify(value, (_key, item) => {
        if (typeof item === "bigint") return item.toString();
        if (typeof item === "function") return undefined;

        if (typeof item === "object" && item !== null) {
            if (seen.has(item)) return "[Circular]";
            seen.add(item);
        }

        return item;
    }));
}

function serializeRecord(value: unknown) {
    if (typeof value === "object" && value !== null && "toJS" in value && typeof value.toJS === "function") {
        return toJsonValue(value.toJS());
    }

    return toJsonValue(value);
}

export function buildChannelExport({ exportedAt, guild, channel, cache }: ChannelExportInput) {
    const cachedMessages = collectCachedMessages(cache);
    const messages = cachedMessages.map(serializeRecord) as Array<Record<string, any>>;

    return {
        export: {
            format: "vencord-channel-cache",
            version: 1,
            exportedAt,
            order: "newest-first",
            payloadKind: "discord-client-message-record",
            completeness: "loaded-cache-only",
            hasMoreBefore: Boolean(cache.hasMoreBefore),
            hasMoreAfter: Boolean(cache.hasMoreAfter),
            messageCount: messages.length,
            newestTimestamp: messages[0]?.timestamp ?? null,
            oldestTimestamp: messages.at(-1)?.timestamp ?? null,
        },
        guild: serializeRecord(guild),
        channel: serializeRecord(channel),
        messages,
    };
}
