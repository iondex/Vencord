/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createChannelLoggerServer, writeChunk } from "./server";
import { ChannelLogStore } from "./storage";

async function main() {
    const directory = await mkdtemp(join(tmpdir(), "vencord-channel-logger-http-"));
    const store = new ChannelLogStore(directory, () => "2026-07-31T14:00:00.000Z");
    const server = createChannelLoggerServer({ store, maxBodyBytes: 1024 });

    try {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const healthResponse = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
        ok: true,
        service: "vencord-channel-logger",
        version: 1,
    });

    const postResponse = await fetch(`${baseUrl}/api/channels/10/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            records: [
                {
                    type: "message",
                    messageId: "100",
                    observedAt: "2026-07-31T12:00:00.000Z",
                    payload: { id: "100", channel_id: "10", content: "older" }
                },
                {
                    type: "message",
                    messageId: "101",
                    observedAt: "2026-07-31T12:01:00.000Z",
                    payload: { id: "101", channel_id: "10", content: "newer" }
                }
            ]
        })
    });
    assert.equal(postResponse.status, 200);
    assert.deepEqual(await postResponse.json(), {
        ok: true,
        received: 2,
        inserted: 2,
        updated: 0,
        duplicates: 0,
        deleted: 0,
        ignoredDeletes: 0,
    });

    const statusResponse = await fetch(`${baseUrl}/api/channels/10/status`);
    assert.equal(statusResponse.status, 200);
    assert.deepEqual(await statusResponse.json(), {
        channelId: "10",
        messageCount: 2,
        versionCount: 2,
        deletedCount: 0,
        duplicateCount: 0,
        firstObservedAt: "2026-07-31T12:00:00.000Z",
        lastObservedAt: "2026-07-31T12:01:00.000Z",
        lastWriteAt: "2026-07-31T14:00:00.000Z",
    });

    const downloadResponse = await fetch(`${baseUrl}/api/channels/10/download`);
    assert.equal(downloadResponse.status, 200);
    assert.match(downloadResponse.headers.get("content-disposition") ?? "", /^attachment; filename="channel-10-/);
    const download = await downloadResponse.json() as any;
    assert.equal(download.export.order, "newest-first");
    assert.equal(download.export.payloadKind, "discord-client-message-record");
    assert.deepEqual(download.messages.map((item: any) => item.payload.id), ["101", "100"]);
    assert.deepEqual(download.messageVersions.map((item: any) => item.payload.id), ["101", "100"]);

    const oversizedResponse = await fetch(`${baseUrl}/api/channels/10/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: [{ padding: "x".repeat(2048) }] })
    });
    assert.equal(oversizedResponse.status, 413);
    assert.deepEqual(await oversizedResponse.json(), {
        ok: false,
        error: "request_too_large",
        message: "Request body exceeds 1024 bytes"
    });

    const invalidResponse = await fetch(`${baseUrl}/api/channels/10/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: [{ type: "message", messageId: "wrong-channel", payload: { channel_id: "11" } }] })
    });
    assert.equal(invalidResponse.status, 400);
    assert.equal((await invalidResponse.json() as any).error, "invalid_request");

    const textResponse = await fetch(`${baseUrl}/api/channels/10/log`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ records: [] })
    });
    assert.equal(textResponse.status, 415);
    assert.equal((await textResponse.json() as any).error, "unsupported_media_type");

    const originResponse = await fetch(`${baseUrl}/api/channels/10/log`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Origin": "https://example.com",
        },
        body: JSON.stringify({ records: [] })
    });
    assert.equal(originResponse.status, 403);
    assert.equal((await originResponse.json() as any).error, "forbidden_origin");

    const disconnected = new EventEmitter() as EventEmitter & { write(chunk: string): boolean; };
    disconnected.write = () => false;
    const pendingWrite = writeChunk(disconnected as any, "large chunk");
    disconnected.emit("close");
    await assert.rejects(pendingWrite, /closed/);

    const drained = new EventEmitter() as EventEmitter & { write(chunk: string): boolean; };
    drained.write = () => false;
    const drainedWrite = writeChunk(drained as any, "large chunk");
    drained.emit("drain");
    await drainedWrite;
    assert.equal(drained.listenerCount("close"), 0);
    assert.equal(drained.listenerCount("error"), 0);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
        store.close();
        await rm(directory, { recursive: true, force: true });
    }
}

void main();
