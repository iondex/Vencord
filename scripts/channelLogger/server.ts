/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";

import { ChannelLogRecord, ChannelLogStore } from "./storage";

interface ServerOptions {
    store: ChannelLogStore;
    maxBodyBytes?: number;
    log?: (message: string) => void;
}

class HttpError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
    });
    response.end(body);
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number) {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBodyBytes) {
            tooLarge = true;
            continue;
        }
        chunks.push(buffer);
    }

    if (tooLarge) {
        throw new HttpError(413, "request_too_large", `Request body exceeds ${maxBodyBytes} bytes`);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
    }
}

function isTimestamp(value: unknown): value is string {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validateRecords(channelId: string, body: unknown): ChannelLogRecord[] {
    if (!body || typeof body !== "object" || !Array.isArray((body as any).records)) {
        throw new HttpError(400, "invalid_request", "Body must contain a records array");
    }

    return (body as any).records.map((record: any, index: number) => {
        if (!record || typeof record !== "object") {
            throw new HttpError(400, "invalid_request", `records[${index}] must be an object`);
        }
        if ((record.type !== "message" && record.type !== "delete")
            || typeof record.messageId !== "string"
            || !/^\d{1,32}$/.test(record.messageId)
            || !isTimestamp(record.observedAt)) {
            throw new HttpError(400, "invalid_request", `records[${index}] has invalid metadata`);
        }

        if (record.type === "delete") {
            return {
                type: "delete",
                messageId: record.messageId,
                observedAt: record.observedAt,
            };
        }

        if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
            throw new HttpError(400, "invalid_request", `records[${index}].payload must be an object`);
        }
        const payloadChannelId = record.payload.channel_id ?? record.payload.channelId;
        if (String(record.payload.id) !== record.messageId || String(payloadChannelId) !== channelId) {
            throw new HttpError(400, "invalid_request", `records[${index}] does not belong to channel ${channelId}`);
        }

        return {
            type: "message",
            messageId: record.messageId,
            observedAt: record.observedAt,
            payload: record.payload,
        };
    });
}

export async function writeChunk(response: ServerResponse, chunk: string) {
    if (response.write(chunk)) return;

    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            response.off("drain", onDrain);
            response.off("close", onClose);
            response.off("error", onError);
        };
        const onDrain = () => {
            cleanup();
            resolve();
        };
        const onClose = () => {
            cleanup();
            reject(new Error("Download connection closed"));
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };

        response.once("drain", onDrain);
        response.once("close", onClose);
        response.once("error", onError);
    });
}

async function streamDownload(response: ServerResponse, store: ChannelLogStore, channelId: string) {
    const status = store.status(channelId);
    const exportedAt = new Date().toISOString();
    const filename = `channel-${channelId}-${exportedAt.slice(0, 10)}.json`;
    response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
    });

    await writeChunk(response, `{"export":${JSON.stringify({
        format: "vencord-channel-log",
        version: 1,
        exportedAt,
        channelId,
        order: "newest-first",
        payloadKind: "discord-client-message-record",
        completeness: "visible-loaded-messages-only",
        messageCount: status.messageCount,
        deletedCount: status.deletedCount,
    })},"messages":[`);

    let separator = "";
    for (const message of store.exportMessages(channelId)) {
        await writeChunk(response, separator + JSON.stringify(message));
        separator = ",";
    }
    await writeChunk(response, `],"messageVersions":[`);
    separator = "";
    for (const version of store.exportVersions(channelId)) {
        await writeChunk(response, separator + JSON.stringify(version));
        separator = ",";
    }
    response.end("]}");
}

export function createChannelLoggerServer({
    store,
    maxBodyBytes = 1024 * 1024,
    log = () => undefined,
}: ServerOptions): Server {
    return createServer(async (request, response) => {
        const startedAt = performance.now();
        const method = request.method ?? "GET";
        const url = new URL(request.url ?? "/", "http://127.0.0.1");

        try {
            if (method === "GET" && url.pathname === "/api/health") {
                sendJson(response, 200, { ok: true, service: "vencord-channel-logger", version: 1 });
                return;
            }

            const match = /^\/api\/channels\/(\d{1,32})\/(log|status|download)$/.exec(url.pathname);
            if (!match) throw new HttpError(404, "not_found", "Endpoint not found");
            const [, channelId, action] = match;

            if (method === "POST" && action === "log") {
                if (request.headers.origin != null) {
                    throw new HttpError(403, "forbidden_origin", "Browser-originated writes are not allowed");
                }
                const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
                if (contentType !== "application/json") {
                    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
                }
                const body = await readJsonBody(request, maxBodyBytes);
                const records = validateRecords(channelId, body);
                const result = store.log(channelId, records);
                sendJson(response, 200, { ok: true, ...result });
                log(`POST channel=${channelId} records=${records.length} durationMs=${(performance.now() - startedAt).toFixed(1)}`);
                return;
            }
            if (method === "GET" && action === "status") {
                sendJson(response, 200, store.status(channelId));
                return;
            }
            if (method === "GET" && action === "download") {
                await streamDownload(response, store, channelId);
                log(`GET download channel=${channelId} durationMs=${(performance.now() - startedAt).toFixed(1)}`);
                return;
            }

            throw new HttpError(405, "method_not_allowed", "Method not allowed");
        } catch (error) {
            const httpError = error instanceof HttpError
                ? error
                : new HttpError(500, "internal_error", error instanceof Error ? error.message : String(error));
            log(`${method} ${url.pathname} status=${httpError.status} error=${httpError.message}`);
            if (!response.headersSent) {
                sendJson(response, httpError.status, {
                    ok: false,
                    error: httpError.code,
                    message: httpError.message,
                });
            } else {
                response.destroy(error instanceof Error ? error : undefined);
            }
        }
    });
}
