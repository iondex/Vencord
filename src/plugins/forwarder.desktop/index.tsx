/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Flex } from "@components/Flex";
import { Margins } from "@utils/margins";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { MessageJSON } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { Button, ChannelStore, Forms, GuildStore, showToast, Toasts, UserStore, useState } from "@webpack/common";

import { createForwarderStats, createHealthUrl, getForwardSkipReason } from "./logic";

const DEFAULT_SERVER_URL = "http://127.0.0.1:49321/forward";
const AUTHOR = { name: "iondex", id: 0n };

const logger = new Logger("forwarder");
const Native = VencordNative.pluginHelpers.forwarder as PluginNative<typeof import("./native")>;
const notificationsShouldNotify = findByCodeLazy(".SUPPRESS_NOTIFICATIONS))return!1");
const stats = createForwarderStats();

const settings = definePluginSettings({
    serverUrl: {
        type: OptionType.STRING,
        description: "HTTP endpoint to forward notification messages to",
        default: DEFAULT_SERVER_URL,
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
        globalName: user.globalName ?? user.global_name,
        discriminator: user.discriminator,
        bot: user.bot,
        system: user.system,
        avatar: user.avatar
    });
}

function normalizeAttachment(attachment: any) {
    const proxyUrl = attachment.proxy_url ?? attachment.proxyUrl ?? null;
    const url = attachment.url ?? null;
    const downloadUrl = proxyUrl ?? url;

    return sanitizeForJson({
        id: attachment.id,
        filename: attachment.filename,
        size: attachment.size,
        contentType: attachment.content_type ?? attachment.contentType ?? null,
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
        message: {
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
        }
    });
}

async function forwardMessage(message: ForwarderMessage) {
    const serverUrl = settings.store.serverUrl.trim();
    if (!serverUrl) return;

    const result = await Native.send(serverUrl, createPayload(message));
    stats.recordForwardAttempt(result.ok);
    if (!result.ok && settings.store.logFailures) {
        logger.error(`Failed to forward notification (${result.status})`, result.body);
    }
}

async function sendTestPayload() {
    const serverUrl = settings.store.serverUrl.trim();
    if (!serverUrl) return;

    const result = await Native.send(serverUrl, sanitizeForJson({
        source: {
            plugin: "forwarder",
            client: "Vencord",
            kind: "test"
        },
        forwardedAt: new Date().toISOString(),
        notification: {
            title: "forwarder test",
            body: "Test payload from Vencord forwarder"
        },
        metadata: {
            currentUser: compactUser(UserStore.getCurrentUser())
        },
        message: null
    }));

    if (!result.ok && settings.store.logFailures) {
        logger.error(`Failed to forward test payload (${result.status})`, result.body);
    }

    return result;
}

async function checkHealth() {
    const serverUrl = settings.store.serverUrl.trim();
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

function ForwarderSettings() {
    const [health, setHealth] = useState<HealthCheckState>({
        status: "idle",
        message: "Health check has not run yet."
    });
    const [statsSnapshot, setStatsSnapshot] = useState(stats.snapshot());
    const [isSendingTest, setIsSendingTest] = useState(false);

    const refreshStats = () => setStatsSnapshot(stats.snapshot());

    async function handleHealthCheck() {
        setHealth({ status: "checking", message: "Checking signal-hub..." });
        const result = await checkHealth();

        if (result.ok) {
            setHealth({ status: "ok", message: `Healthy (${result.status})` });
            showToast("signal-hub is healthy", Toasts.Type.SUCCESS);
        } else {
            const message = `Health check failed (${result.status}): ${result.body}`;
            setHealth({ status: "error", message });
            showToast(message, Toasts.Type.FAILURE);
        }
    }

    async function handleSendTest() {
        setIsSendingTest(true);
        const result = await sendTestPayload();
        setIsSendingTest(false);

        if (!result) return;
        if (result.ok) {
            showToast("Test payload sent", Toasts.Type.SUCCESS);
        } else {
            showToast(`Test payload failed (${result.status})`, Toasts.Type.FAILURE);
        }
    }

    const healthColor = health.status === "ok"
        ? "var(--text-positive)"
        : health.status === "error"
            ? "var(--text-danger)"
            : "var(--text-muted)";

    return (
        <Flex flexDirection="column" gap="12px">
            <Flex gap="8px" flexWrap="wrap">
                <Button onClick={() => void handleHealthCheck()} disabled={health.status === "checking"}>
                    {health.status === "checking" ? "Checking..." : "Health check"}
                </Button>
                <Button onClick={() => void handleSendTest()} disabled={isSendingTest}>
                    {isSendingTest ? "Sending..." : "Send test payload"}
                </Button>
                <Button color={Button.Colors.PRIMARY} onClick={refreshStats}>
                    Refresh stats
                </Button>
            </Flex>

            <Forms.FormText style={{ color: healthColor }}>
                {health.message}
            </Forms.FormText>

            <div className={Margins.top8}>
                <Forms.FormTitle tag="h3">Runtime stats</Forms.FormTitle>
                <Forms.FormText>Current plugin session only.</Forms.FormText>
                <Flex flexDirection="column" gap="4px" className={Margins.top8}>
                    <StatsLine label="Forwarded" value={statsSnapshot.forwarded} />
                    <StatsLine label="Failed" value={statsSnapshot.failed} />
                    <StatsLine label="Skipped self messages" value={statsSnapshot.filteredSelf} />
                    <StatsLine label="Skipped non-guild notifications" value={statsSnapshot.filteredNonGuild} />
                    <StatsLine label="Skipped by Discord notification rules" value={statsSnapshot.filteredDiscord} />
                </Flex>
            </div>
        </Flex>
    );
}

export default definePlugin({
    name: "forwarder",
    description: "Forwards Discord notification messages with metadata to a configurable HTTP server.",
    authors: [AUTHOR],
    tags: ["Notifications", "Utility"],
    settings,

    flux: {
        MESSAGE_CREATE({ message, optimistic }: { message: ForwarderMessage; optimistic?: boolean; }) {
            if (!shouldForward(message, optimistic)) return;

            void forwardMessage(message);
        }
    },

    settingsAboutComponent: ForwarderSettings
});
