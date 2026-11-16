import { digest } from "./config.js";
import type { HubLog } from "./logging.js";
import { executable } from "./queue.js";
import { targetOverlapsSource } from "./routing.js";
import { Store } from "./storage.js";

export interface DiscordSecrets {
    botToken?: string;
    webhooks?: Record<string, string>;
}

export function createDiscordSender(store: Store, secrets: DiscordSecrets, excludedServerIds: string[], fetcher: typeof fetch = fetch, log?: HubLog) {
    const identities = new Map<string, { identity: string; channel: any; url: string; headers: Record<string, string>; webhook: boolean; expiresAt: number; }>();
    async function request(url: string, init: RequestInit = {}) {
        return fetcher(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: "error" });
    }
    async function resolve(target: string) {
        const cached = identities.get(target);
        if (cached && cached.expiresAt > Date.now()) return cached;
        const botHeaders = { Authorization: `Bot ${secrets.botToken ?? ""}` };
        let identity: string;
        let url: string;
        let headers: Record<string, string>;
        let webhook = false;
        if (secrets.webhooks?.[target]) {
            const endpoint = new URL(secrets.webhooks[target]);
            if (endpoint.origin !== "https://discord.com" || !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+$/.test(endpoint.pathname)) throw new Error("invalid_webhook_url");
            const response = await request(endpoint.toString());
            if (!response.ok) throw new Error("webhook_identity_unavailable");
            const data = await response.json();
            if (data.channel_id !== target || !data.id) throw new Error("webhook_channel_mismatch");
            identity = `webhook:${data.id}`;
            endpoint.searchParams.set("wait", "true");
            url = endpoint.toString();
            headers = {};
            webhook = true;
        } else {
            if (!secrets.botToken) throw new Error("missing_discord_bot_token");
            const response = await request("https://discord.com/api/v10/users/@me", { headers: botHeaders });
            if (!response.ok) throw new Error("bot_identity_unavailable");
            const user = await response.json();
            if (!user.id || !user.bot) throw new Error("discord_identity_not_bot");
            identity = `bot:${user.id}`;
            url = `https://discord.com/api/v10/channels/${target}/messages`;
            headers = botHeaders;
        }
        if (!secrets.botToken) throw new Error("bot_token_required_to_verify_channel_safety");
        const channelResponse = await request(`https://discord.com/api/v10/channels/${target}`, { headers: botHeaders });
        if (!channelResponse.ok) throw new Error("target_channel_unresolved");
        const channel = await channelResponse.json();
        if (channel.id !== target || !channel.guild_id) throw new Error("target_channel_invalid");
        const resolved = { identity, channel, url, headers, webhook, expiresAt: Date.now() + 300_000 };
        identities.set(target, resolved);
        return resolved;
    }

    async function send(job: any) {
        const startedAt = Date.now();
        const context = executable(store, job, excludedServerIds);
        if (!context) {
            store.db.prepare("UPDATE jobs SET state='held',error='current_safety_or_config_veto' WHERE id=?").run(job.id);
            return;
        }
        const rateLimitedUntil = Math.max(Number(store.metadata("discord_rate_limit") ?? 0), Number(store.metadata(`discord_rate_limit:${job.target}`) ?? 0));
        if (rateLimitedUntil > Date.now()) {
            store.db.prepare("UPDATE jobs SET state='pending',due_at=? WHERE id=?").run(rateLimitedUntil, job.id);
            return;
        }
        if (job.kind === "signal") {
            const timestamp = Date.parse(context.event.message.timestamp ?? context.event.capturedAt);
            if (!Number.isFinite(timestamp) || Date.now() - timestamp > 15 * 60_000) {
                store.db.prepare("UPDATE jobs SET state='review',error='stale_signal' WHERE id=?").run(job.id);
                return;
            }
        }
        const attemptId = store.db.prepare("INSERT INTO delivery_attempts(job_id,started_at,outcome) VALUES(?,?,'preflight')").run(job.id, Date.now()).lastInsertRowid;
        const finishAttempt = (outcome: string, status = 0, error = "") => {
            store.db.prepare("UPDATE delivery_attempts SET finished_at=?,outcome=?,status=?,error=? WHERE id=?").run(Date.now(), outcome, status, error, attemptId);
        };
        let target: Awaited<ReturnType<typeof resolve>>;
        try {
            target = await resolve(job.target);
            if (targetOverlapsSource(context.currentConfig.snapshot, target.channel)
                || [job.target, target.channel.parent_id].includes(context.event.channelId)
                || (context.event.parentChannelId && job.target === context.event.parentChannelId)) throw new Error("target_source_overlap");
        } catch (error) {
            const code = error instanceof Error && [
                "invalid_webhook_url", "webhook_identity_unavailable", "webhook_channel_mismatch", "missing_discord_bot_token",
                "bot_identity_unavailable", "discord_identity_not_bot", "bot_token_required_to_verify_channel_safety",
                "target_channel_unresolved", "target_channel_invalid", "target_source_overlap",
            ].includes(error.message) ? error.message : "target_safety_not_established";
            finishAttempt("preflight_failed", 0, code);
            store.retryDelivery(job.id, code);
            store.alert("discord_safety", `Discord target identity or route safety could not be confirmed (${code}); affected sends are paused`);
            return;
        }
        const revalidated = executable(store, job, excludedServerIds);
        if (!revalidated || targetOverlapsSource(revalidated.currentConfig.snapshot, target.channel)) {
            finishAttempt("held", 0, "config_changed_during_preflight");
            store.db.prepare("UPDATE jobs SET state='held',error='config_changed_during_preflight' WHERE id=?").run(job.id);
            return;
        }
        const nonce = digest(job.id).slice(0, 24);
        store.transaction(() => {
            store.db.prepare("INSERT OR IGNORE INTO sender_history VALUES(?,?,?,?,?)").run(target.identity, job.target, target.channel.parent_id ?? "", target.channel.guild_id, Date.now());
            store.db.prepare("INSERT INTO sink_deliveries VALUES(?,?,?,?,?,'intent','',?,?) ON CONFLICT(delivery_key) DO UPDATE SET identity=excluded.identity,state='intent',updated_at=excluded.updated_at")
                .run(job.id, job.id, target.identity, job.target, nonce, Date.now(), Date.now());
            store.db.prepare("UPDATE jobs SET state='sending',lease_until=? WHERE id=?").run(Date.now() + 60_000, job.id);
            store.db.prepare("UPDATE delivery_attempts SET outcome='sending' WHERE id=?").run(attemptId);
        });
        let responseStatus = 0;
        let messageId: string;
        try {
            const response = await request(target.url, {
                method: "POST", headers: { ...target.headers, "Content-Type": "application/json" },
                body: JSON.stringify({ ...JSON.parse(job.body), ...(target.webhook ? {} : { nonce, enforce_nonce: true }) }),
            });
            responseStatus = response.status;
            if (response.status >= 400 && response.status < 500 && response.status !== 408) {
                let retryMs = 0;
                let globallyLimited = false;
                if (response.status === 429) {
                    try {
                        const limit = await response.json();
                        retryMs = Math.max(1000, Math.min(3_600_000, Number(limit.retry_after) * 1000 || 1000));
                        globallyLimited = limit.global === true;
                    } catch {}
                }
                store.transaction(() => {
                    if (response.status === 429) store.setMetadata(globallyLimited ? "discord_rate_limit" : `discord_rate_limit:${job.target}`, String(Date.now() + retryMs));
                    finishAttempt("rejected", response.status, `discord_http_${response.status}`);
                    store.retryDelivery(job.id, `discord_http_${response.status}`, retryMs);
                    store.db.prepare("UPDATE sink_deliveries SET state='rejected',updated_at=? WHERE delivery_key=?").run(Date.now(), job.id);
                    if (response.status !== 429) store.alert("discord_rejected", `Discord rejected a delivery with HTTP ${response.status}; archived content and job retained`, "critical");
                });
                return;
            }
            if (!response.ok) throw new Error("uncertain_discord_response");
            const message = await response.json();
            if (!/^\d{1,32}$/.test(message.id) || message.channel_id !== job.target) throw new Error("uncertain_discord_ack");
            store.transaction(() => {
                finishAttempt("sent", response.status);
                store.db.prepare("UPDATE sink_deliveries SET state='sent',message_id=?,updated_at=? WHERE delivery_key=?").run(message.id, Date.now(), job.id);
                store.db.prepare("UPDATE jobs SET state='sent',error='' WHERE id=?").run(job.id);
            });
            messageId = message.id;
        } catch {
            store.transaction(() => {
                finishAttempt("uncertain", responseStatus, "send_outcome_unknown");
                store.db.prepare("UPDATE jobs SET state='uncertain',error='send_outcome_unknown' WHERE id=?").run(job.id);
                store.db.prepare("UPDATE sink_deliveries SET state='uncertain',updated_at=? WHERE delivery_key=?").run(Date.now(), job.id);
                store.alert("delivery_uncertain", "A Discord send has an uncertain outcome; reconciliation is required before retry", "critical");
            });
            return;
        }
        log?.("delivery_sent", {
            jobId: job.id, messageKey: job.message_key, routeId: job.route_id, routeName: context.route.name,
            kind: job.kind, target: job.target, messageId, attempts: job.attempts, durationMs: Date.now() - startedAt,
        });
    }

    async function reconcile() {
        if (!secrets.botToken) return;
        const cursor = store.metadata("reconciliation_cursor") ?? "";
        const query = store.db.prepare("SELECT * FROM sink_deliveries WHERE state='uncertain' AND identity LIKE 'bot:%' AND delivery_key>? ORDER BY delivery_key LIMIT 50");
        let rows = query.all(cursor) as any[];
        if (!rows.length && cursor) rows = query.all("") as any[];
        for (const row of rows) {
            try {
                const response = await request(`https://discord.com/api/v10/channels/${row.target}/messages?limit=100`, { headers: { Authorization: `Bot ${secrets.botToken}` } });
                if (!response.ok) continue;
                const messages = await response.json();
                if (!Array.isArray(messages)) continue;
                const found = messages.find(message => message.channel_id === row.target && String(message.nonce ?? "") === row.nonce
                    && `bot:${message.author?.id}` === row.identity);
                if (!found) continue;
                store.transaction(() => {
                    store.db.prepare("UPDATE sink_deliveries SET state='sent',message_id=?,updated_at=? WHERE delivery_key=?").run(found.id, Date.now(), row.delivery_key);
                    store.db.prepare("UPDATE jobs SET state='sent',error='' WHERE id=?").run(row.job_id);
                });
                log?.("delivery_sent", { jobId: row.job_id, target: row.target, messageId: found.id, reconciled: true });
            } finally { store.setMetadata("reconciliation_cursor", row.delivery_key); }
        }
    }
    return { send, reconcile };
}
