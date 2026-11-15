import { Store } from "./storage.js";

export function refreshHealthAlerts(store: Store, now = Date.now()) {
    const syncedAt = Number(store.metadata("config_synced_at") ?? 0);
    if (!store.metadata("config_hash")) store.alert("config_missing", "No valid configuration is available; incoming messages are archived and waiting", "critical");
    else store.resolveAlert("config_missing");
    if (now - syncedAt > 15 * 60_000) store.alert("config_stale", "Configuration is stale; cached routes remain active");
    else store.resolveAlert("config_stale");
    const backlog = store.backlog();
    if (backlog.messages.some(row => now - row.oldestAt > 60_000)) store.alert("archive_backlog", "Archived messages have been waiting for processing for over one minute; inspect configuration and safety status", "critical");
    else store.resolveAlert("archive_backlog");
    if (store.metadata("paused") !== "true" && backlog.jobs.some(row => row.readyAt !== null && now - row.readyAt > 60_000)) store.alert("delivery_backlog", "Ready delivery work is over one minute late; inspect workers, target ordering and rate limits", "critical");
    else store.resolveAlert("delivery_backlog");
    if (backlog.jobs.some(row => ["retry_wait", "uncertain", "held", "dead", "review"].includes(row.state))) store.alert("delivery_attention", "Deliveries are awaiting repair, reconciliation or operator review; inspect /api/deliveries");
    else store.resolveAlert("delivery_attention");
    const outstanding = store.db.prepare(`SELECT max(state='uncertain') AS uncertain,
        max(state='retry_wait' OR recovery_cycles>0) AS exhausted,
        max(error='target_safety_not_established') AS safety,
        max(error GLOB 'discord_http_*' AND error!='discord_http_429') AS rejected,
        max(error='signal_extraction_failed') AS extraction FROM jobs
        WHERE state IN ('pending','leased','sending','retry_wait','uncertain','held','dead','review')`).get() as any;
    if (outstanding.uncertain) store.alert("delivery_uncertain", "A Discord send has an uncertain outcome; reconciliation is required before retry", "critical");
    else store.resolveAlert("delivery_uncertain");
    if (!outstanding.exhausted) store.resolveAlert("delivery_retries_exhausted");
    if (!outstanding.safety) store.resolveAlert("discord_safety");
    if (!outstanding.rejected) store.resolveAlert("discord_rejected");
    if (!outstanding.extraction) store.resolveAlert("signal_extraction");
    if (!store.db.prepare("SELECT 1 FROM messages WHERE state='route_conflict' LIMIT 1").get()) store.resolveAlert("route_conflict");
    if (store.db.prepare("SELECT 1 FROM quarantine LIMIT 1").get()) store.alert("capture_quarantine", "Rejected captures are retained in quarantine; inspect /api/status and the local sender queue");
    else store.resolveAlert("capture_quarantine");
}

export async function flushAlerts(store: Store, webhook: string | undefined, fetcher: typeof fetch = fetch, now = Date.now()) {
    if (!webhook) return;
    if (Number(store.metadata("alert_next_attempt_at") ?? 0) > now) return;
    const rows = store.db.prepare(`SELECT * FROM alerts WHERE active=1 AND due_at<=?
        ORDER BY CASE WHEN code GLOB '*_recovered' THEN 2 WHEN severity='critical' THEN 0 ELSE 1 END,sent_at,due_at,code LIMIT 20`).all(now) as any[];
    if (!rows.length) return;
    const urgent = rows.some(row => row.severity === "critical" && !row.code.endsWith("_recovered"));
    if (Number(store.metadata("alert_next_digest_at") ?? 0) > now && !urgent) return;
    store.setMetadata("alert_next_attempt_at", String(now + 30_000));
    try {
        const lines = rows.map(row => `[${row.code.endsWith("_recovered") ? "恢复" : row.severity === "critical" ? "严重" : "告警"}] ${row.code}: ${row.body.slice(0, 300)}`);
        const response = await fetcher(webhook, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ msgtype: "text", text: { content: `[signal-hub] ${rows.length} 项状态更新\n${lines.join("\n")}` } }),
            signal: AbortSignal.timeout(10_000), redirect: "error",
        });
        if (!response.ok || (await response.json()).errcode !== 0) throw new Error("dingtalk_rejected");
        store.transaction(() => {
            store.setMetadata("alert_send_failures", "0");
            store.setMetadata("alert_next_digest_at", String(now + 300_000));
            for (const row of rows) {
                const updated = store.db.prepare(`UPDATE alerts SET sent_at=?,due_at=?,attempts=0,
                    active=CASE WHEN code GLOB '*_recovered' THEN 0 ELSE active END WHERE code=? AND due_at=? AND severity=? AND body=?`)
                    .run(now, now + (row.severity === "critical" ? 300_000 : 1_800_000), row.code, row.due_at, row.severity, row.body);
                if (updated.changes && !row.code.endsWith("_recovered")) {
                    const current = store.db.prepare("SELECT active FROM alerts WHERE code=?").get(row.code) as any;
                    if (!current.active) store.alert(`${row.code}_recovered`, `${row.code} recovered`);
                }
            }
        });
    } catch {
        const failures = Number(store.metadata("alert_send_failures") ?? 0) + 1;
        const retryAt = now + Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4));
        store.setMetadata("alert_send_failures", String(failures));
        store.setMetadata("alert_next_attempt_at", String(retryAt));
        for (const row of rows) store.db.prepare("UPDATE alerts SET attempts=attempts+1,due_at=? WHERE code=? AND active=1 AND due_at=? AND severity=? AND body=?").run(retryAt, row.code, row.due_at, row.severity, row.body);
    }
}
