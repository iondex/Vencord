/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { MessageJSON } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { ChannelStore, GuildStore, showToast, UserStore, useState } from "@webpack/common";

import { jsonSafe } from "../../../signal-hub/contracts/ingest";
import { createForwarderStats, createHealthUrl, getForwardSkipReason, localSkipReason, normalizeLegacyMessage } from "./logic";

const DEFAULT_SERVER_URL = "http://127.0.0.1:49321/forward";
const DEFAULT_FALLBACK_URL = "https://forwarder.yufeng.run/forward";
const DEFAULT_DINGTALK_WEBHOOK_URL = "";

const logger = new Logger("forwarder");
const Native = VencordNative.pluginHelpers.forwarder as PluginNative<typeof import("./native")>;
const notificationsShouldNotify = findByCodeLazy(".SUPPRESS_NOTIFICATIONS))return!1");
const stats = createForwarderStats();

const settings = definePluginSettings({
    mode: {
        type: OptionType.SELECT,
        description: "Remote uses notification rules; Local captures server messages to signal-hub",
        options: [{ label: "Remote", value: "remote", default: true }, { label: "Local", value: "local" }],
        restartNeeded: true,
    },
    localServerUrl: {
        type: OptionType.STRING,
        description: "Signal-hub ingestion URL on this computer or a LAN machine",
        default: "http://127.0.0.1:49321/forward",
        restartNeeded: true,
    },
    localRuntimeDirectory: {
        type: OptionType.STRING,
        description: "Absolute signal-hub/var directory on THIS computer, used for the durable sender queue",
        default: "",
        restartNeeded: true,
    },
    localPairingToken: {
        type: OptionType.STRING,
        description: "Optional: leave empty when the server's pairingToken is empty; otherwise copy it from secrets.json",
        default: "",
        restartNeeded: true,
    },
    excludedServerIds: {
        type: OptionType.STRING,
        description: "Optional excluded Discord server IDs, separated by commas; apply the same list to signal-hub",
        default: "",
        restartNeeded: true,
    },
    serverUrl: {
        type: OptionType.STRING,
        description: "HTTP endpoint to forward notification messages to",
        default: DEFAULT_SERVER_URL,
    },
    fallbackUrl: {
        type: OptionType.STRING,
        description: "Fallback HTTP endpoint used after all primary attempts fail; leave empty to disable",
        default: DEFAULT_FALLBACK_URL,
    },
    enableDingTalkAlerts: {
        type: OptionType.BOOLEAN,
        description: "Send one DingTalk alert after both primary and fallback delivery fail",
        default: false,
    },
    dingTalkWebhookUrl: {
        type: OptionType.STRING,
        description: "DingTalk robot webhook used for final failure alerts",
        default: DEFAULT_DINGTALK_WEBHOOK_URL,
        disabled() { return !this.store.enableDingTalkAlerts; },
    },
    logFailures: {
        type: OptionType.BOOLEAN,
        description: "Log failed forwards to the console",
        default: true,
    },
});

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
        return { ok: false, status: -1, body: "Server URL is empty" };
    }

    const healthUrl = createHealthUrl(serverUrl);
    if (!healthUrl) {
        return { ok: false, status: -1, body: "Server URL is invalid" };
    }

    return Native.get(healthUrl);
}

function StatsLine({ label, value }: { label: string; value: number; }) {
    return (
        <div>
            <strong>{label}:</strong> {value}
        </div>
    );
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

function LocalTransportSettings() {
    const [status, setStatus] = useState<Awaited<ReturnType<typeof Native.localStatus>> | null>(null);
    const [health, setHealth] = useState<HealthCheckState>({ status: "idle", message: "Health check has not run yet." });
    const refresh = async () => {
        try { setStatus(await Native.localStatus()); } catch { logger.error("Cannot read native sender status"); }
    };
    const check = async () => {
        try {
            const result = await checkHealth(settings.store.localServerUrl);
            setHealth({ status: result.ok ? "ok" : "error", message: `HTTP ${result.status}` });
        } catch { setHealth({ status: "error", message: "Signal-hub is unreachable; queued messages remain on disk" }); }
    };
    return (
        <Flex flexDirection="column" gap="8px">
            <Paragraph>Local mode captures server messages after self and excluded-server filtering. Signal-hub archives and routes them. The runtime directory belongs to this computer, including when the service runs on another LAN machine.</Paragraph>
            <Paragraph>Run pnpm hub:configure once to create JSON configuration. Configure the URL and this computer's queue directory below; leave the token empty for the default server configuration. Select Local and restart Discord to apply.</Paragraph>
            <Flex gap="8px">
                <Button onClick={refresh}>Refresh sender status</Button>
                <Button onClick={check}>Check signal-hub</Button>
            </Flex>
            <HealthLine label="Signal-hub" health={health} />
            {status && <>
                <Paragraph>{status.active ? "Sender active" : "Sender inactive"}{status.lastError ? `: ${status.lastError}` : ""}</Paragraph>
                <StatsLine label="Pending durable handoff" value={status.pending} />
                <StatsLine label="Staged records awaiting recovery" value={status.staged} />
                <StatsLine label="Durably acknowledged by signal-hub" value={status.acked} />
                <StatsLine label="Quarantined records" value={status.quarantined} />
                <StatsLine label="Consecutive handoff failures" value={status.consecutiveFailures} />
                <Paragraph>Oldest pending: {status.oldestPendingAt === null ? "none" : new Date(status.oldestPendingAt).toLocaleString()}. Last durable ACK: {status.lastAcknowledgedAt === null ? "none this session" : new Date(status.lastAcknowledgedAt).toLocaleString()}.</Paragraph>
            </>}
        </Flex>
    );
}

function RemoteTransportSettings() {
    const [primaryHealth, setPrimaryHealth] = useState<HealthCheckState>({
        status: "idle",
        message: "Health check has not run yet."
    });
    const fallbackUrl = settings.use(["fallbackUrl"]).fallbackUrl.trim();
    const [fallbackHealth, setFallbackHealth] = useState<HealthCheckState>({
        status: fallbackUrl ? "idle" : "error",
        message: fallbackUrl ? "Health check has not run yet." : "Not configured"
    });
    const [statsSnapshot, setStatsSnapshot] = useState(stats.snapshot());
    const displayedFallbackHealth: HealthCheckState = !fallbackUrl
        ? { status: "error", message: "Not configured" }
        : fallbackHealth.message === "Not configured"
            ? { status: "idle", message: "Health check has not run yet." }
            : fallbackHealth;

    const refreshStats = () => setStatsSnapshot(stats.snapshot());
    const clearStats = () => {
        stats.reset();
        refreshStats();
    };

    async function handlePrimaryHealthCheck() {
        setPrimaryHealth({ status: "checking", message: "Checking primary endpoint..." });
        const result = await checkHealth(settings.store.serverUrl.trim());
        const duration = result.durationMs === undefined ? "" : ` in ${result.durationMs}ms`;

        if (result.ok) {
            setPrimaryHealth({ status: "ok", message: `Healthy (${result.status})${duration}: ${result.body}` });
            showToast({ text: "Primary forwarder endpoint is healthy", variant: "success" });
        } else {
            const message = `Health check failed (${result.status})${duration}: ${result.body}`;
            setPrimaryHealth({ status: "error", message });
            showToast({ text: message, variant: "critical" });
        }
    }

    async function handleFallbackHealthCheck() {
        if (!fallbackUrl) {
            setFallbackHealth({ status: "error", message: "Not configured" });
            return;
        }

        setFallbackHealth({ status: "checking", message: "Checking fallback endpoint..." });
        const result = await checkHealth(fallbackUrl);
        const duration = result.durationMs === undefined ? "" : ` in ${result.durationMs}ms`;
        if (result.ok) {
            setFallbackHealth({ status: "ok", message: `Healthy (${result.status})${duration}: ${result.body}` });
            showToast({ text: "Fallback forwarder endpoint is healthy", variant: "success" });
        } else {
            const message = `Health check failed (${result.status})${duration}: ${result.body}`;
            setFallbackHealth({ status: "error", message });
            showToast({ text: message, variant: "critical" });
        }
    }

    return (
        <Flex flexDirection="column" gap="12px">
            <Flex gap="8px" flexWrap="wrap">
                <Button onClick={() => void handlePrimaryHealthCheck()} disabled={primaryHealth.status === "checking"}>
                    {primaryHealth.status === "checking" ? "Checking primary..." : "Check primary health"}
                </Button>
                <Button onClick={() => void handleFallbackHealthCheck()} disabled={!fallbackUrl || fallbackHealth.status === "checking"}>
                    {fallbackHealth.status === "checking" ? "Checking fallback..." : "Check fallback health"}
                </Button>
                <Button variant="secondary" onClick={refreshStats}>
                    Refresh stats
                </Button>
                <Button onClick={clearStats}>
                    Clear stats
                </Button>
            </Flex>

            <HealthLine label="Primary" health={primaryHealth} />
            <HealthLine label="Fallback" health={displayedFallbackHealth} />

            <div className={Margins.top8}>
                <Heading tag="h3">Runtime stats</Heading>
                <Paragraph>Current plugin session only.</Paragraph>
                <Flex flexDirection="column" gap="4px" className={Margins.top8}>
                    <StatsLine label="Forwarded" value={statsSnapshot.forwarded} />
                    <StatsLine label="Failed" value={statsSnapshot.failed} />
                    <StatsLine label="Skipped self messages" value={statsSnapshot.filteredSelf} />
                    <StatsLine label="Skipped non-server notifications" value={statsSnapshot.filteredNonGuild} />
                    <StatsLine label="Skipped by Discord notification rules" value={statsSnapshot.filteredDiscord} />
                </Flex>
            </div>
        </Flex>
    );
}

function ForwarderSettings() {
    const { mode } = settings.use(["mode"]);
    const modeLabel = mode === "local" ? "Local" : "Remote";
    const activeLabel = activeMode === "local" ? "Local" : activeMode === "remote" ? "Remote" : "Inactive";
    return (
        <Flex flexDirection="column" gap="12px">
            <Paragraph>Active mode: {activeLabel}.</Paragraph>
            {activeMode && activeMode !== mode && <Paragraph>Restart the client to apply {modeLabel}. Messages continue using {activeLabel} until restart.</Paragraph>}
            {(activeMode ?? mode) === "local" ? <LocalTransportSettings /> : <RemoteTransportSettings />}
        </Flex>
    );
}

export default definePlugin({
    name: "forwarder",
    enabledByDefault: true,
    description: "Forwards Discord notification messages with metadata to a configurable HTTP server.",
    authors: [Devs.iondex],
    tags: ["Notifications", "Utility"],
    settings,

    start() {
        activeMode = settings.store.mode === "local" ? "local" : "remote";
        if (activeMode !== "local") return;
        localReady = Native.configureLocal({
            url: settings.store.localServerUrl.trim(),
            runtimeDirectory: settings.store.localRuntimeDirectory.trim(),
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

    settingsAboutComponent: ErrorBoundary.wrap(ForwarderSettings, { noop: false })
});
