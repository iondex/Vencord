/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

export interface ForwardResult {
    ok: boolean;
    status: number;
    body: string;
}

export async function get(_: IpcMainInvokeEvent, url: string): Promise<ForwardResult> {
    try {
        const target = new URL(url);
        if (target.protocol !== "http:" && target.protocol !== "https:") {
            return { ok: false, status: -1, body: "Forwarder URL must use http or https" };
        }

        const response = await fetch(target, {
            method: "GET",
            headers: {
                "User-Agent": "Vencord-forwarder"
            }
        });

        return {
            ok: response.ok,
            status: response.status,
            body: await response.text()
        };
    } catch (error) {
        return {
            ok: false,
            status: -1,
            body: String(error)
        };
    }
}

export async function send(_: IpcMainInvokeEvent, url: string, payload: unknown): Promise<ForwardResult> {
    try {
        const target = new URL(url);
        if (target.protocol !== "http:" && target.protocol !== "https:") {
            return { ok: false, status: -1, body: "Forwarder URL must use http or https" };
        }

        const response = await fetch(target, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Vencord-forwarder"
            },
            body: JSON.stringify(payload)
        });

        return {
            ok: response.ok,
            status: response.status,
            body: await response.text()
        };
    } catch (error) {
        return {
            ok: false,
            status: -1,
            body: String(error)
        };
    }
}
