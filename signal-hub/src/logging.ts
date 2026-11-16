import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";

import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

type LogFields = Record<string, string | number | boolean | null>;

function levelFor(event: string, fields: LogFields) {
    if (event === "capture_committed") return "debug";
    if (event === "message_planned") {
        if (fields.state === "route_conflict") return "error";
        return ["waiting_config", "safety_pending"].includes(String(fields.state)) ? "warn" : "debug";
    }
    if (event === "delivery_finished") return ["uncertain", "dead"].includes(String(fields.state)) ? "error" : "warn";
    if (/failed|unavailable/.test(event)) return "error";
    if (/quarantined|using_cache/.test(event)) return "warn";
    return "info";
}

function consoleMessage(event: string, fields: Record<string, unknown>) {
    const labels: Record<string, string> = {
        hub_started: "Hub started", hub_stopped: "Hub stopped", config_sync_ok: "Configuration synced",
        config_sync_failed_using_cache: "Configuration sync failed; using cache", capture_committed: "Capture saved",
        capture_quarantined: "Capture quarantined", message_planned: "Message planned", delivery_sent: "Delivered",
        delivery_finished: "Delivery pending", delivery_repair_scheduled: "Delivery repair scheduled", route_test_queued: "Route test queued",
        test_mode_changed: "Test mode changed",
    };
    const states: Record<string, string> = {
        pending: "queued", leased: "preparing", sending: "sending", sent: "sent", retry_wait: "awaiting repair",
        uncertain: "awaiting reconciliation", held: "held for safety", dead: "failed", review: "needs review", routed: "queued",
        no_matching_route: "no matching route", waiting_config: "waiting for configuration", route_conflict: "route conflict", safety_pending: "waiting for safety verification",
    };
    const details: string[] = [];
    if (fields.host !== undefined) details.push(`${fields.host}:${fields.port}`);
    if (fields.proxy) details.push("proxy enabled");
    if (fields.testMode) details.push("test mode: futu-news only");
    if (event === "test_mode_changed") details.push(fields.enabled ? "futu-news only" : "all configured routes");
    if (fields.routeName || fields.routeId) details.push(`route ${fields.routeName || fields.routeId}`);
    if (fields.target) details.push(`→ ${fields.target}`);
    if (fields.state && event !== "delivery_sent") details.push(states[String(fields.state)] ?? String(fields.state));
    if (fields.code || fields.reason) details.push(String(fields.code || fields.reason));
    if (fields.attempts) details.push(`attempt ${fields.attempts}`);
    if (fields.jobs !== undefined) details.push(`${fields.jobs} jobs`);
    if (fields.durationMs !== undefined) details.push(`${fields.durationMs}ms`);
    if (fields.jobId) details.push(`job ${String(fields.jobId).slice(0, 8)}`);
    const label = fields.reconciled ? "Delivery confirmed by reconciliation" : labels[event] ?? event;
    return [label, ...details].join(" · ").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function createLogger(directory: string, options: {
    output?: (line: string) => void;
    errorOutput?: (line: string) => void;
    color?: boolean;
    debug?: boolean;
} = {}) {
    const output = options.output ?? (line => { process.stdout.write(line); });
    const errorOutput = options.errorOutput ?? (line => { process.stderr.write(line); });
    const color = options.color ?? (Boolean(process.stdout.isTTY) && !Object.hasOwn(process.env, "NO_COLOR") && process.env.TERM !== "dumb");
    const debug = options.debug ?? process.env.SIGNAL_HUB_LOG_LEVEL === "debug";
    let lastFailure = -Infinity;
    function reportFailure() {
        if (Date.now() - lastFailure < 60_000) return;
        lastFailure = Date.now();
        try { errorOutput("Signal-hub log file operation failed; check the directory and disk\n"); } catch {}
    }
    const consoleTransport = new winston.transports.Stream({
        level: debug ? "debug" : "info",
        stream: new Writable({ write(chunk, _encoding, done) { try { output(chunk.toString()); } catch {} done(); } }),
        format: winston.format.printf(info => {
            const level = info.level as ReturnType<typeof levelFor>;
            const event = String(info.message);
            const success = event === "delivery_sent";
            const tag = success ? "✓" : { debug: "DEBUG", info: "INFO", warn: "WARN", error: "ERROR" }[level];
            const shade = success ? 32 : { debug: 90, info: 36, warn: 33, error: 31 }[level];
            const prefix = color ? `\x1b[${shade}m${tag}\x1b[0m` : tag;
            const time = new Date(String(info.time)).toLocaleTimeString("en-GB", { hour12: false });
            return `${time} ${prefix} ${consoleMessage(event, info)}`;
        }),
    });
    const logger = winston.createLogger({ level: "debug", transports: [consoleTransport] });
    logger.on("error", reportFailure);
    let file: DailyRotateFile | undefined;
    let fileFailed = false;
    try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        file = new DailyRotateFile({
            dirname: directory, filename: "hub-%DATE%", extension: ".jsonl", datePattern: "YYYY-MM-DD", utc: true,
            maxSize: "10m", maxFiles: "7d", zippedArchive: true, auditFile: join(directory, ".rotation-audit.json"),
            options: { flags: "a", mode: 0o600 },
            format: winston.format.printf(({ time, level, message, ...fields }) => JSON.stringify({ time, level, event: message, ...fields })),
        });
        file.on("error", reportFailure);
        file.on("archive", (path: string) => { try { chmodSync(path, 0o600); } catch { reportFailure(); } });
        file.logStream.on("error", () => { fileFailed = true; reportFailure(); });
        logger.add(file);
    } catch { reportFailure(); }
    let closing: Promise<void> | undefined;
    return Object.assign((event: string, fields: LogFields = {}) => {
        if (closing) return;
        try { logger.log(levelFor(event, fields), event, { time: new Date().toISOString(), ...fields }); } catch { reportFailure(); }
    }, {
        close: () => closing ??= new Promise<void>(done => {
            if (file && !fileFailed) {
                file.logStream.once("finish", done);
                file.logStream.once("error", done);
            } else logger.once("finish", done);
            logger.end();
        }),
    });
}

export type HubLog = (event: string, fields?: LogFields) => void;
