import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { CaptureEnvelope, validateCapture } from "../contracts/ingest.js";
import { digest } from "./config.js";
import { Store } from "./storage.js";

export function recoverLogger(store: Store, path: string, accountId: string, excludedServerIds: string[]) {
    if (!existsSync(path)) throw new Error("logger_database_unavailable");
    const logger = new DatabaseSync(path, { readOnly: true });
    try {
        const version = (logger.prepare("PRAGMA user_version").get() as any).user_version;
        if (version !== 2) throw new Error("unsupported_logger_schema");
        const identity = statSync(path);
        const checkpointKey = `logger_rowid:${digest(`${path}:${identity.dev}:${identity.ino}:${identity.birthtimeMs}:${accountId}`)}`;
        const checkpoint = Number(store.metadata(checkpointKey) ?? 0);
        const high = Number((logger.prepare("SELECT coalesce(max(rowid),0) AS id FROM message_versions").get() as any).id);
        const after = checkpoint > high ? 0 : checkpoint;
        const rows = logger.prepare(`SELECT v.rowid AS cursor,v.*,s.guild_id FROM message_versions v
            JOIN channel_stats s USING(channel_id) WHERE v.rowid>? ORDER BY v.rowid LIMIT 500`).all(after) as any[];
        for (const row of rows) {
            const event: CaptureEnvelope = {
                schemaVersion: 2, eventId: `logger:${accountId}:${row.channel_id}:${row.message_id}:${row.payload_hash}`,
                eventType: "RECOVERY", capturedAt: row.observed_at, accountId,
                serverId: row.guild_id, channelId: row.channel_id, excludedServerIds,
                message: JSON.parse(row.payload_json),
            };
            if (!validateCapture(event)) throw new Error("invalid_logger_capture");
            if (!store.db.prepare("SELECT 1 FROM receipts WHERE event_id=?").get(event.eventId)) store.ingest(event, JSON.stringify(event));
            store.setMetadata(checkpointKey, String(row.cursor));
        }
    } finally { logger.close(); }
}

function snowflakeBefore(time: number) { return ((BigInt(Math.max(0, Math.trunc(time) - 1420070400000))) << 22n).toString(); }

export async function recoverBotHistory(store: Store, botToken: string, accountId: string, excludedServerIds: string[], fetcher: typeof fetch = fetch) {
    const config = store.config();
    if (!config) return;
    const channels = new Map(config.snapshot.routes.filter(route => route.enabled && route.channelId && !excludedServerIds.includes(route.serverId)).map(route => [route.channelId, route.serverId]));
    for (const [channelId, serverId] of channels) {
        const checkpointKey = `bot_history:${accountId}:${channelId}`;
        const saved = store.metadata(checkpointKey);
        const scan = saved ? JSON.parse(saved) : { completedAt: Date.now() - 10 * 60_000 };
        if (!scan.upper) {
            scan.upper = Date.now();
            scan.lower = scan.completedAt - 10 * 60_000;
            scan.before = snowflakeBefore(scan.upper);
        }
        const response = await fetcher(`https://discord.com/api/v10/channels/${channelId}/messages?limit=100&before=${scan.before}`, {
            headers: { Authorization: `Bot ${botToken}` }, signal: AbortSignal.timeout(15_000), redirect: "error",
        });
        if (!response.ok) {
            store.alert(`history_coverage_${channelId}`, `Source channel ${channelId} history is unavailable (HTTP ${response.status}); live archival continues`);
            continue;
        }
        const messages = await response.json();
        if (!Array.isArray(messages)) throw new Error("invalid_history_response");
        let reachedBoundary = messages.length < 100;
        for (const message of messages) {
            const timestamp = Date.parse(message.timestamp);
            if (timestamp < scan.lower) { reachedBoundary = true; continue; }
            const event: CaptureEnvelope = {
                schemaVersion: 2, eventId: `bot-history:${accountId}:${channelId}:${message.id}`, eventType: "RECOVERY",
                capturedAt: message.timestamp, accountId, serverId, channelId, excludedServerIds, message,
            };
            if (!validateCapture(event)) throw new Error("invalid_history_capture");
            if (!store.db.prepare("SELECT 1 FROM receipts WHERE event_id=?").get(event.eventId)) store.ingest(event, JSON.stringify(event));
        }
        if (reachedBoundary) store.setMetadata(checkpointKey, JSON.stringify({ completedAt: scan.upper }));
        else {
            const before = messages.reduce((oldest: string, message: any) => BigInt(message.id) < BigInt(oldest) ? message.id : oldest, scan.before);
            if (before === scan.before) throw new Error("history_cursor_not_advancing");
            store.setMetadata(checkpointKey, JSON.stringify({ ...scan, before }));
        }
        store.resolveAlert(`history_coverage_${channelId}`);
    }
}
