import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

function consoleMessage(event: string, fields: LogFields) {
    const labels: Record<string, string> = {
        hub_started: "服务已启动", hub_stopped: "服务已停止", config_sync_ok: "配置同步完成",
        config_sync_failed_using_cache: "配置同步失败，继续使用缓存", capture_committed: "消息已保存",
        capture_quarantined: "消息已隔离", message_planned: "消息处理", delivery_sent: "转发成功",
        delivery_finished: "投递暂未完成", delivery_repair_scheduled: "已安排补发", route_test_queued: "路由测试已入队",
    };
    const states: Record<string, string> = {
        pending: "等待发送", leased: "准备发送", sending: "发送中", sent: "已送达", retry_wait: "等待补发",
        uncertain: "结果待对账", held: "安全检查暂缓", dead: "发送失败", review: "待检查", routed: "已入队",
        no_matching_route: "未匹配路由", waiting_config: "等待配置", route_conflict: "路由冲突", safety_pending: "等待安全检查",
    };
    const details: string[] = [];
    if (fields.host !== undefined) details.push(`${fields.host}:${fields.port}`);
    if (fields.routeName || fields.routeId) details.push(`路由 ${fields.routeName || fields.routeId}`);
    if (fields.target) details.push(`→ ${fields.target}`);
    if (fields.state && event !== "delivery_sent") details.push(states[String(fields.state)] ?? String(fields.state));
    if (fields.code || fields.reason) details.push(String(fields.code || fields.reason));
    if (fields.attempts) details.push(`第 ${fields.attempts} 次`);
    if (fields.jobs !== undefined) details.push(`${fields.jobs} 个任务`);
    if (fields.durationMs !== undefined) details.push(`${fields.durationMs}ms`);
    if (fields.jobId) details.push(`任务 ${String(fields.jobId).slice(0, 8)}`);
    const label = fields.reconciled ? "对账确认送达" : labels[event] ?? event;
    return [label, ...details].join(" · ").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function createLogger(directory: string, options: {
    output?: (line: string) => void;
    errorOutput?: (line: string) => void;
    color?: boolean;
    debug?: boolean;
} = {}) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const output = options.output ?? (line => { process.stdout.write(line); });
    const errorOutput = options.errorOutput ?? (line => { process.stderr.write(line); });
    const color = options.color ?? (Boolean(process.stdout.isTTY) && !Object.hasOwn(process.env, "NO_COLOR") && process.env.TERM !== "dumb");
    const debug = options.debug ?? process.env.SIGNAL_HUB_LOG_LEVEL === "debug";
    let part = 0;
    let fileFailureReported = false;
    return (event: string, fields: LogFields = {}) => {
        const level = levelFor(event, fields);
        const now = new Date();
        const record = { time: now.toISOString(), level, event, ...fields };
        const body = `${JSON.stringify(record)}\n`;
        let path = join(directory, `hub-${record.time.slice(0, 10)}-${part}.jsonl`);
        try {
            try { if (statSync(path).size >= 10 * 1024 * 1024) path = join(directory, `hub-${record.time.slice(0, 10)}-${++part}.jsonl`); } catch {}
            appendFileSync(path, body, { mode: 0o600 });
            fileFailureReported = false;
        } catch {
            if (!fileFailureReported) try { errorOutput("Signal-hub 日志文件写入失败，请检查目录和磁盘\n"); } catch {}
            fileFailureReported = true;
        }
        if (level === "debug" && !debug) return;
        const success = event === "delivery_sent";
        const tag = success ? "✓" : { debug: "调试", info: "信息", warn: "警告", error: "错误" }[level];
        const shade = success ? 32 : { debug: 90, info: 36, warn: 33, error: 31 }[level];
        const prefix = color ? `\x1b[${shade}m${tag}\x1b[0m` : tag;
        const time = now.toLocaleTimeString("zh-CN", { hour12: false });
        try { output(`${time} ${prefix} ${consoleMessage(event, fields)}\n`); } catch {}
    };
}

export type HubLog = ReturnType<typeof createLogger>;
