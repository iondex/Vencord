import { LocalRouteTest, LocalServiceStatus } from "../contracts/diagnostics.js";
import { CaptureEnvelope } from "../contracts/ingest.js";
import { testModeAllowsRoute } from "./queue.js";
import { readStatistics } from "./statistics.js";
import { Store } from "./storage.js";

export function localServiceStatus(store: Store, excludedServerIds: string[]): LocalServiceStatus {
    return {
        service: "signal-hub", protocol: 2,
        paused: store.metadata("paused") === "true",
        testMode: store.metadata("test_mode") === "true",
        configSyncedAt: store.metadata("config_synced_at") ?? null,
        routes: (store.config()?.snapshot.routes ?? []).map(route => ({
            routeId: route.routeId, name: route.name, enabled: route.enabled && testModeAllowsRoute(store, route),
            serverId: route.serverId, targetChannelId: route.targetChannelId, excluded: excludedServerIds.includes(route.serverId),
        })),
        jobs: store.db.prepare("SELECT state,count(*) AS total FROM jobs GROUP BY state").all() as LocalServiceStatus["jobs"],
        statistics: readStatistics(store, excludedServerIds).summary,
    };
}

export function localRouteTest(store: Store, requestId: string): LocalRouteTest | undefined {
    const row = store.db.prepare(`SELECT job.* FROM jobs AS job JOIN messages AS message ON message.message_key=job.message_key
        WHERE message.message_key=? AND message.state='route_test' AND job.kind='deliver'`).get(`test:${requestId}`) as any;
    if (!row) return undefined;
    return { requestId, jobId: row.id, routeId: row.route_id, targetChannelId: row.target, state: row.state, attempts: row.attempts, error: row.error, dueAt: row.due_at };
}

export function createLocalRouteTest(store: Store, requestId: string, routeId: string, excludedServerIds: string[]) {
    const existing = localRouteTest(store, requestId);
    if (existing) return existing.routeId === routeId ? { test: existing } : { error: "test_request_conflict", status: 409 };
    if (store.metadata("paused") === "true") return { error: "service_paused", status: 409 };
    const config = store.config();
    const route = config?.snapshot.routes.find(route => route.routeId === routeId);
    if (!config || !route) return { error: "route_not_found", status: 404 };
    if (!route.enabled || excludedServerIds.includes(route.serverId)) return { error: "route_disabled_or_excluded", status: 422 };
    if (!testModeAllowsRoute(store, route)) return { error: "test_mode_filtered", status: 422 };
    const key = `test:${requestId}`;
    const timestamp = new Date().toISOString();
    const event: CaptureEnvelope = {
        schemaVersion: 2, eventId: key, eventType: "MESSAGE_CREATE", capturedAt: timestamp,
        accountId: "0", serverId: route.serverId, channelId: route.channelId || "0", excludedServerIds: [],
        message: { id: "0", channel_id: route.channelId || "0", author: { id: route.senderId || "1" }, content: "Signal-hub 路由投递测试", timestamp },
    };
    store.transaction(() => {
        store.db.prepare("INSERT INTO messages(message_key,envelope,state,created_at,config_hash) VALUES(?,?,'route_test',?,?)").run(key, JSON.stringify(event), Date.now(), config.hash);
        store.recordRoute(key, route.routeId, route.targetChannelId, config.hash, "route_test");
        store.enqueue(key, "deliver", route.routeId, route.targetChannelId, 0, {
            content: `【Signal-hub 转发测试】\n时间：${timestamp}\n测试编号：${requestId}\n本消息用于验证目标投递，不参与信号解析。`,
            allowed_mentions: { parse: [] },
        }, config.hash);
    });
    return { test: localRouteTest(store, requestId)! };
}
