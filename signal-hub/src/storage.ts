import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CaptureEnvelope } from "../contracts/ingest.js";
import { canonical, digest, Snapshot, validateSnapshot } from "./config.js";

export function openStore(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
        INSERT OR IGNORE INTO schema_version VALUES(1);
        CREATE TABLE IF NOT EXISTS receipts(event_id TEXT PRIMARY KEY, hash TEXT NOT NULL, raw TEXT NOT NULL, received_at INTEGER NOT NULL, message_key TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages(message_key TEXT PRIMARY KEY, envelope TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS config_snapshots(hash TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, message_key TEXT NOT NULL, kind TEXT NOT NULL, route_id TEXT NOT NULL, target TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', config_hash TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,due_at);
        CREATE INDEX IF NOT EXISTS jobs_message ON jobs(message_key,kind,target,part);
        CREATE INDEX IF NOT EXISTS receipts_message ON receipts(message_key,received_at);
        CREATE TABLE IF NOT EXISTS route_receipts(message_key TEXT NOT NULL,route_id TEXT NOT NULL,target TEXT NOT NULL,config_hash TEXT NOT NULL,decision TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(message_key,route_id));
        CREATE INDEX IF NOT EXISTS route_receipts_created ON route_receipts(created_at);
        CREATE TABLE IF NOT EXISTS delivery_attempts(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER NOT NULL DEFAULT 0,outcome TEXT NOT NULL,status INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS delivery_attempts_job ON delivery_attempts(job_id,id);
        CREATE INDEX IF NOT EXISTS delivery_attempts_active ON delivery_attempts(outcome,job_id);
        CREATE TABLE IF NOT EXISTS sender_history(identity TEXT NOT NULL, target TEXT NOT NULL, parent TEXT NOT NULL, server_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(identity,target));
        CREATE TABLE IF NOT EXISTS sink_deliveries(delivery_key TEXT PRIMARY KEY, job_id TEXT NOT NULL, identity TEXT NOT NULL, target TEXT NOT NULL, nonce TEXT NOT NULL, state TEXT NOT NULL, message_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS output_messages ON sink_deliveries(message_id);
        CREATE INDEX IF NOT EXISTS output_jobs ON sink_deliveries(job_id);
        CREATE INDEX IF NOT EXISTS output_reconciliation ON sink_deliveries(state,delivery_key);
        CREATE TABLE IF NOT EXISTS extractions(message_key TEXT NOT NULL, route_id TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(message_key,route_id));
        CREATE TABLE IF NOT EXISTS alerts(code TEXT PRIMARY KEY, body TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, due_at INTEGER NOT NULL, sent_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS quarantine(id INTEGER PRIMARY KEY, reason TEXT NOT NULL, raw TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS checkpoints(source TEXT PRIMARY KEY, cursor TEXT NOT NULL);
    `);
    const columns = db.prepare("PRAGMA table_info(messages)").all() as any[];
    if (!columns.some(column => column.name === "checked_at")) db.exec("ALTER TABLE messages ADD COLUMN checked_at INTEGER NOT NULL DEFAULT 0");
    if (!columns.some(column => column.name === "config_hash")) transaction(() => {
        db.exec("ALTER TABLE messages ADD COLUMN config_hash TEXT NOT NULL DEFAULT ''");
        db.exec("UPDATE messages SET config_hash=coalesce((SELECT value FROM metadata WHERE key='config_hash'),'')");
        db.prepare("UPDATE jobs SET due_at=coalesce((SELECT created_at FROM messages WHERE message_key=jobs.message_key),?) WHERE state='pending' AND due_at=0").run(Date.now());
    });
    db.exec("CREATE INDEX IF NOT EXISTS messages_pending ON messages(state,created_at); CREATE INDEX IF NOT EXISTS messages_deferred ON messages(state,checked_at,created_at)");
    db.exec(`CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
        CREATE INDEX IF NOT EXISTS receipts_received ON receipts(received_at);
        CREATE INDEX IF NOT EXISTS attempts_finished ON delivery_attempts(finished_at,outcome);
        CREATE INDEX IF NOT EXISTS attempts_outcome_id ON delivery_attempts(outcome,id);
        CREATE INDEX IF NOT EXISTS outputs_updated ON sink_deliveries(state,updated_at)`);
    const jobColumns = db.prepare("PRAGMA table_info(jobs)").all() as any[];
    for (const column of ["retry_count", "recovery_cycles"]) {
        if (!jobColumns.some(existing => existing.name === column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
    const alertColumns = db.prepare("PRAGMA table_info(alerts)").all() as any[];
    if (!alertColumns.some(column => column.name === "severity")) db.exec("ALTER TABLE alerts ADD COLUMN severity TEXT NOT NULL DEFAULT 'warning'");
    if (!db.prepare("SELECT 1 FROM schema_version WHERE version=2").get()) {
        transaction(() => {
            db.exec(`INSERT OR IGNORE INTO route_receipts
                SELECT DISTINCT job.message_key,job.route_id,job.target,job.config_hash,message.state,message.created_at
                FROM jobs AS job JOIN messages AS message ON message.message_key=job.message_key WHERE job.kind='deliver';
                INSERT INTO schema_version VALUES(2)`);
        });
    }

    function transaction<Result>(work: () => Result): Result {
        db.exec("BEGIN IMMEDIATE");
        try {
            const result = work();
            db.exec("COMMIT");
            return result;
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    }
    function metadata(key: string) { return (db.prepare("SELECT value FROM metadata WHERE key=?").get(key) as any)?.value as string | undefined; }
    function setMetadata(key: string, value: string) { db.prepare("INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
    function config(hash = metadata("config_hash")) {
        if (!hash) return;
        const row = db.prepare("SELECT body FROM config_snapshots WHERE hash=?").get(hash) as any;
        if (!row || digest(row.body) !== hash) throw new Error("config_cache_corrupt");
        return { hash, snapshot: validateSnapshot(JSON.parse(row.body)) };
    }
    function installConfig(snapshot: Snapshot, syncedAt = Date.now()) {
        const body = canonical(validateSnapshot(snapshot));
        const hash = digest(body);
        transaction(() => {
            db.prepare("INSERT INTO config_snapshots VALUES(?,?,?) ON CONFLICT(hash) DO UPDATE SET body=excluded.body").run(hash, body, Date.now());
            setMetadata("config_hash", hash);
            setMetadata("config_synced_at", String(syncedAt));
            db.prepare("UPDATE messages SET state='pending',config_hash=? WHERE state IN ('waiting_config','route_conflict') OR (state='pending' AND config_hash='')").run(hash);
            db.prepare("UPDATE jobs SET state='pending' WHERE state='held' AND error IN ('current_safety_or_config_veto','config_changed_during_preflight','config_changed_during_extraction')").run();
        });
        return { hash, body, syncedAt };
    }
    function ingest(envelope: CaptureEnvelope, raw: string) {
        const hash = digest(raw);
        const key = `discord:${envelope.serverId}:${envelope.channelId}:${envelope.message.id}`;
        return transaction(() => {
            const existing = db.prepare("SELECT hash FROM receipts WHERE event_id=?").get(envelope.eventId) as any;
            if (existing && existing.hash !== hash) throw new Error("event_id_conflict");
            db.prepare("INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,?)").run(envelope.eventId, hash, raw, Date.now(), key);
            db.prepare("INSERT OR IGNORE INTO messages(message_key,envelope,created_at,config_hash) VALUES(?,?,?,?)").run(key, JSON.stringify(envelope), Date.now(), metadata("config_hash") ?? "");
            return { eventId: envelope.eventId, hash, durable: true, duplicate: Boolean(existing) };
        });
    }
    function ownOutput(envelope: CaptureEnvelope): "self_generated" | "safety_pending" | undefined {
        const { message } = envelope;
        if (db.prepare("SELECT 1 FROM sink_deliveries WHERE message_id=? AND target=?").get(message.id, envelope.channelId)) return "self_generated";
        const webhookId = message.webhook_id ?? message.webhookId;
        const identities = [webhookId ? `webhook:${webhookId}` : "", message.author?.id ? `bot:${message.author.id}` : ""].filter(Boolean);
        for (const identity of identities) {
            if (!db.prepare("SELECT 1 FROM sender_history WHERE identity=? AND target=?").get(identity, envelope.channelId)) continue;
            if (message.nonce && db.prepare("SELECT 1 FROM sink_deliveries WHERE identity=? AND target=? AND nonce=?").get(identity, envelope.channelId, String(message.nonce))) return "self_generated";
            return "safety_pending";
        }
    }
    function recoverLeases() {
        transaction(() => {
            db.prepare("UPDATE jobs SET state='uncertain',error='interrupted_send' WHERE state='sending' AND lease_until<?").run(Date.now());
            db.prepare("UPDATE sink_deliveries SET state='uncertain',updated_at=? WHERE state='intent' AND job_id IN (SELECT id FROM jobs WHERE state='uncertain')").run(Date.now());
            db.prepare("UPDATE delivery_attempts SET outcome='uncertain',finished_at=?,error='interrupted_send' WHERE outcome='sending' AND job_id IN (SELECT id FROM jobs WHERE state='uncertain')").run(Date.now());
            db.prepare("UPDATE delivery_attempts SET outcome='preflight_failed',finished_at=?,error='interrupted_preflight' WHERE outcome='preflight' AND job_id IN (SELECT id FROM jobs WHERE state='leased' AND lease_until<?)").run(Date.now(), Date.now());
            db.prepare("UPDATE jobs SET state='pending' WHERE state='leased' AND lease_until<?").run(Date.now());
        });
    }
    function claim(kind: string) {
        return transaction(() => {
            const job = db.prepare(`SELECT * FROM jobs AS candidate WHERE kind=? AND state='pending' AND due_at<=?
                AND (kind='extract' OR NOT EXISTS(SELECT 1 FROM jobs AS active WHERE active.target=candidate.target AND active.state IN ('leased','sending')))
                AND NOT EXISTS(SELECT 1 FROM jobs AS earlier WHERE earlier.message_key=candidate.message_key AND earlier.kind=candidate.kind
                    AND earlier.target=candidate.target AND earlier.part<candidate.part AND earlier.state!='sent')
                ORDER BY due_at,id LIMIT 1`).get(kind, Date.now()) as any;
            if (!job) return;
            db.prepare("UPDATE jobs SET state='leased',lease_until=?,attempts=attempts+1 WHERE id=?").run(Date.now() + 360_000, job.id);
            return { ...job, attempts: job.attempts + 1 };
        });
    }
    function enqueue(key: string, kind: string, routeId: string, target: string, part: number, body: unknown, configHash: string) {
        const jobId = digest(`${key}:${kind}:${routeId}:${target}:${part}`);
        db.prepare("INSERT OR IGNORE INTO jobs(id,message_key,kind,route_id,target,part,body,config_hash,due_at) VALUES(?,?,?,?,?,?,?,?,?)")
            .run(jobId, key, kind, routeId, target, part, JSON.stringify(body), configHash, Date.now());
        return jobId;
    }
    function recordRoute(key: string, routeId: string, target: string, configHash: string, decision: string) {
        db.prepare("INSERT INTO route_receipts VALUES(?,?,?,?,?,?) ON CONFLICT(message_key,route_id) DO UPDATE SET decision=excluded.decision,target=excluded.target,config_hash=excluded.config_hash")
            .run(key, routeId, target, configHash, decision, Date.now());
    }
    function retryDelivery(jobId: string, error: string, minimumDelay = 0) {
        const job = db.prepare("SELECT retry_count FROM jobs WHERE id=?").get(jobId) as any;
        const retries = job.retry_count + 1;
        const exhausted = retries > 5;
        const delay = Math.max(minimumDelay, exhausted ? 300_000 : 1000 * 2 ** (retries - 1));
        db.prepare("UPDATE jobs SET state=?,retry_count=?,due_at=?,error=? WHERE id=?").run(exhausted ? "retry_wait" : "pending", retries, Date.now() + delay, error, jobId);
        if (exhausted) alert("delivery_retries_exhausted", "Delivery retries exhausted; durable work is retained for the periodic repair worker", "critical");
    }
    function recoverDeliveries() {
        return db.prepare("UPDATE jobs SET state='pending',retry_count=0,recovery_cycles=recovery_cycles+1 WHERE state='retry_wait' AND due_at<=?").run(Date.now()).changes;
    }
    function deliveries(messageKey?: string) {
        return db.prepare(`SELECT receipt.message_key,receipt.route_id,coalesce(nullif(job.target,''),receipt.target) AS target,receipt.decision,receipt.config_hash,
            job.id AS job_id,job.kind,job.part,job.state,job.attempts,job.retry_count,job.recovery_cycles,job.due_at,job.error,
            sink.message_id,sink.state AS sink_state,
            sink.created_at AS sendStartedAt,sink.updated_at AS sendUpdatedAt,
            (SELECT count(*) FROM delivery_attempts WHERE job_id=job.id) AS recorded_attempts
            FROM route_receipts AS receipt LEFT JOIN jobs AS job ON job.message_key=receipt.message_key AND job.route_id=receipt.route_id
            LEFT JOIN sink_deliveries AS sink ON sink.job_id=job.id ${messageKey ? "WHERE receipt.message_key=?" : ""}
            ORDER BY receipt.created_at DESC,job.part LIMIT 100`).all(...(messageKey ? [messageKey] : []));
    }
    function deliveryTrace(messageKey: string) {
        return {
            message: db.prepare("SELECT message_key,state,created_at,checked_at,json_extract(envelope,'$.capturedAt') AS capturedAt FROM messages WHERE message_key=?").get(messageKey) ?? null,
            receipts: db.prepare("SELECT event_id,hash,received_at FROM receipts WHERE message_key=? ORDER BY received_at LIMIT 100").all(messageKey),
            deliveries: deliveries(messageKey),
        };
    }
    function backlog() {
        return {
            messages: db.prepare("SELECT state,count(*) AS total,min(created_at) AS oldestAt FROM messages WHERE state IN ('pending','waiting_config','safety_pending') GROUP BY state").all() as { state: string; total: number; oldestAt: number; }[],
            jobs: db.prepare(`SELECT job.kind,job.state,count(*) AS total,min(message.created_at) AS oldestAt,
                min(CASE WHEN job.state='pending' THEN max(job.due_at,message.created_at) END) AS readyAt
                FROM jobs AS job JOIN messages AS message ON message.message_key=job.message_key
                WHERE job.state IN ('pending','leased','sending','retry_wait','uncertain','held','dead','review') GROUP BY job.kind,job.state`).all() as { kind: string; state: string; total: number; oldestAt: number; readyAt: number | null; }[],
        };
    }
    function alert(code: string, body: string, severity: "warning" | "critical" = "warning") {
        db.prepare(`INSERT INTO alerts(code,body,due_at,severity) VALUES(?,?,?,?) ON CONFLICT(code) DO UPDATE SET
            due_at=CASE WHEN alerts.active=0 OR (alerts.severity='warning' AND excluded.severity='critical') THEN excluded.due_at ELSE alerts.due_at END,
            sent_at=CASE WHEN alerts.active=0 THEN 0 ELSE alerts.sent_at END,
            attempts=CASE WHEN alerts.active=0 THEN 0 ELSE alerts.attempts END,
            severity=CASE WHEN alerts.active=0 OR excluded.severity='critical' THEN excluded.severity ELSE alerts.severity END,
            active=1,body=excluded.body`).run(code, body, Date.now(), severity);
        if (!code.endsWith("_recovered")) db.prepare("UPDATE alerts SET active=0 WHERE code=?").run(`${code}_recovered`);
    }
    function resolveAlert(code: string) {
        const row = db.prepare("SELECT sent_at FROM alerts WHERE code=? AND active=1").get(code) as any;
        const result = db.prepare("UPDATE alerts SET active=0 WHERE code=? AND active=1").run(code);
        if (result.changes && row.sent_at) alert(`${code}_recovered`, `${code} recovered`);
    }
    function status() {
        return {
            receipts: (db.prepare("SELECT count(*) AS total FROM receipts").get() as any).total,
            messages: db.prepare("SELECT state,count(*) AS total FROM messages GROUP BY state").all(),
            jobs: db.prepare("SELECT state,count(*) AS total FROM jobs GROUP BY state").all(),
            routed: db.prepare("SELECT decision,count(*) AS total FROM route_receipts GROUP BY decision").all(),
            observedAt: Date.now(),
            paused: metadata("paused") === "true",
            testMode: metadata("test_mode") === "true",
            forwardAfter: metadata("forward_after") ?? "",
            backlog: backlog(),
            quarantined: db.prepare("SELECT reason,count(*) AS total,max(created_at) AS latestAt FROM quarantine GROUP BY reason").all(),
            configHash: metadata("config_hash") ?? null,
            configSyncedAt: metadata("config_synced_at") ?? null,
            activeAlerts: db.prepare("SELECT code,severity,due_at,sent_at,attempts FROM alerts WHERE active=1").all(),
            nextAlertAttemptAt: Number(metadata("alert_next_attempt_at") ?? 0),
            nextAlertDigestAt: Number(metadata("alert_next_digest_at") ?? 0),
            alertSendFailures: Number(metadata("alert_send_failures") ?? 0),
        };
    }
    return { db, transaction, metadata, setMetadata, config, installConfig, ingest, ownOutput, recoverLeases, claim, enqueue, recordRoute, retryDelivery, recoverDeliveries, deliveries, deliveryTrace, backlog, alert, resolveAlert, status, close: () => db.close() };
}
export type Store = ReturnType<typeof openStore>;
