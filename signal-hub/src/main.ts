import { chmodSync,existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { flushAlerts, refreshHealthAlerts } from "./alerts.js";
import { createConfigSync, digest, validateSnapshot } from "./config.js";
import { createDiscordSender } from "./discord.js";
import { writeDurable } from "./files.js";
import { createHubHttp } from "./http.js";
import { createLogger } from "./logging.js";
import { planMessages } from "./queue.js";
import { recoverBotHistory, recoverLogger } from "./reconciliation.js";
import { getRuntimeDirectory, initializeRuntime, loadSecrets, loadSettings } from "./runtime.js";
import { runExtraction } from "./signal.js";
import { openStore } from "./storage.js";

const runtimeDirectory = getRuntimeDirectory();
const command = process.argv[2] ?? "serve";
if (!["init", "serve", "status", "backup"].includes(command)) throw new Error("Use init, serve, status or backup");

if (command === "init") {
    initializeRuntime(runtimeDirectory);
    console.log(`Created settings.json and secrets.json under ${runtimeDirectory}; pairingToken and adminToken default to empty, disabling their respective authentication. Configure the URL in Discord Settings > Vencord > Plugins > forwarder > Local, leave the token empty, then restart Discord. The collector queue directory is automatic.`);
} else {
    const configuration = command === "serve" ? { settings: loadSettings(runtimeDirectory), secrets: loadSecrets(runtimeDirectory) } : undefined;
    const databasePath = join(runtimeDirectory, "db", "signal-hub.sqlite3");
    if (!configuration && !existsSync(databasePath)) throw new Error("No signal-hub database exists; start the service before status or backup");
    const store = openStore(databasePath);
    chmodSync(databasePath, 0o600);
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
    } else if (configuration) {
        const { settings, secrets } = configuration;
        const { excludedServerIds } = settings;
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
        const server = createHubHttp(store, { pairingToken: secrets.pairingToken, adminToken: secrets.adminToken, excludedServerIds, log, wake: tick });
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
    }
}
