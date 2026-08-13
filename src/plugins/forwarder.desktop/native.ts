/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";

const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 5000] as const;
const MAX_BODY_LENGTH = 2000;
const MAX_STACK_LENGTH = 4000;
const MAX_ALERT_LENGTH = 16000;
const REQUEST_TIMEOUT_MS = 30000;
const SENSITIVE_QUERY_KEYS = /^(?:access_token|token|key|secret|api_?key)$/i;

export interface ForwardContext {
    messageId?: string;
    channelId?: string;
    guildId?: string | null;
}

export interface ForwardRequest {
    primaryUrl: string;
    fallbackUrl?: string;
    payload: unknown;
    context?: ForwardContext;
    dingTalk?: {
        enabled: boolean;
        webhookUrl?: string;
    };
}

export interface SerializedError {
    name?: string;
    message: string;
    code?: string;
    errno?: string | number;
    syscall?: string;
    hostname?: string;
    address?: string;
    port?: string | number;
    stack?: string;
    cause?: SerializedError;
}

export type FailureCategory = "configuration" | "serialization" | "dns" | "connection" | "timeout" | "tls" | "http" | "network" | "unknown";

export interface AttemptDiagnostic {
    role: "primary" | "fallback";
    url: string;
    attempt: number;
    maxAttempts: number;
    durationMs: number;
    category?: FailureCategory;
    status?: number;
    statusText?: string;
    body?: string;
    responseLength?: number;
    retryAfter?: string;
    error?: SerializedError;
}

export interface ForwardResult {
    ok: boolean;
    status: number;
    body: string;
    attempts?: AttemptDiagnostic[];
    usedFallback?: boolean;
    errorSummary?: string;
    durationMs?: number;
}

export interface ForwardDependencies {
    fetch: typeof fetch;
    sleep(milliseconds: number): Promise<void>;
    now(): number;
    logError(message: string, detail?: unknown): void;
}

const defaultDependencies: ForwardDependencies = {
    fetch: globalThis.fetch,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    now: () => Date.now(),
    logError: (message, detail) => console.error(`[forwarder] ${message}`, detail ?? ""),
};

function excerpt(value: string, maxLength = MAX_BODY_LENGTH) {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`;
}

function errorField(value: unknown, key: string) {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
}

function optionalString(value: unknown) {
    return typeof value === "string" && value ? value : undefined;
}

function optionalStringOrNumber(value: unknown) {
    return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function redactSensitiveText(value: string) {
    return value.replace(/([?&](?:access_token|token|key|secret|api_?key)=)[^&#\s"']*/gi, "$1[REDACTED]");
}

function serializeError(error: unknown, depth = 0, seen = new WeakSet<object>()): SerializedError {
    if (depth > 5) return { message: "[cause depth exceeded]" };
    if (typeof error !== "object" || error === null) return { message: String(error) };
    if (seen.has(error)) return { message: "[circular error cause]" };
    seen.add(error);

    const message = redactSensitiveText(optionalString(errorField(error, "message")) ?? String(error));
    const stack = optionalString(errorField(error, "stack"));
    const cause = errorField(error, "cause");

    return {
        name: optionalString(errorField(error, "name")),
        message,
        code: optionalString(errorField(error, "code")),
        errno: optionalStringOrNumber(errorField(error, "errno")),
        syscall: optionalString(errorField(error, "syscall")),
        hostname: optionalString(errorField(error, "hostname")),
        address: optionalString(errorField(error, "address")),
        port: optionalStringOrNumber(errorField(error, "port")),
        stack: stack ? excerpt(redactSensitiveText(stack), MAX_STACK_LENGTH) : undefined,
        cause: cause === undefined ? undefined : serializeError(cause, depth + 1, seen),
    };
}

function flattenErrors(error: SerializedError | undefined) {
    const errors: SerializedError[] = [];
    let current = error;
    while (current) {
        errors.push(current);
        current = current.cause;
    }
    return errors;
}

function classifyFailure(error: SerializedError): FailureCategory {
    const errors = flattenErrors(error);
    const codes = errors.map(item => item.code?.toUpperCase()).filter(Boolean);
    const text = errors.map(item => `${item.name ?? ""} ${item.message}`).join(" ").toLowerCase();

    if (codes.some(code => code === "ENOTFOUND" || code === "EAI_AGAIN")) return "dns";
    if (codes.some(code => code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") || /timed out|timeout|aborterror/.test(text)) return "timeout";
    if (codes.some(code => code?.startsWith("ERR_TLS_") || code?.includes("CERT")) || /certificate|tls|ssl/.test(text)) return "tls";
    if (codes.some(code => code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE")) return "connection";
    if (text.includes("fetch") || text.includes("network")) return "network";
    return "unknown";
}

function redactUrl(value: string) {
    try {
        const url = new URL(value);
        for (const key of [...url.searchParams.keys()]) {
            if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.set(key, "[REDACTED]");
        }
        return url.toString();
    } catch {
        return redactSensitiveText(value);
    }
}

type ParsedHttpUrl = { ok: true; url: URL; } | { ok: false; error: string; };

function parseHttpUrl(value: string): ParsedHttpUrl {
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return { ok: false, error: `Forwarder URL must use http or https (received ${url.protocol})` };
        }
        return { ok: true, url };
    } catch (error) {
        return { ok: false, error: `Invalid forwarder URL: ${serializeError(error).message}` };
    }
}

function diagnosticLine(diagnostic: AttemptDiagnostic) {
    const prefix = `${diagnostic.role} ${diagnostic.attempt}/${diagnostic.maxAttempts} ${diagnostic.url}`;
    if (diagnostic.status !== undefined) {
        const response = diagnostic.body ? ` response=${JSON.stringify(diagnostic.body)}` : "";
        const responseLength = diagnostic.responseLength === undefined ? "" : ` responseLength=${diagnostic.responseLength}`;
        const retryAfter = diagnostic.retryAfter ? ` retryAfter=${diagnostic.retryAfter}` : "";
        return `${prefix}: HTTP ${diagnostic.status}${diagnostic.statusText ? ` ${diagnostic.statusText}` : ""} duration=${diagnostic.durationMs}ms${retryAfter}${responseLength}${response}`;
    }

    const errors = flattenErrors(diagnostic.error);
    const details = errors.map(item => {
        const fields = [item.name, item.code, item.message];
        if (item.errno !== undefined) fields.push(`errno=${item.errno}`);
        if (item.syscall) fields.push(`syscall=${item.syscall}`);
        if (item.hostname) fields.push(`hostname=${item.hostname}`);
        if (item.address) fields.push(`address=${item.address}`);
        if (item.port !== undefined) fields.push(`port=${item.port}`);
        return fields.filter(Boolean).join(" ");
    }).join(" <- ");
    return `${prefix}: ${diagnostic.category ?? "unknown"} ${details || "request failed"} duration=${diagnostic.durationMs}ms`;
}

function buildErrorSummary(attempts: AttemptDiagnostic[]) {
    return attempts.map(diagnosticLine).join("\n");
}

function dingTalkDiagnosticLine(diagnostic: AttemptDiagnostic) {
    const prefix = `${diagnostic.role} ${diagnostic.attempt}/${diagnostic.maxAttempts} ${diagnostic.url}`;
    if (diagnostic.status !== undefined) {
        const retryAfter = diagnostic.retryAfter ? ` retryAfter=${diagnostic.retryAfter}` : "";
        return `${prefix}: HTTP ${diagnostic.status}${diagnostic.statusText ? ` ${diagnostic.statusText}` : ""} duration=${diagnostic.durationMs}ms${retryAfter}`;
    }

    const causes = flattenErrors(diagnostic.error).map(item => [
        item.name,
        item.code,
        item.message,
        item.errno === undefined ? undefined : `errno=${item.errno}`,
        item.syscall ? `syscall=${item.syscall}` : undefined,
        item.hostname ? `hostname=${item.hostname}` : undefined,
        item.address ? `address=${item.address}` : undefined,
        item.port === undefined ? undefined : `port=${item.port}`,
    ].filter(Boolean).join(" ")).join(" <- ");
    return `${prefix}: ${diagnostic.category ?? "unknown"} ${causes || "request failed"} duration=${diagnostic.durationMs}ms`;
}

async function attemptEndpoint(
    role: AttemptDiagnostic["role"],
    target: URL,
    payloadBody: string,
    dependencies: ForwardDependencies,
) {
    const attempts: AttemptDiagnostic[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const startedAt = dependencies.now();
        try {
            const response = await dependencies.fetch(target.toString(), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "Vencord-forwarder",
                },
                body: payloadBody,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            const responseBody = await response.text();
            const body = response.ok ? excerpt(responseBody) : undefined;
            const diagnostic: AttemptDiagnostic = {
                role,
                url: redactUrl(target.toString()),
                attempt,
                maxAttempts: MAX_ATTEMPTS,
                durationMs: Math.max(0, dependencies.now() - startedAt),
                status: response.status,
                statusText: response.statusText,
                body,
                responseLength: responseBody.length,
                retryAfter: response.headers.get("Retry-After") ?? undefined,
                category: response.ok ? undefined : "http",
            };
            attempts.push(diagnostic);

            if (response.ok) return { ok: true as const, status: response.status, body: body ?? "", attempts };
        } catch (error) {
            const serializedError = serializeError(error);
            attempts.push({
                role,
                url: redactUrl(target.toString()),
                attempt,
                maxAttempts: MAX_ATTEMPTS,
                durationMs: Math.max(0, dependencies.now() - startedAt),
                category: classifyFailure(serializedError),
                error: serializedError,
            });
        }

        if (attempt < MAX_ATTEMPTS) await dependencies.sleep(RETRY_DELAYS_MS[attempt - 1]);
    }

    const lastAttempt = attempts.at(-1)!;
    return {
        ok: false as const,
        status: lastAttempt.status ?? -1,
        body: lastAttempt.error?.message ?? `HTTP ${lastAttempt.status ?? "failure"}${lastAttempt.statusText ? ` ${lastAttempt.statusText}` : ""}`,
        attempts,
    };
}

function configurationDiagnostic(role: AttemptDiagnostic["role"], value: string, message: string): AttemptDiagnostic {
    return {
        role,
        url: redactUrl(value),
        attempt: 1,
        maxAttempts: 1,
        durationMs: 0,
        category: "configuration",
        error: { name: "ConfigurationError", message },
    };
}

function buildDingTalkContent(request: ForwardRequest, attempts: AttemptDiagnostic[], now: number) {
    const context = request.context ?? {};
    const finalAttempt = attempts.at(-1);
    const rootCause = finalAttempt?.error
        ? JSON.stringify(finalAttempt.error)
        : finalAttempt?.status !== undefined
            ? `HTTP ${finalAttempt.status}${finalAttempt.statusText ? ` ${finalAttempt.statusText}` : ""}`
            : "unknown";
    const lines = [
        "Discord forwarder failure",
        `time=${new Date(now).toISOString()}`,
        `primary=${redactUrl(request.primaryUrl)}`,
        `fallback=${request.fallbackUrl?.trim() ? redactUrl(request.fallbackUrl.trim()) : "not configured"}`,
        `messageId=${context.messageId ?? "unknown"}`,
        `channelId=${context.channelId ?? "unknown"}`,
        `guildId=${context.guildId ?? "unknown"}`,
        `rootCause=${rootCause}`,
        "attempts:",
        attempts.map(dingTalkDiagnosticLine).join("\n"),
    ];
    return excerpt(lines.join("\n"), MAX_ALERT_LENGTH);
}

async function sendDingTalkAlert(
    request: ForwardRequest,
    attempts: AttemptDiagnostic[],
    dependencies: ForwardDependencies,
) {
    if (!request.dingTalk?.enabled) return;
    const webhookUrl = request.dingTalk.webhookUrl?.trim();
    if (!webhookUrl) {
        dependencies.logError("DingTalk alert skipped: webhook URL is empty");
        return;
    }

    const parsed = parseHttpUrl(webhookUrl);
    if (!parsed.ok) {
        dependencies.logError("DingTalk alert skipped: invalid webhook URL", parsed.error);
        return;
    }

    try {
        const response = await dependencies.fetch(parsed.url.toString(), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Vencord-forwarder",
            },
            body: JSON.stringify({
                msgtype: "text",
                text: { content: buildDingTalkContent(request, attempts, dependencies.now()) },
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
            dependencies.logError(`DingTalk alert failed (${response.status} ${response.statusText})`, excerpt(await response.text()));
        }
    } catch (error) {
        dependencies.logError("DingTalk alert request failed", serializeError(error));
    }
}

export async function sendWithResilience(_: IpcMainInvokeEvent, request: ForwardRequest, dependencies: ForwardDependencies = defaultDependencies): Promise<ForwardResult> {
    const attempts: AttemptDiagnostic[] = [];
    let payloadBody: string;

    try {
        payloadBody = JSON.stringify(request.payload);
    } catch (error) {
        const serializedError = serializeError(error);
        attempts.push({
            role: "primary",
            url: redactUrl(request.primaryUrl),
            attempt: 1,
            maxAttempts: 1,
            durationMs: 0,
            category: "serialization",
            error: serializedError,
        });
        const errorSummary = buildErrorSummary(attempts);
        await sendDingTalkAlert(request, attempts, dependencies);
        return { ok: false, status: -1, body: serializedError.message, attempts, usedFallback: false, errorSummary };
    }

    const primary = parseHttpUrl(request.primaryUrl.trim());
    if (primary.ok) {
        const result = await attemptEndpoint("primary", primary.url, payloadBody, dependencies);
        attempts.push(...result.attempts);
        if (result.ok) return { ...result, attempts, usedFallback: false };
    } else {
        attempts.push(configurationDiagnostic("primary", request.primaryUrl, primary.error));
    }

    const fallbackValue = request.fallbackUrl?.trim();
    if (fallbackValue) {
        const fallback = parseHttpUrl(fallbackValue);
        if (fallback.ok) {
            const duplicatePrimary = primary.ok && primary.url.toString() === fallback.url.toString();
            if (!duplicatePrimary) {
                const result = await attemptEndpoint("fallback", fallback.url, payloadBody, dependencies);
                attempts.push(...result.attempts);
                if (result.ok) return { ...result, attempts, usedFallback: true };
            }
        } else {
            attempts.push(configurationDiagnostic("fallback", fallbackValue, fallback.error));
        }
    }

    const lastAttempt = attempts.at(-1);
    const errorSummary = buildErrorSummary(attempts);
    const result: ForwardResult = {
        ok: false,
        status: lastAttempt?.status ?? -1,
        body: lastAttempt?.body ?? lastAttempt?.error?.message ?? "All forwarder endpoints failed",
        attempts,
        usedFallback: false,
        errorSummary,
    };
    await sendDingTalkAlert(request, attempts, dependencies);
    return result;
}

export async function get(_: IpcMainInvokeEvent, url: string): Promise<ForwardResult> {
    const startedAt = Date.now();
    const parsed = parseHttpUrl(url);
    if (!parsed.ok) {
        return { ok: false, status: -1, body: parsed.error, durationMs: Date.now() - startedAt };
    }

    try {
        const response = await fetch(parsed.url, {
            method: "GET",
            headers: { "User-Agent": "Vencord-forwarder" },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        return {
            ok: response.ok,
            status: response.status,
            body: excerpt(await response.text()),
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        const serializedError = serializeError(error);
        return {
            ok: false,
            status: -1,
            body: diagnosticLine({
                role: "primary",
                url: redactUrl(url),
                attempt: 1,
                maxAttempts: 1,
                durationMs: Date.now() - startedAt,
                category: classifyFailure(serializedError),
                error: serializedError,
            }),
            durationMs: Date.now() - startedAt,
        };
    }
}

export async function send(_: IpcMainInvokeEvent, request: ForwardRequest): Promise<ForwardResult> {
    return sendWithResilience(_, request);
}
