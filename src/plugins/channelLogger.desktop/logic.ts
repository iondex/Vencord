/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const FLUSH_INTERVAL_MS = 50;
export const MAX_BATCH_RECORDS = 100;
export const TARGET_BATCH_BYTES = 512 * 1024;
export const LOGGER_API_PREFIX = "/api/v2";

export interface MessageLogRecord {
    type: "message";
    messageId: string;
    observedAt: string;
    eventType: "load" | "create" | "update" | "cache";
    payloadKind: "snapshot" | "patch";
    payloadSource: "flux-event" | "message-store";
    payload: Record<string, unknown>;
}

export type MessageCaptureMetadata = Pick<MessageLogRecord, "eventType" | "payloadKind" | "payloadSource">;

export interface DeleteLogRecord {
    type: "delete";
    messageId: string;
    observedAt: string;
}

export type ChannelLogRecord = MessageLogRecord | DeleteLogRecord;

export interface EnabledChannelLogger {
    channelId: string;
    guildId: string;
    channelName: string;
    guildName: string;
}

export interface LoggerChannelMetadata {
    id: string;
    guildId: string;
    guildName: string;
    channelName: string;
}

export interface RemoteChannelStatusLike {
    channelId: string;
    guildId: string | null;
    guildName: string | null;
    channelName: string | null;
    messageCount: number;
    eventCount: number;
    deletedCount: number;
    oldestMessageAt: string | null;
    newestMessageAt: string | null;
}

export interface ChannelDirectoryEntry extends EnabledChannelLogger {
    state: "recording" | "closing" | "stopped";
    status: RemoteChannelStatusLike | null;
}

export interface SendResult {
    ok: boolean;
    status: number;
    body: string;
}

export interface ChannelQueueStatus {
    pendingRecords: number;
    pendingBytes: number;
    inFlight: boolean;
    lastError: string | null;
    lastSuccessAt: string | null;
}

interface QueueEntry {
    record: ChannelLogRecord;
    bytes: number;
}

interface ChannelQueueState {
    entries: QueueEntry[];
    pendingBytes: number;
    timer: unknown;
    inFlight: Promise<void> | null;
    failedAttempts: number;
    lastError: string | null;
    lastSuccessAt: string | null;
    closed: boolean;
}

interface Scheduler {
    setTimer(callback: () => void, delay: number): unknown;
    clearTimer(timer: unknown): void;
}

interface MessageLike {
    id?: string;
    channel_id?: string;
    channelId?: string;
    state?: string;
    toJS?(): unknown;
}

interface MessageCacheLike {
    _messages?: MessageLike[];
    _map?: Record<string, MessageLike>;
}

interface ChannelMessagesLike {
    _array?: MessageLike[];
    _map?: Record<string, MessageLike>;
    _before?: MessageCacheLike;
    _after?: MessageCacheLike;
}

const defaultScheduler: Scheduler = {
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const SUPPORTED_GUILD_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);

export function isSupportedGuildChannel<T extends { guild_id?: string | null; type?: number; }>(
    channel: T | null | undefined,
): channel is T & { guild_id: string; type: number; } {
    return Boolean(channel?.guild_id && channel.type != null && SUPPORTED_GUILD_CHANNEL_TYPES.has(channel.type));
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

export function createMessageLogRecord<T extends MessageLike>(
    message: T,
    observedAt: string,
    capture: MessageCaptureMetadata,
): MessageLogRecord | null {
    if (!message?.id || message.state === "SENDING" || message.state === "SEND_FAILED") return null;
    let payload: unknown;
    try {
        const source = typeof message.toJS === "function" ? message.toJS() : message;
        payload = toJsonValue(source);
    } catch {
        return null;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

    return {
        type: "message",
        messageId: message.id,
        observedAt,
        ...capture,
        payload: payload as Record<string, unknown>,
    };
}

export function createDeleteLogRecord(messageId: string, observedAt = new Date().toISOString()): DeleteLogRecord | null {
    if (!/^\d{1,32}$/.test(messageId)) return null;
    return { type: "delete", messageId, observedAt };
}

export function collectCachedMessages(cache: ChannelMessagesLike): MessageLike[] {
    const mapValues = (map?: Record<string, MessageLike>) => map ? Object.values(map) : [];
    const candidates = [
        ...(cache._array ?? []),
        ...mapValues(cache._map),
        ...(cache._before?._messages ?? []),
        ...mapValues(cache._before?._map),
        ...(cache._after?._messages ?? []),
        ...mapValues(cache._after?._map),
    ];
    const unique = new Map<string, MessageLike>();

    for (const message of candidates) {
        if (!message?.id || message.state === "SENDING" || message.state === "SEND_FAILED") continue;
        unique.set(message.id, message);
    }

    return Array.from(unique.values()).sort((left, right) => {
        if (/^\d+$/.test(left.id!) && /^\d+$/.test(right.id!)) {
            return left.id!.length - right.id!.length || left.id!.localeCompare(right.id!);
        }
        return left.id!.localeCompare(right.id!);
    });
}

export function createApiUrl(baseUrl: string, pathname: string) {
    try {
        const url = new URL(baseUrl);
        if (url.protocol !== "http:") return null;
        if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") return null;
        url.pathname = pathname;
        url.search = "";
        url.hash = "";
        return url.toString();
    } catch {
        return null;
    }
}

export function parseEnabledChannels(value: string): EnabledChannelLogger[] {
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) return [];
        const unique = new Map<string, EnabledChannelLogger>();

        for (const item of parsed) {
            if (!item || typeof item !== "object") continue;
            if (!/^\d{1,32}$/.test(item.channelId) || !/^\d{1,32}$/.test(item.guildId)) continue;
            if (typeof item.channelName !== "string" || typeof item.guildName !== "string") continue;
            unique.set(item.channelId, {
                channelId: item.channelId,
                guildId: item.guildId,
                channelName: item.channelName,
                guildName: item.guildName,
            });
        }

        return Array.from(unique.values());
    } catch {
        return [];
    }
}

export function serializeEnabledChannels(channels: EnabledChannelLogger[]) {
    return JSON.stringify(channels);
}

export function createChannelMetadata(
    channelId: string,
    channel: { id?: string; guild_id?: string | null; name?: string; } | null | undefined,
    guild: { id?: string; name?: string; } | null | undefined,
    saved: EnabledChannelLogger | null | undefined,
): LoggerChannelMetadata | null {
    const guildId = channel?.guild_id ?? saved?.guildId;
    const guildName = guild?.name || saved?.guildName;
    const channelName = channel?.name || saved?.channelName;
    if (!guildId || !guildName || !channelName) return null;

    return { id: channelId, guildId, guildName, channelName };
}

export function buildChannelDirectory(
    enabled: EnabledChannelLogger[],
    closing: EnabledChannelLogger[],
    remote: RemoteChannelStatusLike[],
): ChannelDirectoryEntry[] {
    const entries = new Map<string, ChannelDirectoryEntry>();
    for (const channel of enabled) {
        entries.set(channel.channelId, { ...channel, state: "recording", status: null });
    }
    for (const channel of closing) {
        if (!entries.has(channel.channelId)) {
            entries.set(channel.channelId, { ...channel, state: "closing", status: null });
        }
    }
    for (const status of remote) {
        const existing = entries.get(status.channelId);
        if (existing) {
            existing.status = status;
            continue;
        }
        entries.set(status.channelId, {
            channelId: status.channelId,
            guildId: status.guildId ?? "unknown",
            guildName: status.guildName ?? "未知服务器",
            channelName: status.channelName ?? status.channelId,
            state: "stopped",
            status,
        });
    }

    const stateOrder = { recording: 0, closing: 1, stopped: 2 } as const;
    return Array.from(entries.values()).sort((left, right) =>
        stateOrder[left.state] - stateOrder[right.state]
        || (right.status?.newestMessageAt ?? "").localeCompare(left.status?.newestMessageAt ?? "")
        || right.channelId.localeCompare(left.channelId)
    );
}

export function validateHealthResult(result: SendResult) {
    if (!result.ok) return false;
    try {
        const body = JSON.parse(result.body);
        return body?.ok === true && body.service === "vencord-channel-logger" && body.version === 2;
    } catch {
        return false;
    }
}

export function validateLogResult(result: SendResult, expectedRecords: number): SendResult {
    if (!result.ok) return result;
    try {
        const body = JSON.parse(result.body);
        if (body?.ok === true && body.received === expectedRecords) return result;
    } catch { }

    return {
        ok: false,
        status: result.status,
        body: `Unexpected logger response: ${result.body}`,
    };
}

function recordBytes(record: ChannelLogRecord) {
    return new TextEncoder().encode(JSON.stringify(record)).byteLength + 1;
}

export class ChannelBatchQueue {
    private readonly states = new Map<string, ChannelQueueState>();
    private readonly listeners = new Set<() => void>();
    private paused = false;

    constructor(
        private readonly send: (channelId: string, records: ChannelLogRecord[]) => Promise<SendResult>,
        private readonly scheduler: Scheduler = defaultScheduler,
    ) { }

    enqueue(channelId: string, record: ChannelLogRecord) {
        const state = this.getState(channelId);
        if (state.closed) return;
        const bytes = recordBytes(record);
        state.entries.push({ record, bytes });
        state.pendingBytes += bytes;
        this.emit();

        if (this.paused || state.failedAttempts > 0) return;
        if (state.entries.length >= MAX_BATCH_RECORDS || state.pendingBytes >= TARGET_BATCH_BYTES) {
            this.clearTimer(state);
            void this.flushChannel(channelId);
        } else if (state.timer == null && state.inFlight == null) {
            state.timer = this.scheduler.setTimer(() => {
                state.timer = null;
                void this.flushChannel(channelId);
            }, FLUSH_INTERVAL_MS);
        }
    }

    status(channelId: string): ChannelQueueStatus {
        const state = this.states.get(channelId);
        if (!state) {
            return {
                pendingRecords: 0,
                pendingBytes: 0,
                inFlight: false,
                lastError: null,
                lastSuccessAt: null,
            };
        }

        return {
            pendingRecords: state.entries.length,
            pendingBytes: state.pendingBytes,
            inFlight: state.inFlight != null,
            lastError: state.lastError,
            lastSuccessAt: state.lastSuccessAt,
        };
    }

    subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    pause() {
        this.paused = true;
        for (const state of this.states.values()) this.clearTimer(state);
    }

    resume() {
        this.paused = false;
        for (const [channelId, state] of this.states) {
            if (state.entries.length > 0 && state.inFlight == null) void this.flushChannel(channelId);
        }
    }

    openChannel(channelId: string) {
        this.getState(channelId).closed = false;
        this.emit();
    }

    closeChannel(channelId: string) {
        const state = this.getState(channelId);
        state.closed = true;
        this.emit();
    }

    async idle(channelId: string) {
        let state = this.states.get(channelId);
        while (state?.inFlight) {
            await state.inFlight;
            state = this.states.get(channelId);
        }
    }

    dispose() {
        this.pause();
        this.listeners.clear();
    }

    private getState(channelId: string) {
        let state = this.states.get(channelId);
        if (!state) {
            state = {
                entries: [],
                pendingBytes: 0,
                timer: null,
                inFlight: null,
                failedAttempts: 0,
                lastError: null,
                lastSuccessAt: null,
                closed: false,
            };
            this.states.set(channelId, state);
        }
        return state;
    }

    private clearTimer(state: ChannelQueueState) {
        if (state.timer == null) return;
        this.scheduler.clearTimer(state.timer);
        state.timer = null;
    }

    private selectBatch(state: ChannelQueueState) {
        const batch: QueueEntry[] = [];
        let bytes = 14;

        for (const entry of state.entries) {
            if (batch.length >= MAX_BATCH_RECORDS) break;
            if (batch.length > 0 && bytes + entry.bytes > TARGET_BATCH_BYTES) break;
            batch.push(entry);
            bytes += entry.bytes;
        }
        return batch;
    }

    private async flushChannel(channelId: string): Promise<void> {
        const state = this.getState(channelId);
        if (this.paused || state.inFlight || state.entries.length === 0) return;
        this.clearTimer(state);
        const batch = this.selectBatch(state);

        state.inFlight = (async () => {
            const result = await this.send(channelId, batch.map(entry => entry.record));
            if (!result.ok) {
                state.failedAttempts++;
                state.lastError = `${result.status}: ${result.body}`;
                const retryDelay = Math.min(30_000, 1000 * 2 ** (state.failedAttempts - 1));
                if (!this.paused) {
                    state.timer = this.scheduler.setTimer(() => {
                        state.timer = null;
                        void this.flushChannel(channelId);
                    }, retryDelay);
                }
                return;
            }

            let removedBytes = 0;
            for (const entry of batch) {
                if (state.entries[0] !== entry) break;
                state.entries.shift();
                removedBytes += entry.bytes;
            }
            state.pendingBytes -= removedBytes;
            state.failedAttempts = 0;
            state.lastError = null;
            state.lastSuccessAt = new Date().toISOString();
        })().catch(error => {
            state.failedAttempts++;
            state.lastError = `-1: ${error instanceof Error ? error.message : String(error)}`;
            const retryDelay = Math.min(30_000, 1000 * 2 ** (state.failedAttempts - 1));
            if (!this.paused) {
                state.timer = this.scheduler.setTimer(() => {
                    state.timer = null;
                    void this.flushChannel(channelId);
                }, retryDelay);
            }
        }).finally(() => {
            state.inFlight = null;
            this.emit();
        });

        await state.inFlight;
        if (!this.paused && state.entries.length > 0 && state.timer == null) {
            await this.flushChannel(channelId);
        }
    }

    private emit() {
        for (const listener of this.listeners) listener();
    }
}
