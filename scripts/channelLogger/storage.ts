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
    messageCount: number;
    versionCount: number;
    deletedCount: number;
    duplicateCount: number;
    firstObservedAt: string | null;
    lastObservedAt: string | null;
    lastWriteAt: string | null;
}

interface ExistingMessageRow {
    payload_hash: string;
    deleted_at: string | null;
}

interface StatusRow {
    message_count: number;
    version_count: number;
    deleted_count: number;
    duplicate_count: number;
    first_observed_at: string | null;
    last_observed_at: string | null;
    last_write_at: string | null;
}

interface ExportRow {
    payload_json: string;
    first_seen_at: string;
    last_seen_at: string;
    deleted_at: string | null;
    version_count: number;
}

interface ExportVersionRow {
    message_id: string;
    observed_at: string;
    payload_json: string;
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
        messageCount: 0,
        versionCount: 0,
        deletedCount: 0,
        duplicateCount: 0,
        firstObservedAt: null,
        lastObservedAt: null,
        lastWriteAt: null,
    };
}

export class ChannelLogStore {
    readonly databasePath: string;
    private readonly database: DatabaseSync;

    constructor(directory: string, private readonly now = () => new Date().toISOString()) {
        mkdirSync(directory, { recursive: true });
        this.databasePath = join(directory, "channel-logger.sqlite3");
        this.database = new DatabaseSync(this.databasePath);
        this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
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
                message_count INTEGER NOT NULL DEFAULT 0,
                version_count INTEGER NOT NULL DEFAULT 0,
                deleted_count INTEGER NOT NULL DEFAULT 0,
                duplicate_count INTEGER NOT NULL DEFAULT 0,
                first_observed_at TEXT,
                last_observed_at TEXT,
                last_write_at TEXT
            );
        `);
    }

    log(channelId: string, records: ChannelLogRecord[]): LogResult {
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
                    if (versionResult.changes === 0) result.duplicates++;
                    else versionsAdded++;
                }
            }

            const observedTimes = records.map(record => record.observedAt).sort();
            const firstObservedAt = observedTimes[0];
            const lastObservedAt = observedTimes.at(-1)!;
            const lastWriteAt = this.now();
            this.database.prepare(`
                INSERT INTO channel_stats (
                    channel_id, message_count, version_count, deleted_count, duplicate_count,
                    first_observed_at, last_observed_at, last_write_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(channel_id) DO UPDATE SET
                    message_count = message_count + excluded.message_count,
                    version_count = version_count + excluded.version_count,
                    deleted_count = deleted_count + excluded.deleted_count,
                    duplicate_count = duplicate_count + excluded.duplicate_count,
                    first_observed_at = MIN(first_observed_at, excluded.first_observed_at),
                    last_observed_at = MAX(last_observed_at, excluded.last_observed_at),
                    last_write_at = excluded.last_write_at
            `).run(
                channelId,
                result.inserted,
                versionsAdded,
                result.deleted,
                result.duplicates,
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
                message_count,
                version_count,
                deleted_count,
                duplicate_count,
                first_observed_at,
                last_observed_at,
                last_write_at
            FROM channel_stats
            WHERE channel_id = ?
        `).get(channelId) as StatusRow | undefined;

        if (!row) return emptyStatus(channelId);
        return {
            channelId,
            messageCount: row.message_count,
            versionCount: row.version_count,
            deletedCount: row.deleted_count,
            duplicateCount: row.duplicate_count,
            firstObservedAt: row.first_observed_at,
            lastObservedAt: row.last_observed_at,
            lastWriteAt: row.last_write_at,
        };
    }

    *exportMessages(channelId: string) {
        const rows = this.database.prepare(`
            SELECT
                messages.payload_json,
                messages.first_seen_at,
                messages.last_seen_at,
                messages.deleted_at,
                COUNT(message_versions.payload_hash) AS version_count
            FROM messages
            JOIN message_versions USING (channel_id, message_id)
            WHERE messages.channel_id = ?
            GROUP BY messages.channel_id, messages.message_id
            ORDER BY CAST(messages.message_id AS INTEGER) DESC
        `).iterate(channelId) as Iterable<ExportRow>;

        for (const row of rows) {
            yield {
                payload: JSON.parse(row.payload_json),
                logger: {
                    firstSeenAt: row.first_seen_at,
                    lastSeenAt: row.last_seen_at,
                    deletedAt: row.deleted_at,
                    versionCount: row.version_count,
                }
            };
        }
    }

    *exportVersions(channelId: string) {
        const rows = this.database.prepare(`
            SELECT message_id, observed_at, payload_json
            FROM message_versions
            WHERE channel_id = ?
            ORDER BY CAST(message_id AS INTEGER) DESC, observed_at DESC
        `).iterate(channelId) as Iterable<ExportVersionRow>;

        for (const row of rows) {
            yield {
                messageId: row.message_id,
                observedAt: row.observed_at,
                payload: JSON.parse(row.payload_json),
            };
        }
    }

    close() {
        this.database.close();
    }
}
