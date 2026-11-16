/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { Paragraph } from "@components/Paragraph";
import { OptionComponentMap } from "@components/settings/tabs/plugins/components";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import definePlugin, { OptionType, PluginNative, PluginSettingComponentProps } from "@utils/types";
import type { MessageJSON } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { ChannelStore, GuildStore, Select, showToast, TabBar, useEffect, UserStore, useState } from "@webpack/common";
import type { ReactNode } from "react";

import type { LocalRouteTest, LocalServiceStatus } from "../../../signal-hub/contracts/diagnostics";
import { jsonSafe } from "../../../signal-hub/contracts/ingest";
import { createForwarderStats, createHealthUrl, getForwardSkipReason, localSkipReason, normalizeLegacyMessage } from "./logic";

const DEFAULT_SERVER_URL = "https://forwarder.yufeng.run/forward";
const DEFAULT_FALLBACK_URL = "";
const DEFAULT_DINGTALK_WEBHOOK_URL = "";

const logger = new Logger("forwarder");
const Native = VencordNative.pluginHelpers.forwarder as PluginNative<typeof import("./native")>;
const notificationsShouldNotify = findByCodeLazy(".SUPPRESS_NOTIFICATIONS))return!1");
const stats = createForwarderStats();

const settings = definePluginSettings({
    mode: {
        type: OptionType.COMPONENT,
        component: ErrorBoundary.wrap(ForwarderSettings, { noop: false }),
        default: "local" as "local" | "remote",
        restartNeeded: true,
    },
    localServerUrl: {
        type: OptionType.STRING,
        displayName: "本地服务地址",
        description: "本机或内网 Signal-hub 地址。",
        placeholder: "http://127.0.0.1:49321/forward",
        default: "http://127.0.0.1:49321/forward",
        restartNeeded: true,
        hidden: true,
    },
    localPairingToken: {
        type: OptionType.STRING,
        displayName: "连接令牌（可选）",
        description: "与服务端 pairingToken 一致，默认留空。",
        placeholder: "默认留空",
        componentProps: { type: "password" },
        default: "",
        restartNeeded: true,
        hidden: true,
    },
    excludedServerIds: {
        type: OptionType.STRING,
        displayName: "排除的服务器",
        description: "ID 用逗号或空格分隔；两个模式共用。",
        placeholder: "可选：服务器 ID",
        default: "",
        restartNeeded: true,
        hidden: true,
    },
    serverUrl: {
        type: OptionType.STRING,
        displayName: "主转发地址",
        description: "兼容旧版 CF Worker 的接收接口。",
        placeholder: "请输入主转发地址",
        default: DEFAULT_SERVER_URL,
        hidden: true,
    },
    fallbackUrl: {
        type: OptionType.STRING,
        displayName: "备用转发地址",
        description: "主接口失败后使用，留空禁用。",
        placeholder: "留空禁用备用接口",
        default: DEFAULT_FALLBACK_URL,
        hidden: true,
    },
    enableDingTalkAlerts: {
        type: OptionType.BOOLEAN,
        displayName: "钉钉故障通知",
        description: "主、备用接口均失败时通知。",
        default: false,
        hidden: true,
    },
    dingTalkWebhookUrl: {
        type: OptionType.STRING,
        displayName: "钉钉机器人地址",
        description: "用于远程模式的最终投递失败告警。",
        placeholder: "请输入钉钉机器人 Webhook 地址",
        default: DEFAULT_DINGTALK_WEBHOOK_URL,
        disabled() { return !this.store.enableDingTalkAlerts; },
        hidden: true,
    },
    logFailures: {
        type: OptionType.BOOLEAN,
        displayName: "记录失败日志",
        description: "在控制台记录远程转发失败的详细信息。",
        default: true,
        hidden: true,
    },
}).withPrivateSettings<{ localRuntimeDirectory?: string; }>();

interface ForwarderMessage extends MessageJSON {
    sticker_items?: unknown[];
}

type HealthCheckState =
    | { status: "idle"; message: string; }
    | { status: "checking"; message: string; }
    | { status: "ok"; message: string; }
    | { status: "error"; message: string; };

function sanitizeForJson(value: unknown) {
    const seen = new WeakSet<object>();

    return JSON.parse(JSON.stringify(value, (_key, item) => {
        if (typeof item === "bigint") return item.toString();
        if (typeof item === "function") return undefined;

        if (typeof item === "object" && item !== null) {
            if (seen.has(item)) return "[Circular]";
            seen.add(item);
        }

        return item;
    }));
}

function compactUser(user: any) {
    if (!user) return null;

    return sanitizeForJson({
        id: user.id,
        username: user.username,
        globalName: user.globalName ?? user.global_name ?? "",
        discriminator: user.discriminator,
        bot: user.bot,
        system: user.system,
        avatar: user.avatar
    });
}

function normalizeAttachment(attachment: any) {
    const proxyUrl = attachment.proxy_url ?? attachment.proxyUrl ?? undefined;
    const url = attachment.url ?? "";
    const downloadUrl = proxyUrl ?? url;

    return sanitizeForJson({
        id: attachment.id,
        filename: attachment.filename,
        size: attachment.size,
        contentType: attachment.content_type ?? attachment.contentType ?? undefined,
        spoiler: attachment.spoiler,
        width: attachment.width,
        height: attachment.height,
        url,
        proxyUrl,
        download: {
            strategy: "server-fetch",
            url: downloadUrl,
            sourceField: proxyUrl ? "proxy_url" : "url"
        },
        raw: attachment
    });
}

function buildNotificationTitle(message: ForwarderMessage, channel: any, guild: any) {
    const username = message.author?.globalName || message.author?.username || "Unknown User";

    if (guild && channel) {
        return `${username} in ${guild.name} / #${channel.name}`;
    }

    if (channel?.name) {
        return `${username} in ${channel.name}`;
    }

    return username;
}

function buildNotificationBody(message: ForwarderMessage) {
    const parts: string[] = [];
    const content = message.content?.trim();

    if (content) parts.push(content);
    if (message.embeds?.length) parts.push(`[${message.embeds.length} embed${message.embeds.length === 1 ? "" : "s"}]`);
    if (message.attachments?.length) {
        parts.push(`[${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}]`);
    }
    if (message.sticker_items?.length) {
        parts.push(`[${message.sticker_items.length} sticker${message.sticker_items.length === 1 ? "" : "s"}]`);
    }

    return parts.join(" ") || "(empty message)";
}

function shouldForward(message: ForwarderMessage, optimistic?: boolean) {
    const channel = message?.channel_id ? ChannelStore.getChannel(message.channel_id) : null;
    let discordShouldNotify = false;
    try {
        discordShouldNotify = Boolean(message?.channel_id && notificationsShouldNotify(message, message.channel_id));
    } catch (error) {
        if (settings.store.logFailures) {
            logger.error("Failed to check notification eligibility", error);
        }
    }

    const skipReason = getForwardSkipReason({
        optimistic,
        message,
        channel,
        currentUserId: UserStore.getCurrentUser()?.id,
        discordShouldNotify,
    });

    if (skipReason) {
        stats.recordFiltered(skipReason);
        return false;
    }

    return true;
}

function createPayload(message: ForwarderMessage) {
    const channel = ChannelStore.getChannel(message.channel_id);
    const guildId = message.guild_id ?? channel?.guild_id;
    const guild = guildId ? GuildStore.getGuild(guildId) : null;
    const rawMessage = sanitizeForJson(message);
    const attachments = (message.attachments ?? []).map(normalizeAttachment);

    return sanitizeForJson({
        source: {
            plugin: "forwarder",
            client: "Vencord",
            kind: "notification"
        },
        forwardedAt: new Date().toISOString(),
        notification: {
            title: buildNotificationTitle(message, channel, guild),
            body: buildNotificationBody(message),
            mentionEveryone: message.mention_everyone,
            mentionRoles: message.mention_roles ?? [],
            mentionUserIds: message.mentions?.map(user => user.id) ?? [],
            hasAttachments: Boolean(message.attachments?.length),
            hasEmbeds: Boolean(message.embeds?.length)
        },
        metadata: {
            currentUser: compactUser(UserStore.getCurrentUser()),
            channel: channel
                ? {
                    id: channel.id,
                    name: channel.name,
                    type: channel.type,
                    guildId: channel.guild_id
                }
                : {
                    id: message.channel_id,
                    guildId
                },
            guild: guild
                ? {
                    id: guild.id,
                    name: guild.name
                }
                : null
        },
        message: normalizeLegacyMessage({
            id: message.id,
            channelId: message.channel_id,
            guildId,
            author: compactUser(message.author),
            content: message.content,
            timestamp: message.timestamp,
            editedTimestamp: message.edited_timestamp,
            type: message.type,
            flags: message.flags,
            tts: message.tts,
            pinned: message.pinned,
            mentions: message.mentions ?? [],
            mentionRoles: message.mention_roles ?? [],
            mentionEveryone: message.mention_everyone,
            attachments,
            embeds: message.embeds ?? [],
            components: message.components ?? [],
            referencedMessage: message.referenced_message ?? null,
            raw: rawMessage
        })
    });
}

let activeMode: "local" | "remote" | undefined;
let localReady: Promise<unknown> | undefined;

async function forwardLocal(message: ForwarderMessage, optimistic?: boolean) {
    const channel = message?.channel_id ? ChannelStore.getChannel(message.channel_id) : null;
    const parent = channel?.parent_id ? ChannelStore.getChannel(channel.parent_id) : null;
    const context = { guild_id: channel?.guild_id || parent?.guild_id, type: channel?.type };
    const accountId = UserStore.getCurrentUser()?.id;
    const excludedServerIds = settings.store.excludedServerIds.split(/[\s,]+/).filter(Boolean);
    const reason = localSkipReason(message, context, accountId, optimistic, excludedServerIds);
    if (reason) return;
    const serverId = message.guild_id || context?.guild_id;
    const envelope = jsonSafe({
        schemaVersion: 2,
        eventId: `discord:${accountId}:${message.channel_id}:${message.id}:create`,
        eventType: "MESSAGE_CREATE",
        capturedAt: new Date().toISOString(),
        accountId,
        serverId,
        channelId: message.channel_id,
        parentChannelId: channel?.parent_id,
        excludedServerIds,
        message,
    });
    await localReady;
    const result = await Native.enqueueLocal(envelope);
    stats.recordForwardAttempt(result.ok);
}

async function forwardMessage(message: ForwarderMessage) {
    const serverUrl = settings.store.serverUrl.trim();

    const result = await Native.send({
        primaryUrl: serverUrl,
        fallbackUrl: settings.store.fallbackUrl.trim(),
        payload: createPayload(message),
        context: {
            messageId: message.id,
            channelId: message.channel_id,
            guildId: message.guild_id,
        },
        dingTalk: {
            enabled: settings.store.enableDingTalkAlerts,
            webhookUrl: settings.store.dingTalkWebhookUrl.trim(),
        },
    });
    stats.recordForwardAttempt(result.ok);
    if (!result.ok && settings.store.logFailures) {
        logger.error(`Failed to forward notification (${result.status})`, result.errorSummary ?? result.body, result.attempts);
    }
}

async function checkHealth(serverUrl: string) {
    if (!serverUrl) {
        return { ok: false, status: -1, body: "服务地址为空" };
    }

    const healthUrl = createHealthUrl(serverUrl);
    if (!healthUrl) {
        return { ok: false, status: -1, body: "服务地址无效" };
    }

    try { return await Native.get(healthUrl); }
    catch { return { ok: false, status: -1, body: "暂时无法检查远程接口，请稍后重试" }; }
}

function HealthLine({ label, health }: { label: string; health: HealthCheckState; }) {
    const color = health.status === "ok"
        ? "var(--text-positive)"
        : health.status === "error"
            ? "var(--text-danger)"
            : "var(--text-muted)";

    return (
        <Paragraph style={{ color }}>
            <strong>{label}:</strong> {health.message}
        </Paragraph>
    );
}

function dashboardAddress(address: string, port: number) {
    try {
        const url = new URL(address);
        url.port = String(port);
        url.pathname = "/";
        url.search = "";
        url.hash = "";
        return url.toString();
    } catch { return undefined; }
}

function LocalTransportSettings() {
    const { localServerUrl, localPairingToken, excludedServerIds } = settings.use(["localServerUrl", "localPairingToken", "excludedServerIds"]);
    const [status, setStatus] = useState<Awaited<ReturnType<typeof Native.localStatus>> | null>(null);
    const [service, setService] = useState<LocalServiceStatus | null>(null);
    const [changingMode, setChangingMode] = useState(false);
    const [recovering, setRecovering] = useState(false);
    const [recoveryMessage, setRecoveryMessage] = useState("");
    const [health, setHealth] = useState<HealthCheckState>({ status: "idle", message: "尚未检查服务状态。" });
    const [routeId, setRouteId] = useState("");
    const [test, setTest] = useState<LocalRouteTest | null>(null);
    const [testRequest, setTestRequest] = useState<{ routeId: string; requestId: string; } | null>(null);
    const [testing, setTesting] = useState(false);
    const [testMessage, setTestMessage] = useState("");
    const connection = { url: localServerUrl.trim(), token: localPairingToken.trim() };
    const currentConnection = () => settings.store.localServerUrl.trim() === connection.url
        && settings.store.localPairingToken.trim() === connection.token && settings.store.excludedServerIds === excludedServerIds;
    const excluded = excludedServerIds.split(/[\s,]+/);
    const routes = service?.routes.filter(route => route.enabled && !route.excluded && !excluded.includes(route.serverId)) ?? [];
    const selectedRoute = routes.find(route => route.routeId === routeId);

    useEffect(() => {
        setService(null);
        setRouteId("");
        setTest(null);
        setTestRequest(null);
        setTestMessage("");
        setTesting(false);
        setChangingMode(false);
        setRecoveryMessage("");
        setHealth({ status: "idle", message: "连接配置已就绪，请检查服务状态。" });
    }, [localServerUrl, localPairingToken, excludedServerIds]);

    const check = async () => {
        setHealth({ status: "checking", message: "正在检查……" });
        try {
            const [queue, result] = await Promise.all([Native.localStatus().catch(() => null), Native.checkLocalService(connection)]);
            if (!currentConnection()) return;
            setStatus(queue);
            if (!result.ok) {
                setService(null);
                setHealth({ status: "error", message: result.message });
                return;
            }
            setService(result.data);
            setHealth({ status: "ok", message: result.data.paused ? "在线 · 投递已暂停" : "在线 · 投递运行中" });
        } catch {
            if (!currentConnection()) return;
            setService(null);
            setHealth({ status: "error", message: "无法检查服务状态，请查看本地进程和网络。" });
        }
    };

    useEffect(() => {
        if (!service) return;
        let disposed = false;
        let refreshing = false;
        const refresh = async () => {
            if (refreshing) return;
            refreshing = true;
            try {
                const [queue, result] = await Promise.all([Native.localStatus(), Native.checkLocalService(connection)]);
                if (disposed || !currentConnection()) return;
                setStatus(queue);
                if (result.ok) {
                    setService(result.data);
                    setHealth({ status: "ok", message: result.data.paused ? "在线 · 投递已暂停" : "在线 · 投递运行中" });
                } else setHealth({ status: "error", message: `${result.message}；统计保留上次结果。` });
            } catch { if (!disposed && currentConnection()) setHealth({ status: "error", message: "状态刷新失败；统计保留上次结果。" }); }
            finally { refreshing = false; }
        };
        const interval = setInterval(() => { void refresh(); }, 5000);
        return () => { disposed = true; clearInterval(interval); };
    }, [Boolean(service), localServerUrl, localPairingToken, excludedServerIds]);

    async function refreshTest() {
        if (!test) return;
        try {
            const result = await Native.localTestStatus(connection, test.requestId);
            if (!currentConnection()) return;
            if (result.ok) { setTest(result.data); setTestMessage(""); }
            else setTestMessage(result.message);
        } catch { if (currentConnection()) setTestMessage("暂时无法查询结果，测试任务仍保留在服务端，可稍后刷新。"); }
    }

    useEffect(() => {
        if (!test || !["pending", "leased", "sending"].includes(test.state)) return;
        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const result = await Native.localTestStatus(connection, test.requestId);
                if (cancelled) return;
                if (result.ok) setTest(result.data);
                else setTestMessage(result.message);
            } catch { if (!cancelled) setTestMessage("查询中断，请刷新结果。"); }
        }, 2000);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [test, localServerUrl, localPairingToken]);

    async function sendTest() {
        if (!selectedRoute || service?.paused || testing) return;
        setTesting(true);
        const request = testRequest?.routeId === routeId && !test ? testRequest : { routeId, requestId: crypto.randomUUID() };
        setTestRequest(request);
        setTest(null);
        setTestMessage("");
        try {
            const result = await Native.testLocalRoute(connection, request.routeId, request.requestId);
            if (!currentConnection()) return;
            if (result.ok) setTest(result.data);
            else setTestMessage(result.message);
        } catch { if (currentConnection()) setTestMessage("提交结果未知，请重试提交；同一测试编号不会重复创建任务。"); }
        finally { if (currentConnection()) setTesting(false); }
    }

    async function toggleTestMode() {
        if (!service || changingMode) return;
        setChangingMode(true);
        try {
            const result = await Native.setLocalTestMode(connection, !service.testMode);
            if (!currentConnection()) return;
            if (result.ok) { setService(result.data); setRouteId(""); }
            else setTestMessage(result.message);
        } catch { if (currentConnection()) setTestMessage("切换失败，请重新检查服务状态。"); }
        finally { if (currentConnection()) setChangingMode(false); }
    }

    const stateLabels: Record<string, string> = {
        pending: "排队中", leased: "准备投递", sending: "发送中", sent: "已送达",
        retry_wait: "等待重试", uncertain: "待对账", held: "已暂缓",
        review: "需要人工检查", dead: "投递失败，任务已保留",
    };

    return (
        <Flex className="vc-forwarder-runtime" flexDirection="column" gap="20px">
            <Flex gap="12px" alignItems="center" flexWrap="wrap">
                <Button onClick={check} disabled={health.status === "checking"}>{health.status === "checking" ? "正在检查……" : "检查本地 API"}</Button>
                {service && <a href={dashboardAddress(connection.url, service.dashboardPort ?? 9900)} target="_blank" rel="noreferrer">打开状态页</a>}
                <span className="vc-forwarder-muted">检查后每 5 秒刷新</span>
            </Flex>
            <HealthLine label="Signal-hub（上次检查）" health={health} />
            {service && <>
                {service.paused && <Paragraph>仅采集归档。POST /api/resume 后重新检查。</Paragraph>}
                {typeof service.testMode === "boolean" && <Flex gap="16px" alignItems="center" flexWrap="wrap">
                    <Button variant="secondary" onClick={toggleTestMode} disabled={changingMode}>{service.testMode ? "关闭测试模式" : "开启测试模式"}</Button>
                    <Paragraph>测试模式：{service.testMode ? "开启，仅转发 futu-news" : "关闭"}</Paragraph>
                </Flex>}
                {service.statistics && <dl className="vc-forwarder-statistics">
                    {[
                        ["归档消息", service.statistics.messages.toLocaleString()],
                        ["累计送达任务", service.statistics.delivered.toLocaleString()],
                        ["近 1h 收 / 发", `${service.statistics.capturedLastHour} / ${service.statistics.deliveredLastHour}`],
                        ["待完成投递", service.statistics.queued.toLocaleString()],
                        ["24h 尝试成功率", service.statistics.successRate24h === null ? "暂无尝试" : `${(service.statistics.successRate24h * 100).toFixed(1)}%`],
                        ["最后送达", service.statistics.lastDeliveredAt ? new Date(service.statistics.lastDeliveredAt).toLocaleTimeString() : "暂无"],
                    ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
                </dl>}
                <Paragraph>可用路由 {routes.length} · 配置同步 {service.configSyncedAt ? new Date(Number(service.configSyncedAt)).toLocaleString() : "暂无"}</Paragraph>
                <Paragraph>服务任务（含分段）：{service.jobs.map(job => `${stateLabels[job.state] ?? "其他"} ${job.total}`).join(" · ") || "0"}</Paragraph>
                <div className="vc-forwarder-route-test"><Paragraph><strong>转发测试</strong></Paragraph>
                    <Select
                    options={routes.map(route => ({ label: `${route.name || route.routeId} → ${route.targetChannelId}`, value: route.routeId }))}
                    select={(value: string) => { setRouteId(value); }}
                    isSelected={value => value === routeId}
                    serialize={value => String(value)}
                    placeholder="选择要测试的路由"
                    maxVisibleItems={6}
                    closeOnSelect={true}
                    />
                <Paragraph>向所选目标真实发送一条测试消息。</Paragraph>
                <Flex gap="12px" flexWrap="wrap">
                    <Button onClick={sendTest} disabled={!selectedRoute || service.paused || health.status !== "ok" || testing || Boolean(test && test.routeId === routeId && test.state !== "sent")}>
                        {testing ? "正在提交……" : testRequest && !test ? "重试提交" : "测试转发"}
                    </Button>
                    {test && <Button variant="secondary" onClick={refreshTest}>刷新结果</Button>}
                </Flex></div>
            </>}
            {testMessage && <Paragraph>{testMessage}</Paragraph>}
            {test && <>
                <Paragraph title={test.requestId}>测试：{stateLabels[test.state] ?? "未知状态"} · 尝试 {test.attempts} 次{test.error ? ` · ${test.error}` : ""}</Paragraph>
            </>}
            {status && <>
                <Paragraph><strong>本机持久队列</strong></Paragraph>
                <Paragraph>本机队列：{status.active ? "运行中" : "未运行"} · 待交接 {status.pending} · 已交接 {status.acked} · 隔离 {status.quarantined}</Paragraph>
                {Boolean(status.uncommitted || status.rejectedCaptures || status.persistenceError || status.queueError) && <Paragraph style={{ color: "var(--text-danger)" }}>
                    尚未落盘 {status.uncommitted ?? 0} 条 · 缓冲区满拒绝 {status.rejectedCaptures ?? 0} 次。{status.persistenceError ?? status.queueError}
                </Paragraph>}
                {Boolean(status.quarantined) && <>
                    <Paragraph>隔离原因：{status.quarantineReasons?.map(item => `${item.reason} ${item.total}`).join(" · ") || "历史记录，原因未知"}</Paragraph>
                    <Button variant="secondary" disabled={!status.active || !status.retryableQuarantined || recovering} onClick={async () => {
                        setRecovering(true);
                        try {
                            const result = await Native.retryLocalQuarantine();
                            setRecoveryMessage(`已重新排队 ${result.requeued} 条，保留检查 ${result.held} 条。`);
                            setStatus(await Native.localStatus());
                        } catch { setRecoveryMessage("重交未完成，请检查本机队列与磁盘状态。"); }
                        finally { setRecovering(false); }
                    }}>{recovering ? "正在重交……" : `重交可恢复记录（${status.retryableQuarantined ?? 0}）`}</Button>
                    <Paragraph>修复接收地址、版本或请求大小限制后再重交；冲突和损坏记录保留检查。</Paragraph>
                </>}
                {recoveryMessage && <Paragraph>{recoveryMessage}</Paragraph>}
                <Paragraph>最近交接：{status.lastAcknowledgedAt ? new Date(status.lastAcknowledgedAt).toLocaleString() : "暂无"}{status.oldestPendingAt ? ` · 最早等待 ${Math.max(0, Math.floor((Date.now() - status.oldestPendingAt) / 60000))} 分钟` : ""}</Paragraph>
                <Paragraph>每日 20:00（上海时间）清理已交接副本，未交接和隔离消息保留。</Paragraph>
                {status.lastCleanupAt && <Paragraph>上次清理：{new Date(status.lastCleanupAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} · {status.lastCleanupCount} 条 · 释放 {((status.lastCleanupBytes ?? 0) / 1048576).toFixed(2)} MB</Paragraph>}
                {status.nextCleanupAt && <Paragraph>下次清理：{new Date(status.nextCleanupAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} · 累计清理 {status.totalCleaned ?? 0} 条</Paragraph>}
                {status.cleanupError && <Paragraph>{status.cleanupError}</Paragraph>}
                {(status.staged > 0 || status.consecutiveFailures > 0) && <Paragraph>暂存 {status.staged} · 连续失败 {status.consecutiveFailures}</Paragraph>}
                {status.lastError && <Paragraph>{status.lastError}</Paragraph>}
            </>}
        </Flex>
    );
}

function RemoteTransportSettings() {
    const [primaryHealth, setPrimaryHealth] = useState<HealthCheckState>({
        status: "idle",
        message: "尚未检查服务状态。"
    });
    const remoteSettings = settings.use(["serverUrl", "fallbackUrl", "localServerUrl"]);
    const fallbackUrl = remoteSettings.fallbackUrl.trim();
    const [fallbackHealth, setFallbackHealth] = useState<HealthCheckState>({
        status: fallbackUrl ? "idle" : "error",
        message: fallbackUrl ? "尚未检查服务状态。" : "未配置"
    });
    const [statsSnapshot, setStatsSnapshot] = useState(stats.snapshot());
    const displayedFallbackHealth: HealthCheckState = !fallbackUrl
        ? { status: "error", message: "未配置" }
        : fallbackHealth.message === "未配置"
            ? { status: "idle", message: "尚未检查服务状态。" }
            : fallbackHealth;

    const refreshStats = () => setStatsSnapshot(stats.snapshot());
    const clearStats = () => {
        stats.reset();
        refreshStats();
    };

    async function handlePrimaryHealthCheck() {
        setPrimaryHealth({ status: "checking", message: "正在检查主接口……" });
        const result = await checkHealth(settings.store.serverUrl.trim());
        const duration = result.durationMs === undefined ? "" : `，耗时 ${result.durationMs} 毫秒`;

        if (result.ok) {
            setPrimaryHealth({ status: "ok", message: `主接口正常（HTTP ${result.status}）${duration}` });
            showToast({ text: "主转发接口运行正常", variant: "success" });
        } else {
            const message = `主接口检查失败（HTTP ${result.status}）${duration}`;
            setPrimaryHealth({ status: "error", message });
            showToast({ text: message, variant: "critical" });
        }
    }

    async function handleFallbackHealthCheck() {
        if (!fallbackUrl) {
            setFallbackHealth({ status: "error", message: "未配置" });
            return;
        }

        setFallbackHealth({ status: "checking", message: "正在检查备用接口……" });
        const result = await checkHealth(fallbackUrl);
        const duration = result.durationMs === undefined ? "" : `，耗时 ${result.durationMs} 毫秒`;
        if (result.ok) {
            setFallbackHealth({ status: "ok", message: `备用接口正常（HTTP ${result.status}）${duration}` });
            showToast({ text: "备用转发接口运行正常", variant: "success" });
        } else {
            const message = `备用接口检查失败（HTTP ${result.status}）${duration}`;
            setFallbackHealth({ status: "error", message });
            showToast({ text: message, variant: "critical" });
        }
    }

    return (
        <Flex className="vc-forwarder-settings" flexDirection="column" gap="24px">
            {remoteSettings.serverUrl.trim() === remoteSettings.localServerUrl.trim() && <Paragraph style={{ color: "var(--text-warning)" }}>主地址与 Local 接口相同，请改为旧版 CF Worker 接口。</Paragraph>}
            <Flex gap="8px" flexWrap="wrap">
                <Button onClick={() => void handlePrimaryHealthCheck()} disabled={primaryHealth.status === "checking"}>
                    {primaryHealth.status === "checking" ? "正在检查主接口……" : "检查主接口"}
                </Button>
                <Button onClick={() => void handleFallbackHealthCheck()} disabled={!fallbackUrl || fallbackHealth.status === "checking"}>
                    {fallbackHealth.status === "checking" ? "正在检查备用接口……" : "检查备用接口"}
                </Button>
                <Button variant="secondary" onClick={refreshStats}>刷新统计</Button>
                <Button variant="secondary" onClick={clearStats}>清空统计</Button>
            </Flex>

            <HealthLine label="主接口" health={primaryHealth} />
            <HealthLine label="备用接口" health={displayedFallbackHealth} />

            <div className={Margins.top8}>
                <Paragraph>本次运行：成功 {statsSnapshot.forwarded} · 失败 {statsSnapshot.failed} · 过滤 {statsSnapshot.filteredSelf + statsSnapshot.filteredNonGuild + statsSnapshot.filteredDiscord}</Paragraph>
            </div>
        </Flex>
    );
}

function ForwarderSettings({ setValue, closePluginSettings }: PluginSettingComponentProps): ReactNode {
    const values = settings.use();
    const { mode } = values;
    const modeLabel = mode === "local" ? "本地（Local）" : "远程（Remote）";
    const activeLabel = activeMode === "local" ? "本地（Local）" : activeMode === "remote" ? "远程（Remote）" : "未运行";
    const fields = mode === "local"
        ? ["localServerUrl", "localPairingToken", "excludedServerIds"] as const
        : ["serverUrl", "fallbackUrl", "enableDingTalkAlerts", "dingTalkWebhookUrl", "logFailures", "excludedServerIds"] as const;
    return (
        <Flex flexDirection="column" gap="12px">
            <TabBar type="top" look="brand" selectedItem={mode} onItemSelect={setValue}>
                <TabBar.Item id="local">本地（Local）</TabBar.Item>
                <TabBar.Item id="remote">远程（Remote）</TabBar.Item>
            </TabBar>
            <Paragraph>当前：{activeLabel} · 切换模式后重启生效。</Paragraph>
            {activeMode && activeMode !== mode && <Paragraph>待切换：{modeLabel}。</Paragraph>}
            {fields.map(key => {
                const setting = settings.def[key];
                const Component = OptionComponentMap[setting.type];
                return <div className="vc-forwarder-field" key={key}><Component
                    key={key}
                    id={key}
                    setting={setting}
                    definedSettings={settings}
                    pluginSettings={{ ...values, enabled: true }}
                    closePluginSettings={closePluginSettings}
                    onChange={value => {
                        Object.assign(settings.store, { [key]: value });
                        if ("restartNeeded" in setting && setting.restartNeeded) setValue(mode);
                    }}
                /></div>;
            })}
            {mode === "local" ? <LocalTransportSettings /> : <RemoteTransportSettings />}
        </Flex>
    );
}

export default definePlugin({
    name: "forwarder",
    enabledByDefault: true,
    description: "将 Discord 服务器消息交给本地 Signal-hub，或通过远程接口转发通知。",
    authors: [Devs.iondex],
    tags: ["Notifications", "Utility"],
    settings,

    start() {
        activeMode = settings.store.mode === "remote" ? "remote" : "local";
        if (activeMode !== "local") return;
        localReady = Native.configureLocal({
            url: settings.store.localServerUrl.trim(),
            runtimeDirectory: settings.store.localRuntimeDirectory?.trim(),
            token: settings.store.localPairingToken.trim(),
        });
        void localReady.catch(() => logger.error("Local handoff configuration failed; check URL, runtime directory and pairing token"));
    },

    stop() {
        activeMode = undefined;
        localReady = undefined;
        void Native.stopLocal().catch(() => logger.error("Unable to stop local sender"));
    },

    flux: {
        MESSAGE_CREATE({ message, optimistic }: { message: ForwarderMessage; optimistic?: boolean; }) {
            if (!activeMode) return;
            void (async () => {
                if (activeMode === "local") {
                    await forwardLocal(message, optimistic);
                } else if (shouldForward(message, optimistic)) {
                    const channel = ChannelStore.getChannel(message.channel_id);
                    const serverId = message.guild_id || channel?.guild_id;
                    if (settings.store.excludedServerIds.split(/[\s,]+/).includes(serverId ?? "")) return;
                    await forwardMessage(message);
                }
            })().catch(() => {
                stats.recordForwardAttempt(false);
                logger.error("Message handoff failed; inspect forwarder configuration and native queue status");
            });
        }
    },
});
