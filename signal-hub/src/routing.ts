import { CaptureEnvelope } from "../contracts/ingest.js";
import { Route, Snapshot } from "./config.js";

export function matchingRoutes(snapshot: Snapshot, event: CaptureEnvelope) {
    return snapshot.routes.filter(route => route.enabled && route.serverId === event.serverId
        && Boolean(route.channelId || route.senderId)
        && (!route.channelId || route.channelId === event.channelId)
        && (!route.senderId || route.senderId === event.message.author?.id));
}

export function evaluateText(message: Record<string, any>, route: Route) {
    const segments: Array<{ label: string; value: string; reply: boolean; }> = [];
    function collect(message: Record<string, any>, depth = 0) {
        if (depth > 8) return;
        const prefix = depth ? "REPLY CONTEXT " : "";
        const add = (label: string, value: unknown) => {
            if (typeof value === "string" && value.trim()) segments.push({ label: prefix + label, value, reply: depth > 0 });
        };
        add("MAIN", message.content);
        for (const [index, embed] of (message.embeds ?? []).entries()) {
            const label = `EMBED ${index + 1}`;
            for (const key of ["title", "rawTitle", "raw_title", "description", "rawDescription", "raw_description"]) add(label, embed[key]);
            add(label, embed.author?.name); add(label, embed.footer?.text);
            for (const field of embed.fields ?? []) { add(label, field.name); add(label, field.value); }
        }
        const components = (items: any[], depth = 0) => {
            if (depth > 8) return;
            for (const item of items) {
                add("COMPONENT", item.content); add("COMPONENT", item.label); add("COMPONENT", item.description);
                if (Array.isArray(item.components)) components(item.components, depth + 1);
                if (item.accessory) components([item.accessory], depth + 1);
            }
        };
        if (Array.isArray(message.components)) components(message.components);
        add("POLL", message.poll?.question?.text);
        for (const answer of message.poll?.answers ?? []) add("POLL", answer.poll_media?.text);
        const reference = message.referencedMessage ?? message.referenced_message;
        if (reference && typeof reference === "object") collect(reference, depth + 1);
    }
    collect(message);
    const original = segments.map(segment => segment.value).join("\n").toLowerCase();
    if (route.filters.some(filter => filter.trim() && original.includes(filter.trim().toLowerCase()))) return { reason: "keyword_blocked", text: "", signalContent: "" };
    for (const segment of segments) {
        for (const replacement of route.replacements) {
            if (!replacement.find) continue;
            if (replacement.caseSensitive) segment.value = segment.value.split(replacement.find).join(replacement.replaceWith);
            else {
                const escaped = replacement.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                segment.value = segment.value.replace(new RegExp(escaped, "gi"), () => replacement.replaceWith);
            }
        }
    }
    if (route.filterChinese && segments.some(segment => /\p{Script=Han}/u.test(segment.value))) return { reason: "chinese_blocked", text: "", signalContent: "" };
    return {
        reason: "routed",
        text: segments.filter(segment => !segment.reply).map(segment => segment.value).join("\n"),
        signalContent: segments.map(segment => `[${segment.label}]\n${segment.value}`).join("\n\n").slice(0, 12_000),
    };
}

function safeUrl(value: unknown) {
    if (typeof value !== "string") return "";
    try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.toString() : ""; } catch { return ""; }
}

export function renderMessage(event: CaptureEnvelope, route: Route) {
    const { message } = event;
    if ((Number(message.flags) & 64) !== 0 || ![0, 19, 20, 21].includes(message.type ?? 0)) return { reason: "archived_unsupported", parts: [] };
    const evaluated = evaluateText(message, route);
    if (evaluated.reason !== "routed") return { reason: evaluated.reason, parts: [] };
    let { text } = evaluated;
    const urls = new Set<string>();
    for (const attachment of message.attachments ?? []) {
        const image = (attachment.content_type ?? attachment.contentType ?? "").startsWith("image/") || attachment.width > 0;
        if (!image || route.forwardImages) {
            const url = safeUrl(attachment.url) || safeUrl(attachment.proxy_url ?? attachment.proxyUrl);
            if (url) urls.add(url);
        }
    }
    for (const embed of message.embeds ?? []) {
        for (const value of [embed.url, ...(route.forwardImages ? [embed.image?.url, embed.thumbnail?.url, embed.video?.url] : [])]) {
            const url = safeUrl(value);
            if (url && !text.includes(url)) urls.add(url);
        }
    }
    const stickers = message.sticker_items ?? message.stickerItems ?? [];
    for (const sticker of stickers) text += `\n[Sticker: ${typeof sticker.name === "string" ? sticker.name : sticker.id}]`;
    const resources = [...urls].join("\n");
    if (resources) text += `\n${resources}`;
    if (!text.trim()) return { reason: "archived_unsupported", parts: [] };
    text += `\nhttps://discord.com/channels/${event.serverId}/${event.channelId}/${message.id}`;
    const parts: Array<{ content: string; allowed_mentions: { parse: never[] }; }> = [];
    while (text) {
        let boundary = Math.min(1900, text.length);
        if (boundary < text.length && /[\uD800-\uDBFF]/.test(text[boundary - 1])) boundary--;
        parts.push({ content: text.slice(0, boundary), allowed_mentions: { parse: [] } });
        text = text.slice(boundary);
    }
    return { reason: "routed", parts };
}

export function targetOverlapsSource(snapshot: Snapshot, target: { id: string; parent_id?: string; guild_id?: string; }) {
    return snapshot.routes.some(route => route.enabled && (route.channelId
        ? [target.id, target.parent_id].includes(route.channelId)
        : target.guild_id === route.serverId));
}
