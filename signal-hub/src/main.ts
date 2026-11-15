import { randomBytes } from "node:crypto";
import { chmodSync,existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { validateServiceUrl } from "../contracts/ingest.js";
import { flushAlerts, refreshHealthAlerts } from "./alerts.js";
import { createConfigSync, digest, validateSnapshot } from "./config.js";
import { createDiscordSender } from "./discord.js";
import { writeDurable } from "./files.js";
import { createHubHttp } from "./http.js";
import { createLogger } from "./logging.js";
import { planMessages } from "./queue.js";
import { recoverBotHistory, recoverLogger } from "./reconciliation.js";
import { runExtraction } from "./signal.js";
import { openStore } from "./storage.js";

const runtimeDirectory = process.env.SIGNAL_HUB_VAR ?? fileURLToPath(new URL("../var", import.meta.url));
if (!isAbsolute(runtimeDirectory)) throw new Error("SIGNAL_HUB_VAR must be absolute");
mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
const secretsPath = join(runtimeDirectory, "secrets.json");
const settingsPath = join(runtimeDirectory, "settings.json");
const command = process.argv[2] ?? "serve";

if (command === "init") {
    if (existsSync(secretsPath) || existsSync(settingsPath)) throw new Error("Initialization files already exist; preserve existing tokens and settings");
    const host = process.env.SIGNAL_HUB_HOST ?? "127.0.0.1";
    const port = Number(process.env.SIGNAL_HUB_PORT ?? 49321);
    const cfBaseUrl = validateServiceUrl(process.env.SIGNAL_HUB_CF_BASE_URL ?? "https://forwarder.yufeng.run").toString();
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid listen address");
    const connectionHost = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
    const localServerUrl = validateServiceUrl(process.env.SIGNAL_HUB_PUBLIC_URL ?? `http://${connectionHost}:${port}/forward`).toString();
    const pairingToken = randomBytes(32).toString("hex");
    const adminToken = randomBytes(32).toString("hex");
    writeDurable(secretsPath, JSON.stringify({ pairingToken, adminToken, botToken: "", modelApiKey: "", cfToken: "", dingTalkWebhook: "", webhooks: {} }, null, 4));
    writeDurable(settingsPath, JSON.stringify({ host, port, cfBaseUrl, excludedServerIds: [], loggerDatabase: "", recoveryAccountId: "", botHistoryEnabled: false }, null, 4));
    writeDurable(join(runtimeDirectory, "plugin-connection.json"), JSON.stringify({ localServerUrl, localRuntimeDirectory: runtimeDirectory, localPairingToken: pairingToken, excludedServerIds: "" }, null, 4));
    console.log(`Created private configuration under ${runtimeDirectory}; copy the plugin connection fields into forwarder settings. Set mode to local after configuration.`);
} else {
    if (!existsSync(settingsPath) || !existsSync(secretsPath)) throw new Error("Run pnpm --dir signal-hub run init first");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.host = process.env.SIGNAL_HUB_HOST ?? settings.host;
    settings.port = Number(process.env.SIGNAL_HUB_PORT ?? settings.port);
    settings.cfBaseUrl = process.env.SIGNAL_HUB_CF_BASE_URL ?? settings.cfBaseUrl;
    const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
    secrets.botToken = process.env.DISCORD_BOT_TOKEN || secrets.botToken;
    secrets.modelApiKey = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY || secrets.modelApiKey;
    secrets.cfToken = process.env.SIGNAL_HUB_CF_TOKEN || secrets.cfToken;
    secrets.dingTalkWebhook = process.env.DINGTALK_WEBHOOK || secrets.dingTalkWebhook;
    const excludedServerIds: string[] = settings.excludedServerIds;
    if (!Array.isArray(excludedServerIds) || excludedServerIds.some(id => !/^\d{1,32}$/.test(id))) throw new Error("Invalid excludedServerIds");
    const store = openStore(join(runtimeDirectory, "db", "signal-hub.sqlite3"));
    chmodSync(join(runtimeDirectory, "db", "signal-hub.sqlite3"), 0o600);
    const log = createLogger(join(runtimeDirectory, "logs"));
    if (command === "backup") {
        const directory = join(runtimeDirectory, "backups");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `signal-hub-${Date.now()}.sqlite3`);
        store.db.prepare("VACUUM INTO ?").run(path);
        chmodSync(path, 0o600);
        const verification = new DatabaseSync(path, { readOnly: true });
        try {
            if ((verification.prepare("PRAGMA integrity_check").get() as any).integrity_check !== "ok") throw new Error("Backup integrity check failed");
            const through = (verification.prepare("SELECT max(received_at) AS time FROM receipts").get() as any).time;
            writeDurable(`${path}.json`, JSON.stringify({ verifiedAt: Date.now(), receiptsThrough: through }));
        } finally { verification.close(); }
        store.setMetadata("last_backup_at", String(Date.now()));
        console.log(`Created SQLite backup ${path}`);
        store.close();
    } else if (command === "status") {
        console.log(JSON.stringify(store.status(), null, 2));
        store.close();
    } else if (command === "serve") {
        if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535 || typeof settings.host !== "string") throw new Error("Invalid listen address");
        if (typeof secrets.pairingToken !== "string" || secrets.pairingToken.length < 24 || typeof secrets.adminToken !== "string" || secrets.adminToken.length < 24 || secrets.adminToken === secrets.pairingToken) throw new Error("Pairing and admin tokens must be distinct and at least 24 characters");
        validateServiceUrl(settings.cfBaseUrl);
        let stopping = false;
        const sender = createDiscordSender(store, secrets, excludedServerIds);
        const cachePath = join(runtimeDirectory, "cache", "last-good.json");
        try {
            try { store.config(); } catch { store.setMetadata("config_hash", ""); }
            if (!store.config() && existsSync(cachePath)) {
                const cached = JSON.parse(readFileSync(cachePath, "utf8"));
                if (digest(cached.body) !== cached.hash) throw new Error("invalid_cache_hash");
                store.installConfig(validateSnapshot(JSON.parse(cached.body)), Number(cached.syncedAt ?? 0));
            }
        } catch { store.alert("config_cache", "Configuration cache could not be verified; incoming messages will wait for valid configuration", "critical"); }
        const sync = createConfigSync(settings.cfBaseUrl, secrets.cfToken, snapshot => {
            if (stopping) return;
            const cached = store.installConfig(snapshot);
            writeDurable(cachePath, JSON.stringify(cached));
            store.resolveAlert("config_sync");
            store.resolveAlert("config_cache");
        }, event => {
            if (stopping) return;
            log(event);
            if (event !== "config_sync_ok" && !store.metadata("config_hash")) store.alert("config_sync", "Cloudflare configuration refresh failed without a valid local snapshot; incoming messages remain archived", "critical");
        });
        const tasks = new Set<Promise<unknown>>();
        function background(event: string, work: () => Promise<unknown> | unknown) {
            const task = Promise.resolve().then(work).then(result => { store.resolveAlert(event); return result; }).catch(() => {
                log(event);
                try { store.alert(event, `${event}; work is retained for inspection`, ["delivery_worker_failed", "delivery_repair_failed", "health_monitor_failed"].includes(event) ? "critical" : "warning"); } catch { log("alert_storage_failed"); }
            }).finally(() => tasks.delete(task));
            tasks.add(task);
            return task;
        }
        let deliveryWorkers = 0;
        let extracting = false;
        let preferSignal = false;
        let lastSchedulerError = 0;
        function tick() {
            if (stopping) return;
            try {
                store.recoverLeases();
                planMessages(store, excludedServerIds);
                if (store.metadata("paused") === "true") return;
                while (deliveryWorkers < 4) {
                    const job = preferSignal ? store.claim("signal") ?? store.claim("deliver") : store.claim("deliver") ?? store.claim("signal");
                    if (!job) break;
                    preferSignal = !preferSignal;
                    deliveryWorkers++;
                    const startedAt = Date.now();
                    void background("delivery_worker_failed", () => sender.send(job)).finally(() => {
                        deliveryWorkers--;
                        try {
                            const state = store.db.prepare("SELECT state,error FROM jobs WHERE id=?").get(job.id) as any;
                            log("delivery_finished", { jobId: job.id, kind: job.kind, target: job.target, attempts: job.attempts, state: state.state, code: state.error, durationMs: Date.now() - startedAt });
                        } catch { log("delivery_status_unavailable"); }
                    });
                }
                if (!extracting) {
                    const job = store.claim("extract");
                    if (job) {
                        extracting = true;
                        void background("extraction_worker_failed", () => runExtraction(store, job, secrets.modelApiKey, excludedServerIds)).finally(() => { extracting = false; });
                    }
                }
                if (lastSchedulerError) { store.resolveAlert("scheduler_failed"); lastSchedulerError = 0; }
            } catch {
                if (Date.now() - lastSchedulerError > 5000) {
                    log("scheduler_failed");
                    try { store.alert("scheduler_failed", "The delivery scheduler is failing; archived work is retained", "critical"); } catch {}
                    lastSchedulerError = Date.now();
                }
            }
        }
        const server = createHubHttp(store, { pairingToken: secrets.pairingToken, adminToken: secrets.adminToken, log, wake: tick });
        server.requestTimeout = 30_000;
        server.headersTimeout = 15_000;
        const intervals: ReturnType<typeof setInterval>[] = [];
        function every(milliseconds: number, event: string, work: () => Promise<unknown> | unknown) {
            let running = false;
            intervals.push(setInterval(() => {
                if (stopping || running) return;
                running = true;
                void background(event, work).finally(() => { running = false; });
            }, milliseconds));
        }
        server.on("error", () => { log("listen_failed"); void shutdown(); process.exitCode = 1; });
        server.listen(settings.port, settings.host, () => {
            log("hub_started", { host: settings.host, port: settings.port });
            tick();
            void background("config_sync_failed", sync);
            intervals.push(setInterval(tick, 250));
            every(300_000, "config_sync_failed", sync);
            every(10_000, "alert_worker_failed", () => flushAlerts(store, secrets.dingTalkWebhook));
            every(60_000, "delivery_reconciliation_failed", () => sender.reconcile());
            every(60_000, "delivery_repair_failed", () => {
                if (store.metadata("paused") === "true") return;
                const recovered = store.recoverDeliveries();
                if (recovered) log("delivery_repair_scheduled", { jobs: Number(recovered) });
                tick();
            });
            every(60_000, "logger_recovery_failed", () => {
                if (settings.recoveryAccountId && settings.loggerDatabase) recoverLogger(store, resolve(settings.loggerDatabase), settings.recoveryAccountId, excludedServerIds);
            });
            every(60_000, "bot_history_recovery_failed", async () => {
                if (settings.recoveryAccountId && settings.botHistoryEnabled && secrets.botToken) await recoverBotHistory(store, secrets.botToken, settings.recoveryAccountId, excludedServerIds);
            });
            every(60_000, "history_coverage_check_failed", () => {
                if (!settings.recoveryAccountId || (!settings.loggerDatabase && !settings.botHistoryEnabled)) store.alert("history_coverage_degraded", "No independent history recovery source is configured; durable live handoff remains active");
                else store.resolveAlert("history_coverage_degraded");
            });
            every(30_000, "health_monitor_failed", () => {
                refreshHealthAlerts(store);
                writeDurable(join(runtimeDirectory, "heartbeat.json"), JSON.stringify({ time: Date.now(), pid: process.pid }));
            });
        });
        async function shutdown() {
            if (stopping) return;
            stopping = true;
            for (const interval of intervals) clearInterval(interval);
            await new Promise<void>(resolveClose => { server.close(() => resolveClose()); server.closeIdleConnections(); });
            await Promise.allSettled([...tasks]);
            log("hub_stopped");
            store.close();
        }
        process.once("SIGINT", () => { void shutdown(); });
        process.once("SIGTERM", () => { void shutdown(); });
    } else { store.close(); throw new Error("Use init, serve, status or backup"); }
}
