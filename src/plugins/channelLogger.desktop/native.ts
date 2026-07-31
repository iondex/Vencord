/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

export interface LoggerRequestResult {
    ok: boolean;
    status: number;
    body: string;
}

function localHttpUrl(value: string) {
    const url = new URL(value);
    if (url.protocol !== "http:") throw new Error("Logger URL must use HTTP");
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
        throw new Error("Logger URL must point to the local machine");
    }
    return url;
}

async function request(url: string, init?: RequestInit): Promise<LoggerRequestResult> {
    try {
        const target = localHttpUrl(url);
        const response = await fetch(target, {
            ...init,
            headers: {
                "User-Agent": "Vencord-channel-logger",
                ...init?.headers,
            },
            signal: AbortSignal.timeout(15_000),
        });

        return {
            ok: response.ok,
            status: response.status,
            body: await response.text(),
        };
    } catch (error) {
        return { ok: false, status: -1, body: error instanceof Error ? error.message : String(error) };
    }
}

export function get(_: IpcMainInvokeEvent, url: string) {
    return request(url);
}

export function post(_: IpcMainInvokeEvent, url: string, payload: unknown) {
    return request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}
