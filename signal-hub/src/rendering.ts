import type { CaptureEnvelope } from "../contracts/ingest.js";
import type { Route } from "./config.js";

export function replaceText(value: string, route: Route) {
    for (const replacement of route.replacements) {
        if (!replacement.find) continue;
        if (replacement.caseSensitive) value = value.split(replacement.find).join(replacement.replaceWith);
        else value = value.replace(new RegExp(replacement.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), () => replacement.replaceWith);
    }
    return value;
}

function safeUrl(value: unknown) {
    if (typeof value !== "string") return "";
    try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.toString() : ""; } catch { return ""; }
}

function clip(value: string, limit: number) {
    let boundary = Math.max(0, limit);
    if (/[\uD800-\uDBFF]/.test(value[boundary - 1] ?? "")) boundary--;
    return value.slice(0, boundary);
}

function sourceLink(value: string, event: CaptureEnvelope) {
    try {
        const url = new URL(value);
        return /^(?:(?:www|canary|ptb)\.)?discord(?:app)?\.com$/.test(url.hostname)
            && url.pathname.split("/")[1] === "channels" && [event.channelId, event.parentChannelId].includes(url.pathname.split("/")[3]);
    } catch { return false; }
}

export function sanitizeForwardText(value: string, event: CaptureEnvelope) {
    return value.replace(/<(@[!&]?|#)\d+>/g, "").replace(/@everyone|@here/gi, "")
        .replace(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/g, (match, url: string) => sourceLink(url, event) ? "" : match)
        .replace(/https?:\/\/[^\s<>()\]]+/g, url => sourceLink(url, event) ? "" : url).trim();
}

export function renderForwardParts(event: CaptureEnvelope, route: Route, text: string) {
    const sanitize = (value: string) => sanitizeForwardText(value, event);
    const url = (value: unknown) => { const valid = safeUrl(value); return sourceLink(valid, event) ? "" : valid; };
    const embeds: Record<string, any>[] = [];
    const urls = new Set<string>();
    for (const source of event.message.embeds ?? []) {
        if (!source || typeof source !== "object") continue;
        const embed: Record<string, any> = {};
        let remaining = 6000;
        const fieldText = (value: unknown, limit: number) => {
            if (typeof value !== "string") return "";
            const result = clip(sanitize(replaceText(value, route)), Math.min(limit, remaining));
            remaining -= result.length;
            return result;
        };
        const first = (...values: unknown[]) => values.find(value => typeof value === "string" && value.trim());
        const title = fieldText(first(source.rawTitle, source.raw_title, source.title), 256);
        const description = fieldText(first(source.rawDescription, source.raw_description, source.description), 4096);
        if (title) embed.title = title;
        if (description) embed.description = description;
        if (url(source.url)) embed.url = url(source.url);
        if (Number.isInteger(source.color) && source.color >= 0 && source.color <= 0xffffff) embed.color = source.color;
        if (typeof source.timestamp === "string" && Number.isFinite(Date.parse(source.timestamp))) embed.timestamp = new Date(source.timestamp).toISOString();
        for (const key of ["author", "footer"] as const) {
            const original = source[key];
            const name = key === "author" ? "name" : "text";
            const value = fieldText(original?.[name], key === "author" ? 256 : 2048);
            if (!value) continue;
            embed[key] = { [name]: value };
            const icon = url(first(original.icon_url, original.iconURL, original.iconUrl));
            if (icon) embed[key].icon_url = icon;
            if (key === "author" && url(original.url)) embed[key].url = url(original.url);
        }
        if (route.forwardImages) for (const key of ["image", "thumbnail"] as const) {
            const image = url(first(source[key]?.url, source[key]?.proxy_url, source[key]?.proxyURL));
            if (image) embed[key] = { url: image };
        }
        const fields: Record<string, unknown>[] = [];
        for (const field of (source.fields ?? []).slice(0, 25)) {
            const name = fieldText(field?.name, 256);
            const value = fieldText(field?.value, 1024);
            if (name && value) fields.push({ name, value, inline: field.inline === true });
        }
        if (fields.length) embed.fields = fields;
        if (title || description || embed.author || embed.footer || embed.fields || embed.image || embed.thumbnail) embeds.push(embed);
        else {
            if (embed.url) urls.add(embed.url);
            else if (route.forwardImages && url(source.video?.url)) urls.add(url(source.video.url));
        }
    }
    text = sanitize(text);
    for (const attachment of event.message.attachments ?? []) {
        const image = (attachment.content_type ?? attachment.contentType ?? "").startsWith("image/") || attachment.width > 0;
        if (!image || route.forwardImages) {
            const resource = url(attachment.url) || url(attachment.proxy_url ?? attachment.proxyUrl);
            if (resource && !text.includes(resource)) urls.add(resource);
        }
    }
    for (const sticker of event.message.sticker_items ?? event.message.stickerItems ?? []) {
        const name = sanitize(typeof sticker.name === "string" ? sticker.name : String(sticker.id));
        if (name) text += `\n[Sticker: ${name}]`;
    }
    if (urls.size) text += `${text ? "\n" : ""}${[...urls].join("\n")}`;
    const parts: Array<{ content: string; embeds?: Record<string, any>[]; allowed_mentions: { parse: never[] }; }> = [];
    while (text) {
        const content = clip(text, 1900);
        parts.push({ content, allowed_mentions: { parse: [] } });
        text = text.slice(content.length);
    }
    let part = 0;
    let used = 0;
    for (const embed of embeds) {
        const length = (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.author?.name.length ?? 0) + (embed.footer?.text.length ?? 0)
            + (embed.fields ?? []).reduce((sum: number, field: any) => sum + field.name.length + field.value.length, 0);
        if ((parts[part]?.embeds?.length ?? 0) >= 10 || used + length > 6000) { part++; used = 0; }
        parts[part] ??= { content: "", allowed_mentions: { parse: [] } };
        (parts[part].embeds ??= []).push(embed);
        used += length;
    }
    return parts;
}
