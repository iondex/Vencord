import { createHash } from "node:crypto";

import { z } from "zod";

const id = z.string().regex(/^\d{1,32}$/);
const optionalId = z.union([id, z.literal("")]).default("");
export const routeSchema = z.object({
    routeId: z.string().min(1),
    name: z.string().default(""),
    enabled: z.boolean(),
    serverId: id,
    channelId: optionalId,
    senderId: optionalId,
    targetChannelId: id,
    filters: z.array(z.string()).default([]),
    replacements: z.array(z.object({ find: z.string(), replaceWith: z.string(), caseSensitive: z.boolean().default(false) })).default([]),
    filterChinese: z.boolean().default(false),
    forwardImages: z.boolean().default(true),
});
export type Route = z.infer<typeof routeSchema>;
const signalSchema = z.object({
    enabled: z.boolean(),
    providerBaseUrl: z.string().default(""),
    model: z.string().default(""),
    targetChannelId: optionalId,
    indexTargetChannelId: optionalId,
    timeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
    routeIds: z.array(z.string()).default([]),
    routes: z.array(z.object({
        routeId: z.string(), enabled: z.boolean(), tickerWhitelistEnabled: z.boolean().default(false),
        tickerWhitelist: z.array(z.string()).default([]),
    })).default([]),
});
export const snapshotSchema = z.object({
    routes: z.array(routeSchema),
    signal: signalSchema,
    profiles: z.array(z.record(z.string(), z.unknown())).default([]),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export function adaptRouteWire(input: unknown) {
    if (!input || typeof input !== "object") throw new Error("invalid_route_shape");
    const route = input as Record<string, unknown>;
    return {
        ...route,
        filters: route.filter_keywords ?? route.filters,
        filterChinese: route.filter_chinese ?? route.filterChinese,
        forwardImages: route.forward_images ?? route.forwardImages,
    };
}

export function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }

export function canonical(value: any): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
}

export function validateSnapshot(value: unknown): Snapshot {
    const snapshot = snapshotSchema.parse(value);
    if (snapshot.signal.enabled && (!snapshot.signal.model || !snapshot.signal.targetChannelId)) throw new Error("incomplete_signal_config");
    if (new Set(snapshot.routes.map(route => route.routeId)).size !== snapshot.routes.length) throw new Error("duplicate_route_id");
    const known = new Set(snapshot.routes.map(route => route.routeId));
    if ([...snapshot.signal.routeIds, ...snapshot.signal.routes.map(route => route.routeId)].some(route => !known.has(route))) throw new Error("unknown_signal_route");
    const graph = new Map<string, string[]>();
    for (const route of snapshot.routes.filter(route => route.enabled)) {
        if (!route.channelId && !route.senderId) throw new Error("route_without_selector");
        const targets = [route.targetChannelId];
        if (signalEnabled(snapshot, route.routeId)) targets.push(snapshot.signal.targetChannelId, snapshot.signal.indexTargetChannelId);
        if (route.channelId) graph.set(route.channelId, [...(graph.get(route.channelId) ?? []), ...targets.filter(Boolean)]);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (node: string) => {
        if (visiting.has(node)) throw new Error("unsafe_route_cycle");
        if (visited.has(node)) return;
        visiting.add(node);
        for (const target of graph.get(node) ?? []) visit(target);
        visiting.delete(node);
        visited.add(node);
    };
    for (const node of graph.keys()) visit(node);
    return snapshot;
}

export function signalEnabled(config: Snapshot, routeId: string) {
    return config.signal.enabled && (config.signal.routes.length
        ? config.signal.routes.some(route => route.routeId === routeId && route.enabled)
        : config.signal.routeIds.includes(routeId));
}

export function createConfigSync(baseUrl: string, token: string | undefined, apply: (snapshot: Snapshot) => void, report: (code: string) => void, fetcher: typeof fetch = fetch) {
    let active: Promise<void> | undefined;
    async function get(path: string): Promise<any> {
        const url = new URL(path, baseUrl);
        if (url.origin !== new URL(baseUrl).origin) throw new Error("config_origin_mismatch");
        const response = await fetcher(url, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: AbortSignal.timeout(15_000), redirect: "error",
        });
        if (!response.ok) throw new Error(`config_http_${response.status}`);
        return response.json();
    }
    async function read() {
        const routes: unknown[] = [];
        let total: number | undefined;
        for (let page = 1; page <= 1000; page++) {
            const result = await get(`/routes?page=${page}`);
            if (!Array.isArray(result.routes) || !Number.isInteger(result.total) || result.total < 0 || result.page !== page) throw new Error("invalid_route_page");
            if (total !== undefined && total !== result.total) throw new Error("route_total_changed");
            total = result.total;
            routes.push(...result.routes.map(adaptRouteWire));
            if (routes.length >= total!) break;
            if (!result.routes.length || page === 1000) throw new Error("incomplete_route_pages");
        }
        if (routes.length !== total) throw new Error("route_count_mismatch");
        const signal = await get("/api/admin/signal-config");
        const profiles = await get("/api/admin/target-channel-profiles");
        return validateSnapshot({ routes, signal, profiles: profiles.profiles });
    }
    return () => active ??= (async () => {
        try {
            const first = await read();
            const second = await read();
            if (canonical(first) !== canonical(second)) throw new Error("config_changed_during_read");
            apply(second);
            report("config_sync_ok");
        } catch {
            report("config_sync_failed_using_cache");
        } finally { active = undefined; }
    })();
}
