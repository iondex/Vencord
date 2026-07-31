/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { CloudDownloadIcon, DeleteIcon, LogIcon, RestartIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import {
    ChannelStore,
    Forms,
    GuildStore,
    Menu,
    MessageStore,
    React,
    showToast,
    Toasts,
    Tooltip,
    useEffect,
    useState,
} from "@webpack/common";

import {
    buildChannelDirectory,
    ChannelBatchQueue,
    collectCachedMessages,
    createApiUrl,
    createChannelMetadata,
    createDeleteLogRecord,
    createMessageLogRecord,
    EnabledChannelLogger,
    isSupportedGuildChannel,
    parseEnabledChannels,
    RemoteChannelStatusLike,
    serializeEnabledChannels,
    validateHealthResult,
    validateLogResult,
} from "./logic";

const DEFAULT_SERVER_URL = "http://127.0.0.1:49322";
const pluginLogger = new Logger("ChannelLogger");
const Native = VencordNative.pluginHelpers.ChannelLogger as PluginNative<typeof import("./native")>;

let enabledChannelIds = new Set<string>();
const closingChannels = new Map<string, EnabledChannelLogger>();

function refreshEnabledChannelIds(value?: string) {
    enabledChannelIds = new Set(parseEnabledChannels(value ?? settings.store.enabledChannels).map(item => item.channelId));
}

const settings = definePluginSettings({
    serverUrl: {
        type: OptionType.STRING,
        description: "本地 channel logger 服务地址（仅允许 loopback HTTP）",
        default: DEFAULT_SERVER_URL,
    },
    enabledChannels: {
        type: OptionType.STRING,
        description: "已开启 logger 的服务器频道",
        default: "[]",
        hidden: true,
        onChange: refreshEnabledChannelIds,
    },
});

const queue = new ChannelBatchQueue(async (channelId, records) => {
    const url = createApiUrl(settings.store.serverUrl.trim(), `/api/channels/${channelId}/log`);
    if (!url) return { ok: false, status: -1, body: "Logger URL must be loopback HTTP" };

    const saved = getEnabledChannels().find(channel => channel.channelId === channelId)
        ?? closingChannels.get(channelId);
    const channel = ChannelStore.getChannel(channelId);
    const guildId = channel?.guild_id ?? saved?.guildId;
    const metadata = createChannelMetadata(
        channelId,
        channel,
        guildId ? GuildStore.getGuild(guildId) : null,
        saved,
    );
    if (!metadata) {
        const body = "Unable to resolve required channel metadata";
        pluginLogger.error(`Failed channel=${channelId}`, body);
        return { ok: false, status: -1, body };
    }

    const result = validateLogResult(await Native.post(url, { channel: metadata, records }), records.length);
    if (!result.ok) pluginLogger.error(`Failed channel=${channelId} status=${result.status}`, result.body);
    return result;
});

queue.subscribe(() => {
    for (const [channelId] of closingChannels) {
        const status = queue.status(channelId);
        if (status.pendingRecords === 0 && !status.inFlight) closingChannels.delete(channelId);
    }
});

interface HistoryEvent {
    channelId: string;
    messages?: any[];
}

interface MessageEvent {
    channelId?: string;
    message?: any;
    optimistic?: boolean;
}

interface DeleteEvent {
    channelId: string;
    id: string;
}

interface BulkDeleteEvent {
    channelId: string;
    ids: string[];
}

interface RemoteChannelStatus extends RemoteChannelStatusLike {
    channelId: string;
    guildId: string | null;
    guildName: string | null;
    channelName: string | null;
    messageCount: number;
    versionCount: number;
    deletedCount: number;
    duplicateCount: number;
    oldestMessageAt: string | null;
    newestMessageAt: string | null;
    firstObservedAt: string | null;
    lastObservedAt: string | null;
    lastWriteAt: string | null;
}

function canLogChannel(channelId: string) {
    return enabledChannelIds.has(channelId) && isSupportedGuildChannel(ChannelStore.getChannel(channelId));
}

function enqueueMessages(channelId: string, messages: any[]) {
    if (!canLogChannel(channelId)) return;
    const observedAt = new Date().toISOString();

    for (const message of messages) {
        const messageChannelId = message?.channel_id ?? message?.channelId;
        if (String(messageChannelId) !== channelId) continue;
        const record = createMessageLogRecord(message, observedAt);
        if (record) queue.enqueue(channelId, record);
    }
}

function handleHistory(event: HistoryEvent) {
    if (Array.isArray(event.messages)) enqueueMessages(event.channelId, event.messages);
}

function handleMessageCreate(event: MessageEvent) {
    const channelId = event.channelId ?? event.message?.channel_id ?? event.message?.channelId;
    if (event.optimistic || typeof channelId !== "string" || !event.message) return;
    enqueueMessages(channelId, [event.message]);
}

function handleMessageUpdate(event: MessageEvent) {
    const channelId = event.channelId ?? event.message?.channel_id ?? event.message?.channelId;
    const messageId = event.message?.id;
    if (typeof channelId !== "string" || typeof messageId !== "string" || !canLogChannel(channelId)) return;

    setTimeout(() => {
        if (!canLogChannel(channelId)) return;
        const completeMessage = MessageStore.getMessage(channelId, messageId);
        if (completeMessage) enqueueMessages(channelId, [completeMessage]);
    }, 0);
}

function handleDeletes(channelId: string, messageIds: string[]) {
    if (!canLogChannel(channelId)) return;
    const observedAt = new Date().toISOString();
    for (const messageId of messageIds) {
        const record = createDeleteLogRecord(messageId, observedAt);
        if (record) queue.enqueue(channelId, record);
    }
}

function getEnabledChannels() {
    return parseEnabledChannels(settings.store.enabledChannels);
}

function saveEnabledChannels(channels: EnabledChannelLogger[]) {
    settings.store.enabledChannels = serializeEnabledChannels(channels);
    refreshEnabledChannelIds(settings.store.enabledChannels);
}

function enableChannelLogger(channel: Channel) {
    if (!isSupportedGuildChannel(channel) || enabledChannelIds.has(channel.id)) return;
    const guild = GuildStore.getGuild(channel.guild_id);
    if (!guild) return;

    closingChannels.delete(channel.id);
    queue.openChannel(channel.id);
    saveEnabledChannels([...getEnabledChannels(), {
        channelId: channel.id,
        guildId: channel.guild_id,
        channelName: channel.name || channel.id,
        guildName: guild.name,
    }]);
    enqueueMessages(channel.id, collectCachedMessages(MessageStore.getMessages(channel.id)));
    showToast(`已开启 ${guild.name} / #${channel.name} 的可见消息 logger`, Toasts.Type.SUCCESS);
}

function disableChannelLogger(channelId: string) {
    const previous = getEnabledChannels();
    const next = previous.filter(item => item.channelId !== channelId);
    if (next.length === previous.length) return;
    const disabled = previous.find(item => item.channelId === channelId)!;
    closingChannels.set(channelId, disabled);
    queue.closeChannel(channelId);
    saveEnabledChannels(next);
    showToast("已停止该频道的新消息记录；服务端历史数据未删除。", Toasts.Type.SUCCESS);
}

const channelContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel;
    if (!isSupportedGuildChannel(channel)) return;
    const enabled = enabledChannelIds.has(channel.id);
    const item = (
        <Menu.MenuItem
            id="vc-channel-logger-toggle"
            key="vc-channel-logger-toggle"
            label={enabled ? "停止记录可见消息" : "开始记录可见消息"}
            icon={LogIcon}
            action={() => enabled ? disableChannelLogger(channel.id) : enableChannelLogger(channel)}
        />
    );
    const group = findGroupChildrenByChildId(["mark-channel-read", "mute-channel", "unmute-channel"], children);
    if (group) group.push(item);
    else children.splice(-1, 0, <Menu.MenuGroup>{item}</Menu.MenuGroup>);
};

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatMessageTime(value: string | null) {
    if (!value) return "未知";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString();
}

function LoggerSettings() {
    const pluginSettings = settings.use(["serverUrl", "enabledChannels"]);
    const enabledChannels = parseEnabledChannels(pluginSettings.enabledChannels);
    const [, setQueueVersion] = useState(0);
    const [checking, setChecking] = useState(false);
    const [health, setHealth] = useState<{ ok: boolean | null; message: string; }>({
        ok: null,
        message: "尚未检查",
    });
    const [remoteStatuses, setRemoteStatuses] = useState<RemoteChannelStatus[]>([]);
    const channels = buildChannelDirectory(
        enabledChannels,
        Array.from(closingChannels.values()),
        remoteStatuses,
    );

    useEffect(() => queue.subscribe(() => setQueueVersion(value => value + 1)), []);
    useEffect(() => void checkHealthAndStatuses(true), [pluginSettings.serverUrl]);

    async function checkHealthAndStatuses(silent = false) {
        const healthUrl = createApiUrl(pluginSettings.serverUrl.trim(), "/api/health");
        if (!healthUrl) {
            setHealth({ ok: false, message: "服务地址必须是本机 HTTP 地址" });
            if (!silent) showToast("Channel logger 服务地址无效", Toasts.Type.FAILURE);
            return;
        }

        setChecking(true);
        const healthResult = await Native.get(healthUrl);
        if (!validateHealthResult(healthResult)) {
            const message = healthResult.ok
                ? `服务响应无效 (${healthResult.status})`
                : `连接失败 (${healthResult.status}): ${healthResult.body}`;
            setHealth({ ok: false, message });
            setChecking(false);
            if (!silent) showToast(message, Toasts.Type.FAILURE);
            return;
        }

        const statusUrl = createApiUrl(pluginSettings.serverUrl.trim(), "/api/channels/status")!;
        const statusResult = await Native.get(statusUrl);
        if (!statusResult.ok) {
            const message = `读取频道状态失败 (${statusResult.status}): ${statusResult.body}`;
            setHealth({ ok: false, message });
            setChecking(false);
            if (!silent) showToast(message, Toasts.Type.FAILURE);
            return;
        }
        try {
            const body = JSON.parse(statusResult.body);
            if (!Array.isArray(body?.channels)) throw new Error("channels must be an array");
            setRemoteStatuses(body.channels as RemoteChannelStatus[]);
        } catch (error) {
            const message = `频道状态响应无效: ${error instanceof Error ? error.message : String(error)}`;
            setHealth({ ok: false, message });
            setChecking(false);
            if (!silent) showToast(message, Toasts.Type.FAILURE);
            return;
        }
        setHealth({ ok: true, message: `服务正常 (${healthResult.status}) · ${new Date().toLocaleTimeString()}` });
        setChecking(false);
        if (!silent) showToast("Channel logger 服务正常", Toasts.Type.SUCCESS);
    }

    function download(channelId: string) {
        const url = createApiUrl(pluginSettings.serverUrl.trim(), `/api/channels/${channelId}/download`);
        if (!url) {
            showToast("Channel logger 服务地址无效", Toasts.Type.FAILURE);
            return;
        }
        VencordNative.native.openExternal(url);
    }

    const healthColor = health.ok === true
        ? "var(--text-positive)"
        : health.ok === false
            ? "var(--text-danger)"
            : "var(--text-muted)";

    return (
        <Flex flexDirection="column" gap="20px">
            <section>
                <Forms.FormTitle tag="h3">Logger 服务</Forms.FormTitle>
                <Flex alignItems="center" justifyContent="space-between" gap="12px" flexWrap="wrap">
                    <div style={{ minWidth: 0 }}>
                        <Forms.FormText style={{ color: healthColor }}>{health.message}</Forms.FormText>
                        <Forms.FormText style={{ fontFamily: "var(--font-code)", overflowWrap: "anywhere" }}>
                            {pluginSettings.serverUrl}
                        </Forms.FormText>
                    </div>
                    <Button size="small" onClick={() => void checkHealthAndStatuses(false)} disabled={checking}>
                        <RestartIcon width={16} height={16} />
                        {checking ? "检查中…" : "Health check"}
                    </Button>
                </Flex>
            </section>

            <section>
                <Forms.FormTitle tag="h3">频道消息记录</Forms.FormTitle>
                {channels.length === 0 && <Forms.FormText>本地服务中没有频道记录。</Forms.FormText>}
                {channels.map(channel => {
                    const runtime = queue.status(channel.channelId);
                    const remote = channel.status as RemoteChannelStatus | null;
                    const currentChannel = ChannelStore.getChannel(channel.channelId);
                    const currentGuild = GuildStore.getGuild(channel.guildId);
                    const channelName = currentChannel?.name ?? channel.channelName;
                    const guildName = currentGuild?.name ?? channel.guildName;

                    return (
                        <Flex
                            key={channel.channelId}
                            alignItems="center"
                            justifyContent="space-between"
                            gap="12px"
                            style={{ borderTop: "1px solid var(--background-modifier-accent)", padding: "12px 0" }}
                        >
                            <div style={{ minWidth: 0 }}>
                                <Forms.FormText><strong>{guildName} / #{channelName}</strong></Forms.FormText>
                                <Forms.FormText style={{ color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                                    {channel.state === "recording" ? "记录中" : channel.state === "closing" ? "正在关闭" : "已停止"}
                                    {` · ${channel.channelId}`}
                                    {channel.state !== "stopped" ? ` · 待发送 ${runtime.pendingRecords} 条 / ${formatBytes(runtime.pendingBytes)}` : ""}
                                </Forms.FormText>
                                {remote && (
                                    <Forms.FormText style={{ color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                                        已保存 {remote.messageCount} 条 · 已标记删除 {remote.deletedCount} 条
                                        {` · 消息时间 ${formatMessageTime(remote.oldestMessageAt)} - ${formatMessageTime(remote.newestMessageAt)}`}
                                    </Forms.FormText>
                                )}
                                {runtime.lastError && (
                                    <Forms.FormText style={{ color: "var(--text-danger)", overflowWrap: "anywhere" }}>
                                        {runtime.lastError}
                                    </Forms.FormText>
                                )}
                            </div>
                            <Flex gap="8px" style={{ flex: "0 0 auto" }}>
                                {remote && <Tooltip text="从本地 logger 服务下载 JSON">
                                    {tooltipProps => (
                                        <Button
                                            {...tooltipProps}
                                            size="iconOnly"
                                            variant="secondary"
                                            aria-label="下载频道 JSON"
                                            onClick={() => download(channel.channelId)}
                                        >
                                            <CloudDownloadIcon width={18} height={18} />
                                        </Button>
                                    )}
                                </Tooltip>}
                                {channel.state === "recording" && (
                                    <Tooltip text="停止记录；保留服务端历史">
                                        {tooltipProps => (
                                            <Button
                                                {...tooltipProps}
                                                size="iconOnly"
                                                variant="dangerSecondary"
                                                aria-label="停止频道 logger"
                                                onClick={() => disableChannelLogger(channel.channelId)}
                                            >
                                                <DeleteIcon width={18} height={18} />
                                            </Button>
                                        )}
                                    </Tooltip>
                                )}
                            </Flex>
                        </Flex>
                    );
                })}
            </section>
        </Flex>
    );
}

export default definePlugin({
    name: "ChannelLogger",
    description: "Logs messages loaded while viewing selected server channels to a local service.",
    authors: [Devs.iondex],
    tags: ["Chat", "Servers", "Utility"],
    settings,

    contextMenus: {
        "channel-context": channelContextMenuPatch,
        "thread-context": channelContextMenuPatch,
    },

    flux: {
        LOAD_MESSAGES_SUCCESS: handleHistory,
        LOAD_MESSAGES_SUCCESS_CACHED: handleHistory,
        LOAD_MESSAGES_AROUND_SUCCESS: handleHistory,
        MESSAGE_CREATE: handleMessageCreate,
        MESSAGE_UPDATE: handleMessageUpdate,
        MESSAGE_DELETE({ channelId, id }: DeleteEvent) {
            handleDeletes(channelId, [id]);
        },
        MESSAGE_DELETE_BULK({ channelId, ids }: BulkDeleteEvent) {
            handleDeletes(channelId, ids);
        },
    },

    start() {
        refreshEnabledChannelIds();
        for (const channelId of enabledChannelIds) queue.openChannel(channelId);
        queue.resume();
    },

    stop() {
        queue.pause();
    },

    settingsAboutComponent: LoggerSettings,
});
