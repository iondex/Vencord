import { signalEnabled } from "./config.js";
import { executable } from "./queue.js";
import { createOpenAICompatibleClient, extractMessageSignal } from "./reference/signal-model.js";
import { sanitizeForwardText } from "./rendering.js";
import { evaluateText } from "./routing.js";
import { Store } from "./storage.js";

function normalizeTicker(value: string) { return value.trim().replace(/^\$/, "").toUpperCase(); }

export async function runExtraction(store: Store, job: any, apiKey: string | undefined, excludedServerIds: string[]) {
    const context = executable(store, job, excludedServerIds);
    if (!context || !signalEnabled(context.config.snapshot, context.route.routeId)) {
        store.db.prepare("UPDATE jobs SET state='held',error='current_safety_or_config_veto' WHERE id=?").run(job.id);
        return;
    }
    const { event, config, route } = context;
    const input = evaluateText(event.message, route);
    if (input.reason !== "routed" || !input.signalContent) {
        store.db.prepare("UPDATE jobs SET state='held',error='current_route_policy_veto' WHERE id=?").run(job.id);
        return;
    }
    const signalTime = Date.parse(typeof event.message.timestamp === "string" ? event.message.timestamp : event.capturedAt);
    if (!Number.isFinite(signalTime) || Date.now() - signalTime > 15 * 60_000) {
        store.db.prepare("UPDATE jobs SET state='review',error='stale_signal' WHERE id=?").run(job.id);
        return;
    }
    try {
        const existing = store.db.prepare("SELECT result FROM extractions WHERE message_key=? AND route_id=?").get(job.message_key, route.routeId) as any;
        let result = existing ? JSON.parse(existing.result) : undefined;
        if (!result) {
            if (!apiKey) throw new Error("missing_model_key");
            const client = createOpenAICompatibleClient({ apiKey, baseURL: config.snapshot.signal.providerBaseUrl || undefined, timeoutMs: config.snapshot.signal.timeoutMs });
            result = await extractMessageSignal({
                client, provider: "openai-compatible", model: config.snapshot.signal.model,
                maxRetries: 0,
                message: {
                    messageId: event.message.id, routeName: route.name, signalTime: event.message.timestamp ?? event.capturedAt,
                    analyst: event.message.author?.globalName || event.message.author?.global_name || event.message.author?.username || "", channelId: event.channelId,
                    content: input.signalContent,
                },
            });
        }
        store.db.prepare("INSERT OR IGNORE INTO extractions VALUES(?,?,?,?)").run(job.message_key, route.routeId, JSON.stringify(result), Date.now());
        store.transaction(() => {
            const current = executable(store, job, excludedServerIds);
            if (!current) {
                store.db.prepare("UPDATE jobs SET state='held',error='config_changed_during_extraction' WHERE id=?").run(job.id);
                return;
            }
            const routeConfig = current.config.snapshot.signal.routes.find(item => item.routeId === route.routeId);
            const signals = result.kind === "signal" ? result.signals.filter((signal: any) => !routeConfig?.tickerWhitelistEnabled
                || routeConfig.tickerWhitelist.some(ticker => normalizeTicker(ticker) === normalizeTicker(signal.underlyingTicker ?? signal.ticker))) : [];
            if (signals.length) {
                const entries = signals.map((signal: any) => signal.kind === "equity_entry"
                    ? `- ${signal.ticker} ${String(signal.side).toUpperCase()} @ ${signal.entryPrice ?? "N/A"}`
                    : `- ${signal.ticker} ${signal.expiration} ${signal.strike}${signal.side === "call" ? "C" : "P"} @ ${signal.optionPrice ?? "N/A"}`);
                const source = input.signalContent.trim().split("\n").filter(Boolean).map(line => `> ${line}`).join("\n");
                const text = sanitizeForwardText(["**入场信号**", "", `时间: ${event.message.timestamp ?? event.capturedAt}`, "", "标的:", ...entries, "", "原文:", source].join("\n"), event);
                const content = text.length > 1900 ? `${text.slice(0, 1897).replace(/[\uD800-\uDBFF]$/, "")}...` : text;
                const targets = [current.config.snapshot.signal.targetChannelId];
                const indexTarget = current.config.snapshot.signal.indexTargetChannelId;
                if (indexTarget && !targets.includes(indexTarget) && signals.some((signal: any) => /^(SPY|QQQ|SPX|IWM)$/.test(normalizeTicker(signal.underlyingTicker ?? signal.ticker)))) targets.push(indexTarget);
                for (const target of targets) store.enqueue(job.message_key, "signal", route.routeId, target, 0, { content, allowed_mentions: { parse: [] } }, current.config.hash);
            }
            store.db.prepare("UPDATE jobs SET state='done',error='' WHERE id=?").run(job.id);
        });
    } catch {
        store.retryDelivery(job.id, "signal_extraction_failed");
        store.alert("signal_extraction", "Signal extraction failed; ordinary forwarding continues and extraction work is retained");
    }
}
