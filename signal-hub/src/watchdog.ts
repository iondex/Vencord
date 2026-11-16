import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeDurable } from "./files.js";
import { configureNetwork } from "./network.js";
import { getRuntimeDirectory, loadDingTalkWebhook } from "./runtime.js";

export function createWatchdog(directory: string, webhook: string | undefined, fetcher: typeof fetch = fetch) {
    const statePath = join(directory, "watchdog-state.json");
    let state = { alerted: false, lastSentAt: 0, retryAt: 0, attempts: 0 };
    try {
        const saved = JSON.parse(readFileSync(statePath, "utf8"));
        if (typeof saved.alerted === "boolean" && [saved.lastSentAt, saved.retryAt, saved.attempts].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) state = saved;
    } catch {}
    let failed = 0;
    let working = false;
    function persistState() {
        try { writeDurable(statePath, JSON.stringify(state)); }
        catch { process.stderr.write("signal-hub watchdog state persistence unavailable; notification limits remain in memory\n"); }
    }
    return async function check(now = Date.now()) {
        if (working) return;
        working = true;
        try {
            let healthy = false;
            try {
                const heartbeat = JSON.parse(readFileSync(join(directory, "heartbeat.json"), "utf8"));
                healthy = typeof heartbeat.time === "number" && now - heartbeat.time >= -30_000 && now - heartbeat.time < 120_000;
            } catch {}
            failed = healthy ? 0 : failed + 1;
            if (!webhook || now < state.retryAt || (!healthy && failed < 3) || (healthy && !state.alerted)
                || (!healthy && state.alerted && now - state.lastSentAt < 300_000)) return;
            state.retryAt = now + 30_000;
            persistState();
            try {
                const content = healthy ? "[signal-hub] Service heartbeat recovered"
                    : state.alerted ? "[signal-hub] Service heartbeat is still missing; check the service host"
                        : "[signal-hub] Service heartbeat missing; check the service host";
                const response = await fetcher(webhook, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ msgtype: "text", text: { content } }),
                    signal: AbortSignal.timeout(10_000), redirect: "error",
                });
                if (!response.ok || (await response.json()).errcode !== 0) throw new Error("dingtalk_rejected");
                state.alerted = !healthy;
                state.lastSentAt = now;
                state.attempts = 0;
            } catch {
                state.attempts++;
                state.retryAt = now + Math.min(300_000, 30_000 * 2 ** Math.min(state.attempts - 1, 4));
            }
            persistState();
        } catch { process.stderr.write("signal-hub watchdog state unavailable\n"); }
        finally { working = false; }
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    configureNetwork();
    const directory = getRuntimeDirectory();
    const webhook = loadDingTalkWebhook(directory);
    const check = createWatchdog(directory, webhook);
    console.log(`signal-hub watchdog started; notifications ${webhook ? "enabled" : "disabled"}`);
    await check();
    setInterval(() => { void check(); }, 30_000);
}
