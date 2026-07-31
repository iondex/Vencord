/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { CloudDownloadIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { Margins } from "@utils/margins";
import definePlugin from "@utils/types";
import type { Channel, Guild, RenderModalProps } from "@vencord/discord-types";
import { ConfirmModal, Forms, GuildStore, Menu, MessageStore, openModal, showToast, Toasts } from "@webpack/common";

import { buildChannelExport, createExportFilename, isSupportedGuildChannel } from "./logic";

type ExportDocument = ReturnType<typeof buildChannelExport>;

interface ExportModalProps {
    modalProps: RenderModalProps;
    document: ExportDocument;
    filename: string;
    guild: Guild;
    channel: Channel;
}

function formatTimestamp(value: unknown) {
    if (typeof value !== "string") return "未知";

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function saveExport(document: ExportDocument, filename: string) {
    try {
        const json = JSON.stringify(document, null, 2);
        const data = new TextEncoder().encode(json);
        await DiscordNative.fileManager.saveWithDialog(data, filename);
    } catch (error) {
        showToast(`导出失败：${String(error)}`, Toasts.Type.FAILURE);
    }
}

function ExportConfirmModal({ modalProps, document, filename, guild, channel }: ExportModalProps) {
    const metadata = document.export;
    const mayBeIncomplete = metadata.hasMoreBefore || metadata.hasMoreAfter;

    return (
        <ConfirmModal
            {...modalProps}
            title="导出已加载消息"
            subtitle={`${guild.name} / #${channel.name}`}
            confirmText="导出 JSON"
            cancelText="取消"
            variant="primary"
            onConfirm={() => void saveExport(document, filename)}
        >
            <Forms.FormText>
                将导出 Discord 当前仍保存在客户端内存中的 <strong>{metadata.messageCount}</strong> 条消息。
                消息按时间降序排列。
            </Forms.FormText>

            <Forms.FormText className={Margins.top8}>
                最新消息：{formatTimestamp(metadata.newestTimestamp)}<br />
                最早消息：{formatTimestamp(metadata.oldestTimestamp)}
            </Forms.FormText>

            <Forms.FormText className={Margins.top8} style={{ color: "var(--text-warning)" }}>
                {mayBeIncomplete
                    ? "Discord 仍提示此频道有未加载消息。本次导出不完整；如需更多消息，请取消并继续手动滚动。"
                    : "仅导出客户端缓存，仍不能保证覆盖频道的全部历史消息。"}
            </Forms.FormText>

            <Forms.FormText className={Margins.top8}>
                保存内容是客户端消息记录的完整 JSON。附件只保留元数据和 Discord URL，不会下载附件，也不会请求更多消息。
            </Forms.FormText>
        </ConfirmModal>
    );
}

function openExportModal(channel: Channel) {
    const guild = GuildStore.getGuild(channel.guild_id!);
    if (!guild) {
        showToast("无法读取该频道所属的服务器。", Toasts.Type.FAILURE);
        return;
    }

    const cache = MessageStore.getMessages(channel.id);
    const exportedAt = new Date().toISOString();
    const document = buildChannelExport({ exportedAt, guild, channel, cache });

    if (document.export.messageCount === 0) {
        showToast("没有可导出的已加载消息，请先打开频道并手动滚动。", Toasts.Type.FAILURE);
        return;
    }

    const filename = createExportFilename(guild.name, channel.name || channel.id, exportedAt);
    openModal(modalProps => (
        <ExportConfirmModal
            modalProps={modalProps}
            document={document}
            filename={filename}
            guild={guild}
            channel={channel}
        />
    ));
}

const patchChannelContextMenu: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel as Channel | undefined;
    if (!isSupportedGuildChannel(channel)) return;

    const item = (
        <Menu.MenuItem
            id="vc-channel-exporter-export"
            key="vc-channel-exporter-export"
            label="导出已加载消息…"
            icon={CloudDownloadIcon}
            action={() => openExportModal(channel)}
        />
    );
    const group = findGroupChildrenByChildId(["mark-channel-read", "mute-channel", "unmute-channel"], children);

    if (group) group.push(item);
    else children.splice(-1, 0, <Menu.MenuGroup>{item}</Menu.MenuGroup>);
};

export default definePlugin({
    name: "ChannelExporter",
    description: "Exports messages already loaded in a guild channel to a local JSON file.",
    authors: [Devs.iondex],
    tags: ["Chat", "Servers", "Utility"],

    contextMenus: {
        "channel-context": patchChannelContextMenu,
        "thread-context": patchChannelContextMenu,
    },
});
