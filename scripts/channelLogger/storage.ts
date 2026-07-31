/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface MessageLogRecord {
    type: "message";
    messageId: string;
    observedAt: string;
    payload: Record<string, unknown>;
}

export interface DeleteLogRecord {
    type: "delete";
    messageId: string;
    observedAt: string;
}

export type ChannelLogRecord = MessageLogRecord | DeleteLogRecord;

export interface ChannelMetadata {
    guildId: string;
    guildName: string;
    channelName: string;
}

export interface LogResult {
    received: number;
    inserted: number;
    updated: number;
    duplicates: number;
    deleted: number;
    ignoredDeletes: number;
}

export interface ChannelStatus {
    channelId: string;
    guildId: string | null;
    guildName: string | null;
    channelName: string | null;
    messageCount: number;
    versionCount: number;
    deletedCount: number;
    duplicateCount: number;
    oldestMessageAt: string | null;
    newestMessageAt: string | null;
    firstObservedAt: string | null;
    lastObservedAt: string | null;
    lastWriteAt: string | null;
}

interface ExistingMessageRow {
    payload_hash: string;
    deleted_at: string | null;
}

interface StatusRow {
    channel_id?: string;
    guild_id: string | null;
    guild_name: string | null;
    channel_name: string | null;
    message_count: number;
    version_count: number;
    deleted_count: number;
    duplicate_count: number;
    oldest_message_at: string | null;
    newest_message_at: string | null;
    first_observed_at: string | null;
    last_observed_at: string | null;
    last_write_at: string | null;
}

interface ExportRow {
    message_id: string;
    payload_json: string;
    first_seen_at: string;
    last_seen_at: string;
    deleted_at: string | null;
    version_count: number;
}

interface ExportVersionRow {
    message_id: string;
    observed_at: string;
    payload_hash: string;
    payload_json: string;
}

export interface VersionCursor {
    messageId: string;
    observedAt: string;
    payloadHash: string;
}

const SCHEMA_VERSION = 1;
const SQLITE_INT64_MAX = 9223372036854775807n;

export function isCanonicalSnowflake(value: unknown): value is string {
    return typeof value === "string"
        && /^[1-9]\d{0,18}$/.test(value)
        && BigInt(value) <= SQLITE_INT64_MAX;
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== "object") return value;

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, canonicalize(item)])
    );
}

function payloadHash(payload: unknown) {
    return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

function emptyStatus(channelId: string): ChannelStatus {
    return {
        channelId,
        guildId: null,
        guildName: null,
        channelName: null,
        messageCount: 0,
        versionCount: 0,
        deletedCount: 0,
        duplicateCount: 0,
        oldestMessageAt: null,
        newestMessageAt: null,
        firstObservedAt: null,
        lastObservedAt: null,
        lastWriteAt: null,
    };
}

const DISCORD_EPOCH = 1420070400000n;

function snowflakeTimestamp(messageId: string) {
    if (!isCanonicalSnowflake(messageId)) return null;
    return new Date(Number((BigInt(messageId) >> 22n) + DISCORD_EPOCH)).toISOString();
}

function messageTimestamp(payload: Record<string, unknown>, messageId: string) {
    if (typeof payload.timestamp === "string") {
        const timestamp = new Date(payload.timestamp);
        if (!Number.isNaN(timestamp.getTime())) return timestamp.toISOString();
    }
    return snowflakeTimestamp(messageId);
}

export class ChannelLogStore {
    readonly databasePath: string;
    private readonly database: DatabaseSync;

    constructor(directory: string, private readonly now = () => new Date().toISOString()) {
        mkdirSync(directory, { recursive: true });
        this.databasePath = join(directory, "channel-logger.sqlite3");
        this.database = new DatabaseSync(this.databasePath);
        this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
        const existingTableCount = (this.database.prepare(`
            SELECT COUNT(*) AS count
            FROM sqlite_schema
            WHERE type = 'table'
                AND name IN ('messages', 'message_versions', 'channel_stats')
        `).get() as { count: number; }).count;
        const schemaVersion = (this.database.prepare("PRAGMA user_version").get() as { user_version: number; }).user_version;
        if (existingTableCount > 0 && schemaVersion !== SCHEMA_VERSION) {
            this.database.close();
            throw new Error(
                `Unsupported channel logger database schema version ${schemaVersion}; `
                + "choose a new --dir or remove the old channel-logger.sqlite3"
            );
        }
        this.database.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                channel_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                payload_hash TEXT NOT NULL,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                deleted_at TEXT,
                PRIMARY KEY (channel_id, message_id)
            );

            CREATE TABLE IF NOT EXISTS message_versions (
                channel_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                payload_hash TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                PRIMARY KEY (channel_id, message_id, payload_hash),
                FOREIGN KEY (channel_id, message_id)
                    REFERENCES messages (channel_id, message_id)
                    ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS channel_stats (
                channel_id TEXT PRIMARY KEY,
                guild_id TEXT NOT NULL,
                guild_name TEXT NOT NULL,
                channel_name TEXT NOT NULL,
                message_count INTEGER NOT NULL DEFAULT 0,
                version_count INTEGER NOT NULL DEFAULT 0,
                deleted_count INTEGER NOT NULL DEFAULT 0,
                duplicate_count INTEGER NOT NULL DEFAULT 0,
                oldest_message_at TEXT,
                newest_message_at TEXT,
                first_observed_at TEXT,
                last_observed_at TEXT,
                last_write_at TEXT
            );

            PRAGMA user_version = ${SCHEMA_VERSION};
        `);
    }

    log(channelId: string, records: ChannelLogRecord[], metadata: ChannelMetadata): LogResult {
        const result: LogResult = {
            received: records.length,
            inserted: 0,
            updated: 0,
            duplicates: 0,
            deleted: 0,
            ignoredDeletes: 0,
        };
        let versionsAdded = 0;
        if (records.length === 0) return result;

        const findMessage = this.database.prepare(`
            SELECT payload_hash, deleted_at
            FROM messages
            WHERE channel_id = ? AND message_id = ?
        `);
        const insertMessage = this.database.prepare(`
            INSERT INTO messages (
                channel_id, message_id, payload_json, payload_hash, first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        const updateMessage = this.database.prepare(`
            UPDATE messages
            SET payload_json = ?, payload_hash = ?, last_seen_at = ?
            WHERE channel_id = ? AND message_id = ?
        `);
        const updateLastSeen = this.database.prepare(`
            UPDATE messages
            SET last_seen_at = ?
            WHERE channel_id = ? AND message_id = ?
        `);
        const insertVersion = this.database.prepare(`
            INSERT OR IGNORE INTO message_versions (
                channel_id, message_id, payload_hash, payload_json, observed_at
            ) VALUES (?, ?, ?, ?, ?)
        `);
        const markDeleted = this.database.prepare(`
            UPDATE messages
            SET deleted_at = ?, last_seen_at = ?
            WHERE channel_id = ? AND message_id = ? AND deleted_at IS NULL
        `);

        this.database.exec("BEGIN IMMEDIATE");
        try {
            for (const record of records) {
                const existing = findMessage.get(channelId, record.messageId) as ExistingMessageRow | undefined;

                if (record.type === "delete") {
                    if (!existing || existing.deleted_at) {
                        result.ignoredDeletes++;
                        continue;
                    }

                    markDeleted.run(record.observedAt, record.observedAt, channelId, record.messageId);
                    result.deleted++;
                    continue;
                }

                const payloadJson = JSON.stringify(record.payload);
                const hash = payloadHash(record.payload);
                if (!existing) {
                    insertMessage.run(
                        channelId,
                        record.messageId,
                        payloadJson,
                        hash,
                        record.observedAt,
                        record.observedAt
                    );
                    insertVersion.run(channelId, record.messageId, hash, payloadJson, record.observedAt);
                    versionsAdded++;
                    result.inserted++;
                } else if (existing.payload_hash === hash) {
                    updateLastSeen.run(record.observedAt, channelId, record.messageId);
                    result.duplicates++;
                } else {
                    updateMessage.run(payloadJson, hash, record.observedAt, channelId, record.messageId);
                    const versionResult = insertVersion.run(
                        channelId,
                        record.messageId,
                        hash,
                        payloadJson,
                        record.observedAt
                    );
                    result.updated++;
                    if (versionResult.changes !== 0) versionsAdded++;
                }
            }

            const observedTimes = records.map(record => record.observedAt).sort();
            const firstObservedAt = observedTimes[0];
            const lastObservedAt = observedTimes.at(-1)!;
            const lastWriteAt = this.now();
            const messageTimes = records
                .filter((record): record is MessageLogRecord => record.type === "message")
                .map(record => messageTimestamp(record.payload, record.messageId))
                .filter((value): value is string => value != null)
                .sort();
            const oldestMessageAt = messageTimes[0] ?? null;
            const newestMessageAt = messageTimes.at(-1) ?? null;
            this.database.prepare(`
                INSERT INTO channel_stats (
                    channel_id, guild_id, guild_name, channel_name,
                    message_count, version_count, deleted_count, duplicate_count,
                    oldest_message_at, newest_message_at,
                    first_observed_at, last_observed_at, last_write_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(channel_id) DO UPDATE SET
                    guild_id = excluded.guild_id,
                    guild_name = excluded.guild_name,
                    channel_name = excluded.channel_name,
                    message_count = message_count + excluded.message_count,
                    version_count = version_count + excluded.version_count,
                    deleted_count = deleted_count + excluded.deleted_count,
                    duplicate_count = duplicate_count + excluded.duplicate_count,
                    oldest_message_at = CASE
                        WHEN oldest_message_at IS NULL THEN excluded.oldest_message_at
                        WHEN excluded.oldest_message_at IS NULL THEN oldest_message_at
                        ELSE MIN(oldest_message_at, excluded.oldest_message_at)
                    END,
                    newest_message_at = CASE
                        WHEN newest_message_at IS NULL THEN excluded.newest_message_at
                        WHEN excluded.newest_message_at IS NULL THEN newest_message_at
                        ELSE MAX(newest_message_at, excluded.newest_message_at)
                    END,
                    first_observed_at = MIN(first_observed_at, excluded.first_observed_at),
                    last_observed_at = MAX(last_observed_at, excluded.last_observed_at),
                    last_write_at = excluded.last_write_at
            `).run(
                channelId,
                metadata.guildId,
                metadata.guildName,
                metadata.channelName,
                result.inserted,
                versionsAdded,
                result.deleted,
                result.duplicates,
                oldestMessageAt,
                newestMessageAt,
                firstObservedAt,
                lastObservedAt,
                lastWriteAt
            );
            this.database.exec("COMMIT");
            return result;
        } catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
    }

    status(channelId: string): ChannelStatus {
        const row = this.database.prepare(`
            SELECT
                guild_id,
                guild_name,
                channel_name,
                message_count,
                version_count,
                deleted_count,
                duplicate_count,
                oldest_message_at,
                newest_message_at,
                first_observed_at,
                last_observed_at,
                last_write_at
            FROM channel_stats
            WHERE channel_id = ?
        `).get(channelId) as StatusRow | undefined;

        if (!row) return emptyStatus(channelId);
        return {
            channelId,
            guildId: row.guild_id,
            guildName: row.guild_name,
            channelName: row.channel_name,
            messageCount: row.message_count,
            versionCount: row.version_count,
            deletedCount: row.deleted_count,
            duplicateCount: row.duplicate_count,
            oldestMessageAt: row.oldest_message_at,
            newestMessageAt: row.newest_message_at,
            firstObservedAt: row.first_observed_at,
            lastObservedAt: row.last_observed_at,
            lastWriteAt: row.last_write_at,
        };
    }

    listStatuses(): ChannelStatus[] {
        const rows = this.database.prepare(`
            SELECT
                channel_id,
                guild_id,
                guild_name,
                channel_name,
                message_count,
                version_count,
                deleted_count,
                duplicate_count,
                oldest_message_at,
                newest_message_at,
                first_observed_at,
                last_observed_at,
                last_write_at
            FROM channel_stats
            WHERE message_count > 0
            ORDER BY newest_message_at DESC, channel_id DESC
        `).all() as unknown as StatusRow[];

        return rows.map(row => ({
            channelId: row.channel_id!,
            guildId: row.guild_id,
            guildName: row.guild_name,
            channelName: row.channel_name,
            messageCount: row.message_count,
            versionCount: row.version_count,
            deletedCount: row.deleted_count,
            duplicateCount: row.duplicate_count,
            oldestMessageAt: row.oldest_message_at,
            newestMessageAt: row.newest_message_at,
            firstObservedAt: row.first_observed_at,
            lastObservedAt: row.last_observed_at,
            lastWriteAt: row.last_write_at,
        }));
    }

    readMessagePage(channelId: string, beforeMessageId: string | null, limit = 250) {
        const pageSize = Math.max(1, Math.min(1000, Math.trunc(limit)));
        const cursorClause = beforeMessageId == null
            ? ""
            : "AND CAST(messages.message_id AS INTEGER) < CAST(? AS INTEGER)";
        const statement = this.database.prepare(`
            SELECT
                messages.message_id,
                messages.payload_json,
                messages.first_seen_at,
                messages.last_seen_at,
                messages.deleted_at,
                COUNT(message_versions.payload_hash) AS version_count
            FROM messages
            JOIN message_versions USING (channel_id, message_id)
            WHERE messages.channel_id = ?
            ${cursorClause}
            GROUP BY messages.channel_id, messages.message_id
            ORDER BY CAST(messages.message_id AS INTEGER) DESC
            LIMIT ?
        `);
        const rows = (beforeMessageId == null
            ? statement.all(channelId, pageSize + 1)
            : statement.all(channelId, beforeMessageId, pageSize + 1)) as unknown as ExportRow[];
        const hasMore = rows.length > pageSize;
        const pageRows = rows.slice(0, pageSize);

        return {
            items: pageRows.map(row => ({
                payload: JSON.parse(row.payload_json),
                logger: {
                    firstSeenAt: row.first_seen_at,
                    lastSeenAt: row.last_seen_at,
                    deletedAt: row.deleted_at,
                    versionCount: row.version_count,
                }
            })),
            nextCursor: hasMore ? pageRows.at(-1)!.message_id : null,
        };
    }

    readVersionPage(channelId: string, cursor: VersionCursor | null, limit = 250) {
        const pageSize = Math.max(1, Math.min(1000, Math.trunc(limit)));
        const cursorClause = cursor == null
            ? ""
            : `AND (
                CAST(message_id AS INTEGER) < CAST(? AS INTEGER)
                OR (message_id = ? AND observed_at < ?)
                OR (message_id = ? AND observed_at = ? AND payload_hash < ?)
            )`;
        const statement = this.database.prepare(`
            SELECT message_id, observed_at, payload_hash, payload_json
            FROM message_versions
            WHERE channel_id = ?
            ${cursorClause}
            ORDER BY CAST(message_id AS INTEGER) DESC, observed_at DESC
                , payload_hash DESC
            LIMIT ?
        `);
        const rows = (cursor == null
            ? statement.all(channelId, pageSize + 1)
            : statement.all(
                channelId,
                cursor.messageId,
                cursor.messageId,
                cursor.observedAt,
                cursor.messageId,
                cursor.observedAt,
                cursor.payloadHash,
                pageSize + 1
            )) as unknown as ExportVersionRow[];
        const hasMore = rows.length > pageSize;
        const pageRows = rows.slice(0, pageSize);
        const last = pageRows.at(-1);

        return {
            items: pageRows.map(row => ({
                messageId: row.message_id,
                observedAt: row.observed_at,
                payload: JSON.parse(row.payload_json),
            })),
            nextCursor: hasMore && last
                ? {
                    messageId: last.message_id,
                    observedAt: last.observed_at,
                    payloadHash: last.payload_hash,
                }
                : null,
        };
    }

    *exportMessages(channelId: string) {
        let cursor: string | null = null;
        do {
            const page = this.readMessagePage(channelId, cursor);
            yield* page.items;
            cursor = page.nextCursor;
        } while (cursor != null);
    }

    *exportVersions(channelId: string) {
        let cursor: VersionCursor | null = null;
        do {
            const page = this.readVersionPage(channelId, cursor);
            yield* page.items;
            cursor = page.nextCursor;
        } while (cursor != null);
    }

    close() {
        this.database.close();
    }
}
