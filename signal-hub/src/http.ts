import { timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";

import { validateCapture } from "../contracts/ingest.js";
import { createLocalRouteTest, localRouteTest, localServiceStatus } from "./diagnostics.js";
import { Store } from "./storage.js";

function authorized(request: IncomingMessage, token: string) {
    if (!token) return true;
    const actual = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
}

export function createHubHttp(store: Store, options: { pairingToken: string; adminToken: string; excludedServerIds?: string[]; maxBodyBytes?: number; log?: (event: string, fields?: any) => void; wake?: () => void; setTestMode?: (enabled: boolean) => void; }) {
    return createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? "/", "http://signal-hub.local");
            if (request.method === "GET" && url.pathname === "/healthz") {
                json(response, 200, { ok: true, service: "signal-hub", protocol: 2 });
                return;
            }
            const ingest = request.method === "POST" && url.pathname === "/forward";
            const local = url.pathname.startsWith("/api/local/");
            if (!authorized(request, ingest || local ? options.pairingToken : options.adminToken)) { json(response, 401, { error: "unauthorized" }); return; }
            if (request.headers.origin) { json(response, 403, { error: "browser_origin_not_allowed" }); return; }
            if (request.method === "GET" && url.pathname === "/api/local/status") {
                json(response, 200, localServiceStatus(store, options.excludedServerIds ?? [])); return;
            }
            if (request.method === "GET" && url.pathname.startsWith("/api/local/tests/")) {
                const requestId = url.pathname.slice("/api/local/tests/".length);
                if (!/^[a-f\d-]{36}$/.test(requestId)) { json(response, 400, { error: "invalid_test_request" }); return; }
                const test = localRouteTest(store, requestId);
                json(response, test ? 200 : 404, test ?? { error: "test_not_found" }); return;
            }
            if (request.method === "GET" && url.pathname === "/api/status") { json(response, 200, store.status()); return; }
            if (request.method === "GET" && url.pathname === "/api/deliveries") {
                const jobId = url.searchParams.get("jobId");
                const messageKey = url.searchParams.get("messageKey");
                if (jobId && !/^[a-f\d]{64}$/.test(jobId)) { json(response, 400, { error: "invalid_job_id" }); return; }
                if (messageKey && !/^discord:\d{1,32}:\d{1,32}:\d{1,32}$/.test(messageKey)) { json(response, 400, { error: "invalid_message_key" }); return; }
                if (jobId && messageKey) { json(response, 400, { error: "ambiguous_lookup" }); return; }
                json(response, 200, jobId ? { attempts: store.db.prepare("SELECT * FROM delivery_attempts WHERE job_id=? ORDER BY id DESC LIMIT 100").all(jobId) }
                    : messageKey ? store.deliveryTrace(messageKey) : { deliveries: store.deliveries() });
                return;
            }
            if (request.method === "POST" && ["/api/pause", "/api/resume"].includes(url.pathname)) {
                store.setMetadata("paused", String(url.pathname === "/api/pause"));
                if (url.pathname === "/api/resume") store.db.prepare("UPDATE jobs SET state='pending' WHERE state='held' AND error='current_safety_or_config_veto'").run();
                json(response, 200, { ok: true });
                return;
            }
            if (request.method === "POST" && ["/api/local/test", "/api/local/test-mode"].includes(url.pathname)) {
                const chunks: Buffer[] = [];
                let bytes = 0;
                for await (const chunk of request) {
                    bytes += Buffer.byteLength(chunk);
                    if (bytes > 4096) { json(response, 413, { error: "body_too_large" }); request.resume(); return; }
                    chunks.push(Buffer.from(chunk));
                }
                let input: any;
                try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json(response, 400, { error: "malformed_json" }); return; }
                if (url.pathname === "/api/local/test-mode") {
                    if (typeof input?.enabled !== "boolean") { json(response, 400, { error: "invalid_test_mode" }); return; }
                    if (options.setTestMode) options.setTestMode(input.enabled);
                    else store.setMetadata("test_mode", String(input.enabled));
                    options.log?.("test_mode_changed", { enabled: input.enabled });
                    json(response, 200, localServiceStatus(store, options.excludedServerIds ?? []));
                    options.wake?.();
                    return;
                }
                if (!input || typeof input.requestId !== "string" || !/^[a-f\d-]{36}$/.test(input.requestId)
                    || typeof input.routeId !== "string" || !input.routeId || input.routeId.length > 512) {
                    json(response, 400, { error: "invalid_test_request" }); return;
                }
                const result = createLocalRouteTest(store, input.requestId, input.routeId, options.excludedServerIds ?? []);
                if (result.error) { json(response, result.status!, { error: result.error }); return; }
                options.log?.("route_test_queued", { requestId: input.requestId, routeId: input.routeId, jobId: result.test!.jobId });
                json(response, 202, result.test);
                options.wake?.();
                return;
            }
            if (!ingest) { json(response, 404, { error: "not_found" }); return; }
            const limit = options.maxBodyBytes ?? 8 * 1024 * 1024;
            const chunks: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of request) {
                bytes += Buffer.byteLength(chunk);
                if (bytes > limit) {
                    const prefix = Buffer.concat([...chunks, Buffer.from(chunk)]).subarray(0, 65_536).toString("utf8");
                    store.db.prepare("INSERT INTO quarantine(reason,raw,created_at) VALUES('body_too_large_prefix',?,?)").run(prefix, Date.now());
                    options.log?.("capture_quarantined", { reason: "body_too_large", bytes });
                    json(response, 413, { error: "body_too_large" }); request.resume(); return;
                }
                chunks.push(Buffer.from(chunk));
            }
            const raw = Buffer.concat(chunks).toString("utf8");
            let envelope: unknown;
            try { envelope = JSON.parse(raw); } catch {
                store.db.prepare("INSERT INTO quarantine(reason,raw,created_at) VALUES('malformed_json',?,?)").run(raw, Date.now());
                options.log?.("capture_quarantined", { reason: "malformed_json", bytes });
                json(response, 400, { error: "malformed_json" }); return;
            }
            if (!validateCapture(envelope)) {
                store.db.prepare("INSERT INTO quarantine(reason,raw,created_at) VALUES('invalid_envelope',?,?)").run(raw, Date.now());
                options.log?.("capture_quarantined", { reason: "invalid_envelope", bytes });
                json(response, 422, { error: "invalid_envelope", schemaVersion: 2 }); return;
            }
            try {
                const ack = store.ingest(envelope, raw);
                options.log?.("capture_committed", { eventId: envelope.eventId, duplicate: ack.duplicate, bytes });
                json(response, 202, ack);
                options.wake?.();
            } catch (error) {
                if (error instanceof Error && error.message === "event_id_conflict") {
                    store.db.prepare("INSERT INTO quarantine(reason,raw,created_at) VALUES('event_id_conflict',?,?)").run(raw, Date.now());
                    options.log?.("capture_quarantined", { eventId: envelope.eventId, reason: "event_id_conflict", bytes });
                    json(response, 409, { error: "event_id_conflict" });
                }
                else throw error;
            }
        } catch {
            options.log?.("http_request_failed");
            if (!response.headersSent) json(response, 503, { error: "storage_or_request_unavailable" });
            else response.end();
        }
    });
}
