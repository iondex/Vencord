import { CaptureEnvelope } from "../contracts/ingest.js";
import { signalEnabled } from "./config.js";
import { matchingRoutes, renderMessage } from "./routing.js";
import { Store } from "./storage.js";

export function safetyState(store: Store, event: CaptureEnvelope, excludedServerIds: string[]) {
    const own = store.ownOutput(event);
    if (own) return own;
    if (event.message.author?.id === event.accountId) return "filtered_self";
    if (excludedServerIds.includes(event.serverId)) return "excluded_server";
    if (event.excludedServerIds.includes(event.serverId)) return "safety_pending";
}

export function planMessages(store: Store, excludedServerIds: string[], limit = 100) {
    const rows = store.db.prepare("SELECT * FROM messages WHERE state='pending' ORDER BY created_at LIMIT ?").all(limit) as any[];
    const deferred = store.db.prepare("SELECT * FROM messages WHERE state='safety_pending' ORDER BY checked_at,created_at LIMIT ?").all(Math.max(1, Math.floor(limit / 5))) as any[];
    rows.push(...deferred);
    const configurations = new Map<string, ReturnType<Store["config"]>>();
    for (const row of rows) {
        const event = JSON.parse(row.envelope) as CaptureEnvelope;
        if (!configurations.has(row.config_hash)) configurations.set(row.config_hash, store.config(row.config_hash || undefined));
        const config = configurations.get(row.config_hash);
        store.transaction(() => {
            store.db.prepare("UPDATE messages SET checked_at=? WHERE message_key=?").run(Date.now(), row.message_key);
            const routes = config ? matchingRoutes(config.snapshot, event) : [];
            const recordRoutes = (decision: string) => {
                for (const route of routes) store.recordRoute(row.message_key, route.routeId, route.targetChannelId, config!.hash, decision);
            };
            const safety = safetyState(store, event, excludedServerIds);
            if (safety) {
                store.db.prepare("UPDATE messages SET state=? WHERE message_key=?").run(safety, row.message_key);
                recordRoutes(safety);
                return;
            }
            if (!config) {
                store.db.prepare("UPDATE messages SET state='waiting_config' WHERE message_key=?").run(row.message_key);
                return;
            }
            let state = "no_matching_route";
            if (routes.length > 1) {
                state = "route_conflict";
                store.alert("route_conflict", "Multiple routes matched a message; all route decisions are recorded and delivery is held for configuration review", "critical");
            }
            else if (routes.length === 1) {
                const route = routes[0];
                let rendering: ReturnType<typeof renderMessage>;
                try { rendering = renderMessage(event, route); } catch {
                    rendering = { reason: "archived_unsupported", parts: [] };
                }
                state = rendering.reason;
                for (const [part, body] of rendering.parts.entries()) store.enqueue(row.message_key, "deliver", route.routeId, route.targetChannelId, part, body, config.hash);
                if (rendering.parts.length && signalEnabled(config.snapshot, route.routeId)) {
                    const timestamp = Date.parse(typeof event.message.timestamp === "string" ? event.message.timestamp : event.capturedAt);
                    if (!Number.isFinite(timestamp) || Date.now() - timestamp > 15 * 60_000) {
                        store.enqueue(row.message_key, "extract", route.routeId, "", 0, {}, config.hash);
                        store.db.prepare("UPDATE jobs SET state='review',error='stale_signal' WHERE message_key=? AND kind='extract'").run(row.message_key);
                    } else store.enqueue(row.message_key, "extract", route.routeId, "", 0, {}, config.hash);
                }
            }
            recordRoutes(state);
            store.db.prepare("UPDATE messages SET state=? WHERE message_key=?").run(state, row.message_key);
        });
    }
}

export function executable(store: Store, job: any, excludedServerIds: string[]) {
    if (typeof job.config_hash !== "string" || !job.config_hash) return undefined;
    let config: ReturnType<Store["config"]>;
    let currentConfig: ReturnType<Store["config"]>;
    try {
        config = store.config(job.config_hash);
        currentConfig = store.config();
    } catch { return undefined; }
    const row = store.db.prepare("SELECT envelope FROM messages WHERE message_key=?").get(job.message_key) as any;
    const event = JSON.parse(row.envelope) as CaptureEnvelope;
    const route = config?.snapshot.routes.find(route => route.routeId === job.route_id && route.enabled);
    const safety = safetyState(store, event, excludedServerIds);
    if (safety || !config || !route || !currentConfig || store.metadata("paused") === "true") return undefined;
    const currentMatches = matchingRoutes(currentConfig.snapshot, event);
    if (currentMatches.length !== 1 || currentMatches[0].routeId !== route.routeId) return undefined;
    if ((job.kind === "extract" || job.kind === "signal")
        && (!signalEnabled(currentConfig.snapshot, route.routeId) || !signalEnabled(config.snapshot, route.routeId))) return undefined;
    if (job.kind === "deliver" && job.target !== route.targetChannelId) return undefined;
    if (job.kind === "signal" && ![config.snapshot.signal.targetChannelId, config.snapshot.signal.indexTargetChannelId].includes(job.target)) return undefined;
    return { event, config, route, currentConfig };
}
