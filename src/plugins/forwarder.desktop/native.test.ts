/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "assert/strict";

import { ForwardDependencies, ForwardRequest, get, sendWithResilience } from "./native";

function response(status: number, body: string, statusText = "") {
    return new Response(body, {
        status,
        statusText,
        headers: { "Retry-After": "3" },
    });
}

function createDependencies(handler: typeof fetch) {
    const sleeps: number[] = [];
    const logs: Array<{ message: string; detail?: unknown; }> = [];
    const dependencies: ForwardDependencies = {
        fetch: handler,
        sleep: async milliseconds => { sleeps.push(milliseconds); },
        now: () => 100,
        logError: (message, detail) => { logs.push({ message, detail }); },
    };
    return { dependencies, sleeps, logs };
}

function request(overrides: Partial<ForwardRequest> = {}): ForwardRequest {
    return {
        primaryUrl: "https://primary.test/forward",
        fallbackUrl: "https://fallback.test/forward",
        payload: { content: "private Discord message" },
        context: { messageId: "message-1", channelId: "channel-1", guildId: "guild-1" },
        dingTalk: { enabled: false },
        ...overrides,
    };
}

async function main() {
{
    let callCount = 0;
    const { dependencies, sleeps } = createDependencies((async () => {
        callCount++;
        return response(200, "accepted", "OK");
    }) as typeof fetch);

    const result = await sendWithResilience(null as never, request(), dependencies);
    assert.equal(result.ok, true);
    assert.equal(callCount, 1);
    assert.deepEqual(sleeps, []);
}

{
    let callCount = 0;
    const { dependencies, sleeps } = createDependencies((async () => {
        callCount++;
        return callCount < 3 ? response(503, "temporarily unavailable", "Service Unavailable") : response(200, "accepted", "OK");
    }) as typeof fetch);

    const result = await sendWithResilience(null as never, request({
        dingTalk: { enabled: true, webhookUrl: "https://dingtalk.test/hook" },
    }), dependencies);
    assert.equal(result.ok, true);
    assert.equal(result.usedFallback, false);
    assert.equal(callCount, 3);
    assert.deepEqual(sleeps, [1000, 2000]);
    assert.equal(result.attempts?.length, 3);
}

{
    const calledUrls: string[] = [];
    const { dependencies, sleeps } = createDependencies((async input => {
        const url = String(input);
        calledUrls.push(url);
        return url.includes("fallback.test") ? response(200, "fallback accepted", "OK") : response(502, "primary down", "Bad Gateway");
    }) as typeof fetch);

    const result = await sendWithResilience(null as never, request(), dependencies);
    assert.equal(result.ok, true);
    assert.equal(result.usedFallback, true);
    assert.equal(calledUrls.filter(url => url.includes("primary.test")).length, 5);
    assert.equal(calledUrls.filter(url => url.includes("fallback.test")).length, 1);
    assert.deepEqual(sleeps, [1000, 2000, 4000, 5000]);
}

{
    const calledUrls: string[] = [];
    const { dependencies } = createDependencies((async input => {
        calledUrls.push(String(input));
        return response(200, "fallback accepted", "OK");
    }) as typeof fetch);

    const result = await sendWithResilience(null as never, request({ primaryUrl: "" }), dependencies);
    assert.equal(result.ok, true);
    assert.equal(result.usedFallback, true);
    assert.equal(result.attempts?.[0].category, "configuration");
    assert.deepEqual(calledUrls, ["https://fallback.test/forward"]);
}

{
    const calledUrls: string[] = [];
    const alertBodies: string[] = [];
    const connectionCause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:49321"), {
        code: "ECONNREFUSED",
        errno: -61,
        syscall: "connect",
        address: "127.0.0.1",
        port: 49321,
    });
    const fetchFailure = Object.assign(new TypeError("fetch failed"), { cause: connectionCause });
    const { dependencies, sleeps } = createDependencies((async (input, init) => {
        const url = String(input);
        calledUrls.push(url);
        if (url.includes("oapi.dingtalk.com")) {
            alertBodies.push(String(init?.body));
            return response(200, "ok", "OK");
        }
        if (url.includes("fallback.test")) return response(502, "fallback down", "Bad Gateway");
        throw fetchFailure;
    }) as typeof fetch);

    const result = await sendWithResilience(null as never, request({
        primaryUrl: "https://primary.test/forward?token=primary-secret",
        fallbackUrl: "https://fallback.test/forward?key=fallback-secret",
        dingTalk: {
            enabled: true,
            webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=ding-secret",
        },
    }), dependencies);

    assert.equal(result.ok, false);
    assert.equal(result.attempts?.length, 10);
    assert.equal(calledUrls.filter(url => !url.includes("dingtalk")).length, 10);
    assert.equal(calledUrls.filter(url => url.includes("dingtalk")).length, 1);
    assert.deepEqual(sleeps, [1000, 2000, 4000, 5000, 1000, 2000, 4000, 5000]);
    assert.match(result.errorSummary ?? "", /ECONNREFUSED/);
    assert.match(result.errorSummary ?? "", /address=127\.0\.0\.1/);
    assert.match(result.errorSummary ?? "", /port=49321/);
    assert.doesNotMatch(result.errorSummary ?? "", /primary-secret|fallback-secret/);
    assert.equal(alertBodies.length, 1);
    assert.match(alertBodies[0], /Discord forwarder failure/);
    assert.match(alertBodies[0], /rootCause=HTTP 502 Bad Gateway/);
    assert.match(alertBodies[0], /HTTP 502 Bad Gateway × 5/);
    assert.match(alertBodies[0], /ECONNREFUSED connect ECONNREFUSED 127\.0\.0\.1:49321 × 5/);
    assert.equal(alertBodies[0].match(/ECONNREFUSED/g)?.length, 2);
    assert.doesNotMatch(alertBodies[0], /primary=|fallback=|primary\.test|fallback\.test|attempts:|"cause"|"stack"/);
    assert.doesNotMatch(alertBodies[0], /private Discord message|primary-secret|fallback-secret|ding-secret/);
}

{
    let alertBody = "";
    const { dependencies } = createDependencies((async (input, init) => {
        if (String(input).includes("dingtalk.test")) {
            alertBody = String(init?.body);
            return response(200, "ok");
        }
        return response(500, "server echoed private Discord message and token=response-secret");
    }) as typeof fetch);

    const result = await sendWithResilience(null as never, request({
        fallbackUrl: "",
        dingTalk: { enabled: true, webhookUrl: "https://dingtalk.test/hook?access_token=alert-secret" },
    }), dependencies);
    assert.match(alertBody, /Discord forwarder failure/);
    assert.doesNotMatch(alertBody, /private Discord message|response-secret|alert-secret/);
    assert.doesNotMatch(result.body, /private Discord message|response-secret/);
    assert.doesNotMatch(result.errorSummary ?? "", /private Discord message|response-secret/);
    assert.doesNotMatch(JSON.stringify(result.attempts), /private Discord message|response-secret/);
    assert.equal(result.attempts?.[0].responseLength, "server echoed private Discord message and token=response-secret".length);
}

{
    let callCount = 0;
    const { dependencies, sleeps } = createDependencies((async () => {
        callCount++;
        return response(500, "failed");
    }) as typeof fetch);

    const invalid = await sendWithResilience(null as never, request({
        primaryUrl: "not a url",
        fallbackUrl: "",
    }), dependencies);
    assert.equal(invalid.ok, false);
    assert.equal(callCount, 0);
    assert.equal(invalid.attempts?.length, 1);
    assert.equal(invalid.attempts?.[0].category, "configuration");

    const duplicate = await sendWithResilience(null as never, request({
        fallbackUrl: "https://primary.test/forward",
    }), dependencies);
    assert.equal(duplicate.ok, false);
    assert.equal(callCount, 5);
    assert.equal(duplicate.attempts?.length, 5);
    assert.deepEqual(sleeps, [1000, 2000, 4000, 5000]);
}

{
    const logs: string[] = [];
    const dependencies: ForwardDependencies = {
        fetch: (async input => {
            if (String(input).includes("dingtalk")) throw new Error("alert connection failed");
            return response(500, "forward failed");
        }) as typeof fetch,
        sleep: async () => undefined,
        now: () => 0,
        logError: message => { logs.push(message); },
    };

    const result = await sendWithResilience(null as never, request({
        fallbackUrl: "",
        dingTalk: { enabled: true, webhookUrl: "https://dingtalk.test/hook" },
    }), dependencies);
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
    assert.deepEqual(logs, ["DingTalk alert request failed"]);
}

{
    const longBody = "x".repeat(5000);
    const { dependencies } = createDependencies((async () => response(500, longBody)) as typeof fetch);
    const result = await sendWithResilience(null as never, request({ fallbackUrl: "" }), dependencies);
    assert.equal(result.attempts?.[0].body, undefined);
    assert.equal(result.attempts?.[0].responseLength, longBody.length);
}

{
    const longStack = "stack-line\n".repeat(1000);
    const timeout = Object.assign(new Error("request timed out"), {
        name: "AbortError",
        code: "ETIMEDOUT",
        stack: longStack,
    });
    const { dependencies } = createDependencies((async (_input, init) => {
        assert.ok(init?.signal);
        throw timeout;
    }) as typeof fetch);
    const result = await sendWithResilience(null as never, request({ fallbackUrl: "" }), dependencies);
    assert.equal(result.attempts?.[0].category, "timeout");
    assert.ok((result.attempts?.[0].error?.stack?.length ?? Infinity) < longStack.length);
}

{
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async (_input, init) => {
        callCount++;
        assert.equal(init?.method, "GET");
        assert.ok(init?.signal);
        return response(200, "healthy", "OK");
    }) as typeof fetch;
    try {
        const result = await get(null as never, "https://primary.test/healthz");
        assert.equal(result.ok, true);
        assert.equal(result.body, "healthy");
        assert.equal(callCount, 1);
        assert.equal(result.attempts, undefined);
    } finally {
        globalThis.fetch = originalFetch;
    }
}
}

void main();
