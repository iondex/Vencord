const element = id => document.getElementById(id);
const number = value => new Intl.NumberFormat("zh-CN").format(value ?? 0);
const time = value => value ? new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "暂无";
const duration = seconds => seconds < 60 ? `${Math.floor(seconds)} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟` : `${(seconds / 3600).toFixed(1)} 小时`;
const bytes = value => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${(value / 1024).toFixed(1)} KB`;
const labels = { pending: "排队中", leased: "准备投递", sending: "发送中", sent: "已送达", retry_wait: "等待补发", uncertain: "待对账", held: "已暂缓", dead: "失败待修复", review: "需人工检查", waiting_config: "等待配置", safety_pending: "等待安全确认", routed: "已生成投递", no_matching_route: "无匹配路由", test_mode_filtered: "测试模式过滤", before_forward_cutoff: "早于时间边界", filtered_self: "本人消息", own_output: "本系统输出", self_generated: "防回流过滤", excluded_server: "排除服务器", archived_unsupported: "仅归档", keyword_blocked: "关键词过滤", chinese_blocked: "中文过滤" };
const alertLabels = { history_coverage_degraded: "未配置独立历史补采", config_sync: "配置同步失败", config_stale: "配置缓存过旧", delivery_retries_exhausted: "投递重试耗尽", discord_safety: "目标身份或防回流检查待确认", discord_rejected: "Discord 拒绝投递", route_conflict: "来源匹配多条路由", scheduler_failed: "投递调度异常" };
let snapshot;
let timer;
let loading = false;
function text(id, value) { element(id).textContent = value; }
function list(target, rows, empty) {
    const children = rows.map(([title, detail]) => {
        const item = document.createElement("li");
        const heading = document.createElement("strong"); heading.textContent = title;
        const body = document.createElement("small"); body.textContent = detail;
        item.append(heading, body); return item;
    });
    if (!children.length) { const item = document.createElement("li"); item.className = "empty"; item.textContent = empty; children.push(item); }
    element(target).replaceChildren(...children);
}
function facts(target, entries) {
    element(target).replaceChildren(...entries.flatMap(([label, value]) => {
        const title = document.createElement("dt"); title.textContent = label;
        const detail = document.createElement("dd"); detail.textContent = value;
        return [title, detail];
    }));
}
function renderRoutes() {
    if (!snapshot) return;
    const search = element("search").value.trim().toLowerCase();
    const rows = snapshot.routes.filter(route => `${route.name} ${route.routeId} ${route.target}`.toLowerCase().includes(search))
        .sort((first, second) => second.attention - first.attention || second.queued - first.queued || Number(second.enabled) - Number(first.enabled) || (second.lastSentAt ?? 0) - (first.lastSentAt ?? 0));
    element("routes").replaceChildren(...rows.map(route => {
        const row = document.createElement("tr"); row.dataset.disabled = String(!route.enabled);
        for (const [index, value] of [`${route.name || route.routeId}${route.enabled ? "" : " · 停用"}`, route.target, number(route.matched), number(route.sent), number(route.queued), number(route.attention), time(route.lastSentAt)].entries()) {
            const cell = document.createElement("td"); cell.textContent = value;
            if (index === 5 && route.attention) cell.className = "attention";
            row.append(cell);
        }
        return row;
    }));
    element("route-empty").hidden = rows.length > 0;
}
function chart(rows) {
    const svg = element("timeline");
    const ceiling = Math.max(1, ...rows.flatMap(row => [row.captured, row.delivered, row.failed]));
    const node = (tag, properties) => { const result = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [name, value] of Object.entries(properties)) result.setAttribute(name, value); return result; };
    const nodes = [0, 0.5, 1].map(ratio => node("line", { x1: 0, x2: 900, y1: 170 - ratio * 160, y2: 170 - ratio * 160, stroke: "var(--line)", "stroke-dasharray": "3 5" }));
    rows.forEach((row, index) => {
        const group = node("g", {});
        const title = node("title", {}); title.textContent = `${time(row.time)} · 归档 ${row.captured} · 送达 ${row.delivered} · 失败 ${row.failed}`; group.append(title);
        ["captured", "delivered", "failed"].forEach((key, offset) => {
            if (!row[key]) return;
            const height = Math.max(1, row[key] / ceiling * 160);
            group.append(node("rect", { x: index * 15 + offset * 4 + 1, y: 170 - height, width: 3, height, fill: ["var(--blue)", "var(--green)", "var(--red)"][offset] }));
        });
        nodes.push(group);
    });
    svg.replaceChildren(...nodes);
    text("chart-scale", `峰值 ${ceiling} / 分钟`);
    text("from", new Date(rows[0].time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }));
    text("chart-empty", rows.some(row => row.captured || row.delivered || row.failed) ? "" : "最近 60 分钟暂无流量");
}
function render(data) {
    snapshot = data;
    const stats = data.summary;
    const status = element("health"); status.dataset.state = data.health;
    status.textContent = { healthy: "运行正常", degraded: "运行中 · 需关注", paused: "投递已暂停" }[data.health] ?? "状态未知";
    text("updated", `${time(data.observedAt)} · 每 2 秒更新`);
    element("notice").className = "";
    text("notice", data.paused ? "服务继续采集归档，投递已暂停。" : data.testMode ? "测试模式：仅转发 futu-news。" : "全路由转发已开启，仍按路由规则与防回流检查投递。数据库保留全部采集消息。");
    text("messages", number(stats.messages)); text("received", `采集观察 ${number(stats.receipts)} 次 · 累计送达 ${number(stats.delivered)} 项`);
    text("hour", `${number(stats.capturedLastHour)} / ${number(stats.deliveredLastHour)}`);
    text("today", `今日收 / 发 ${number(data.traffic.today.captured)} / ${number(data.traffic.today.delivered)}`);
    text("queued", number(stats.queued)); text("oldest", stats.oldestPendingAt ? `最早已等待 ${duration(Math.max(0, (data.observedAt - stats.oldestPendingAt) / 1000))}` : "没有待完成投递");
    text("success", stats.successRate24h === null ? "暂无尝试" : `${(stats.successRate24h * 100).toFixed(1)}%`);
    text("failed", `24h 失败尝试 ${number(data.traffic.day.failedAttempts)} 次 · 近 1 分钟收 / 发 ${number(data.traffic.minute.captured)} / ${number(data.traffic.minute.delivered)}`);
    text("mode", data.testMode ? "测试模式" : "全路由模式");
    facts("runtime", [["服务持续运行", duration(data.uptimeSeconds)], ["配置同步", data.config.syncedAt ? `${time(data.config.syncedAt)} · ${duration(data.config.ageSeconds)}前` : "暂无有效配置"], ["最后接收 / 送达", `${time(stats.lastCapturedAt)} / ${time(stats.lastDeliveredAt)}`], ["发送耗时 P95", data.deliveryDurationP95Ms === null ? "暂无成功样本" : `${number(data.deliveryDurationP95Ms)} ms · 最近 ${number(data.deliveryDurationSamples)} 次成功尝试`], ["数据库 / 进程内存", `${bytes(data.resources.databaseBytes)} / ${bytes(data.resources.rssBytes)}`], ["隔离记录 / 进程", `${number(data.quarantined)} 条 / PID ${data.resources.pid}`]]);
    element("pipeline").replaceChildren(...["pending", "sending", "sent", "retry_wait", "uncertain", "held", "leased", "review", "dead"].map(state => {
        const item = document.createElement("dl"); const title = document.createElement("dt"); const value = document.createElement("dd");
        title.textContent = labels[state]; value.textContent = number(data.jobStates.filter(row => row.kind !== "extract" && row.state === state).reduce((total, row) => total + row.total, 0)); item.append(title, value); return item;
    }));
    const extract = data.jobStates.filter(row => row.kind === "extract" && row.state !== "sent").reduce((total, row) => total + row.total, 0);
    text("archive-states", `解析任务未完成 ${number(extract)} · ${data.messageStates.map(row => `${labels[row.state] ?? row.state} ${number(row.total)}`).join(" · ") || "暂无归档"}`);
    text("route-count", `${data.config.enabledRoutes} / ${data.config.routes} 已启用`); renderRoutes(); chart(data.timeline);
    text("alert-count", `${data.activeAlerts.length} 项`);
    list("alerts", data.activeAlerts.map(alert => [alertLabels[alert.code] || alert.code, `${alert.code} · ${alert.severity === "critical" ? "严重" : "警告"} · ${time(alert.since)}${alert.lastNotifiedAt ? ` · 最近通知 ${time(alert.lastNotifiedAt)}` : " · 等待通知"}`]), "暂无活动告警");
    list("failures", data.recentFailures.map(failure => [failure.code || failure.outcome, `${time(failure.time)} · ${data.routes.find(route => route.routeId === failure.routeId)?.name || failure.routeId} → ${failure.target}${failure.status ? ` · HTTP ${failure.status}` : ""}`]), "暂无失败尝试");
}
async function refresh() {
    clearTimeout(timer);
    if (loading) return;
    loading = true; element("refresh").disabled = true;
    try {
        const response = await fetch("/api/status", { cache: "no-store", signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error("unavailable");
        render(await response.json());
    } catch {
        element("health").dataset.state = "offline"; text("health", "连接中断"); element("notice").className = "error";
        text("notice", `暂时无法读取服务状态，将自动重试。${snapshot ? `当前数据停留在 ${time(snapshot.observedAt)}。` : "请检查 Signal-hub 进程和 9900 端口。"}`);
    } finally { loading = false; element("refresh").disabled = false; timer = setTimeout(refresh, document.hidden ? 10000 : 2000); }
}
element("refresh").addEventListener("click", refresh);
element("search").addEventListener("input", renderRoutes);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
void refresh();
