import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { readStatistics, storageBytes } from "./statistics.js";
import { Store } from "./storage.js";

export function createDashboard(store: Store, options: { databasePath?: string; excludedServerIds?: string[]; } = {}) {
    const assets = new Map([
        ["/", { type: "text/html; charset=utf-8", body: readFileSync(new URL("./dashboard.html", import.meta.url)) }],
        ["/dashboard.css", { type: "text/css; charset=utf-8", body: readFileSync(new URL("./dashboard.css", import.meta.url)) }],
        ["/dashboard.js", { type: "text/javascript; charset=utf-8", body: readFileSync(new URL("./dashboard.js", import.meta.url)) }],
    ]);
    return createServer((request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        if (!["GET", "HEAD"].includes(request.method ?? "")) { response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return; }
        try {
            const path = new URL(request.url ?? "/", "http://signal-hub.local").pathname;
            if (path === "/api/status" || path === "/healthz") {
                const statistics = readStatistics(store, options.excludedServerIds);
                const body = path === "/healthz" ? { ok: true, service: "signal-hub", health: statistics.health } : {
                    ...statistics,
                    resources: { databaseBytes: storageBytes(options.databasePath), rssBytes: process.memoryUsage().rss, heapBytes: process.memoryUsage().heapUsed, pid: process.pid },
                };
                response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                response.end(request.method === "HEAD" ? undefined : JSON.stringify(body));
                return;
            }
            const asset = assets.get(path);
            if (!asset) { response.writeHead(404); response.end(); return; }
            response.writeHead(200, { "Content-Type": asset.type });
            response.end(request.method === "HEAD" ? undefined : asset.body);
        } catch {
            response.writeHead(503, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: "statistics_unavailable" }));
        }
    });
}
