import { statSync } from "node:fs";

import { LocalServiceStatistics } from "../contracts/diagnostics.js";
import { testModeAllowsRoute } from "./queue.js";
import { Store } from "./storage.js";

const startedAt = Date.now();
const cache = new WeakMap<Store, { at: number; value: ReturnType<typeof collectStatistics>; }>();

function collectStatistics(store: Store, now: number, excludedServerIds: string[]) {
    const { db } = store;
    const count = (sql: string, ...parameters: number[]) => Number((db.prepare(sql).get(...parameters) as { total: number; }).total);
    const config = store.config();
    const syncedAt = Number(store.metadata("config_synced_at")) || null;
    const paused = store.metadata("paused") === "true";
    const testMode = store.metadata("test_mode") === "true";
    const jobStates = db.prepare("SELECT kind,state,count(*) AS total FROM jobs GROUP BY kind,state").all() as { kind: string; state: string; total: number; }[];
    const pendingStates = new Set(["pending", "leased", "sending", "retry_wait", "uncertain", "held", "dead", "review"]);
    const queue = jobStates.filter(row => row.kind !== "extract" && pendingStates.has(row.state)).reduce((sum, row) => sum + row.total, 0);
    const oldestPendingAt = (db.prepare(`SELECT min(message.created_at) AS time FROM jobs AS job JOIN messages AS message ON message.message_key=job.message_key
        WHERE job.kind!='extract' AND job.state IN ('pending','leased','sending','retry_wait','uncertain','held','dead','review')`).get() as { time: number | null; }).time;
    const latest = db.prepare("SELECT max(received_at) AS capturedAt FROM receipts").get() as { capturedAt: number | null; };
    const sent = db.prepare("SELECT max(updated_at) AS sentAt FROM sink_deliveries WHERE state='sent'").get() as { sentAt: number | null; };
    const windows = (since: number) => ({
        captured: count("SELECT count(*) AS total FROM messages WHERE created_at>=?", since),
        received: count("SELECT count(*) AS total FROM receipts WHERE received_at>=?", since),
        delivered: count("SELECT count(*) AS total FROM sink_deliveries WHERE state='sent' AND updated_at>=?", since),
        failedAttempts: count("SELECT count(*) AS total FROM delivery_attempts WHERE finished_at>=? AND outcome IN ('rejected','preflight_failed','uncertain')", since),
    });
    const hour = windows(now - 3_600_000);
    const day = windows(now - 86_400_000);
    const successfulAttempts = count("SELECT count(*) AS total FROM delivery_attempts WHERE outcome='sent' AND finished_at>=?", now - 86_400_000);
    const summary: LocalServiceStatistics = {
        messages: count("SELECT count(*) AS total FROM messages"), receipts: count("SELECT count(*) AS total FROM receipts"),
        delivered: count("SELECT count(*) AS total FROM sink_deliveries WHERE state='sent'"),
        capturedLastHour: hour.captured, deliveredLastHour: hour.delivered, queued: queue, oldestPendingAt,
        lastCapturedAt: latest.capturedAt, lastDeliveredAt: sent.sentAt,
        successRate24h: successfulAttempts + day.failedAttempts ? successfulAttempts / (successfulAttempts + day.failedAttempts) : null,
    };
    const routeJobs = db.prepare(`SELECT job.route_id AS routeId,job.state,count(*) AS total,max(sink.updated_at) AS lastSentAt
        FROM jobs AS job LEFT JOIN sink_deliveries AS sink ON sink.job_id=job.id AND sink.state='sent'
        WHERE job.kind!='extract' GROUP BY job.route_id,job.state`).all() as { routeId: string; state: string; total: number; lastSentAt: number | null; }[];
    const decisions = db.prepare("SELECT route_id AS routeId,count(*) AS total FROM route_receipts GROUP BY route_id").all() as { routeId: string; total: number; }[];
    const routes = (config?.snapshot.routes ?? []).map(route => {
        const rows = routeJobs.filter(row => row.routeId === route.routeId);
        return {
            routeId: route.routeId, name: route.name, target: route.targetChannelId,
            enabled: route.enabled && testModeAllowsRoute(store, route) && !excludedServerIds.includes(route.serverId),
            matched: decisions.find(row => row.routeId === route.routeId)?.total ?? 0,
            sent: rows.filter(row => row.state === "sent").reduce((sum, row) => sum + row.total, 0),
            queued: rows.filter(row => pendingStates.has(row.state)).reduce((sum, row) => sum + row.total, 0),
            attention: rows.filter(row => ["retry_wait", "uncertain", "held", "dead", "review"].includes(row.state)).reduce((sum, row) => sum + row.total, 0),
            lastSentAt: Math.max(0, ...rows.map(row => row.lastSentAt ?? 0)) || null,
        };
    });
    const minuteStart = Math.floor(now / 60_000) * 60_000;
    const buckets = (sql: string) => new Map((db.prepare(sql).all(minuteStart - 59 * 60_000) as { minute: number; total: number; }[]).map(row => [row.minute, row.total]));
    const captures = buckets("SELECT cast(created_at/60000 AS integer)*60000 AS minute,count(*) AS total FROM messages WHERE created_at>=? GROUP BY minute");
    const deliveries = buckets("SELECT cast(updated_at/60000 AS integer)*60000 AS minute,count(*) AS total FROM sink_deliveries WHERE state='sent' AND updated_at>=? GROUP BY minute");
    const failures = buckets("SELECT cast(finished_at/60000 AS integer)*60000 AS minute,count(*) AS total FROM delivery_attempts WHERE finished_at>=? AND outcome IN ('rejected','preflight_failed','uncertain') GROUP BY minute");
    const timeline = Array.from({ length: 60 }, (_, index) => {
        const time = minuteStart - (59 - index) * 60_000;
        return { time, captured: captures.get(time) ?? 0, delivered: deliveries.get(time) ?? 0, failed: failures.get(time) ?? 0 };
    });
    const durationSamples = (db.prepare("SELECT finished_at-started_at AS duration FROM delivery_attempts WHERE outcome='sent' ORDER BY id DESC LIMIT 500").all() as { duration: number; }[]).map(row => row.duration).sort((first, second) => first - second);
    const activeAlerts = db.prepare("SELECT code,severity,due_at AS since,sent_at AS lastNotifiedAt FROM alerts WHERE active=1 ORDER BY severity,due_at LIMIT 50").all();
    const attention = jobStates.some(row => ["retry_wait", "uncertain", "held", "dead", "review"].includes(row.state));
    const health = paused ? "paused" : !config || !syncedAt || now - syncedAt > 900_000 || attention || activeAlerts.length ? "degraded" : "healthy";
    const recentFailures = db.prepare(`SELECT attempt.finished_at AS time,job.route_id AS routeId,job.target,attempt.outcome,attempt.status,attempt.error AS code
        FROM delivery_attempts AS attempt JOIN jobs AS job ON job.id=attempt.job_id WHERE attempt.finished_at>0 AND attempt.outcome IN ('rejected','preflight_failed','uncertain') ORDER BY attempt.id DESC LIMIT 20`)
        .all() as { time: number; routeId: string; target: string; outcome: string; status: number; code: string; }[];
    return {
        observedAt: now, startedAt, uptimeSeconds: Math.max(0, Math.floor((now - startedAt) / 1000)), health, paused, testMode, summary,
        config: { syncedAt, ageSeconds: syncedAt ? Math.max(0, Math.floor((now - syncedAt) / 1000)) : null, routes: routes.length, enabledRoutes: routes.filter(route => route.enabled).length },
        traffic: { minute: windows(now - 60_000), hour, day, today: windows(Date.parse(`${new Date(now + 28_800_000).toISOString().slice(0, 10)}T00:00:00+08:00`)) },
        timeline, routes, jobStates,
        messageStates: db.prepare("SELECT state,count(*) AS total FROM messages GROUP BY state").all(),
        activeAlerts,
        recentFailures: recentFailures.map(row => ({ ...row, code: /^[\w:.-]{0,128}$/.test(row.code) ? row.code : "unexpected_error" })),
        deliveryDurationP95Ms: durationSamples.length ? durationSamples[Math.ceil(durationSamples.length * 0.95) - 1] : null,
        deliveryDurationSamples: durationSamples.length,
        quarantined: count("SELECT count(*) AS total FROM quarantine"),
    };
}

export function readStatistics(store: Store, excludedServerIds: string[] = []) {
    const now = Date.now();
    const cached = cache.get(store);
    if (cached && now - cached.at < 1500) return cached.value;
    const value = collectStatistics(store, now, excludedServerIds);
    cache.set(store, { at: now, value });
    return value;
}

export function storageBytes(databasePath?: string) {
    return databasePath ? [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].reduce((total, path) => {
        try { return total + statSync(path).size; } catch { return total; }
    }, 0) : 0;
}
