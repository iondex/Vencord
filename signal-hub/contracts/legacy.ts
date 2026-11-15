export function normalizeLegacyMessage(message: any, depth = 0): any {
    if (!message || typeof message !== "object" || depth > 8) return null;
    return {
        ...message,
        content: typeof message.content === "string" ? message.content : "",
        timestamp: typeof message.timestamp === "string" ? message.timestamp : "",
        author: message.author ? {
            ...message.author,
            username: message.author.username ?? "",
            globalName: message.author.globalName ?? message.author.global_name ?? "",
            bot: Boolean(message.author.bot),
        } : null,
        attachments: (message.attachments ?? []).map((attachment: any) => ({
            ...attachment,
            contentType: attachment.contentType ?? attachment.content_type ?? undefined,
            content_type: attachment.content_type ?? undefined,
            proxyUrl: attachment.proxyUrl ?? attachment.proxy_url ?? undefined,
            proxy_url: attachment.proxy_url ?? undefined,
            url: attachment.url ?? "",
            filename: attachment.filename ?? "",
            size: attachment.size ?? 0,
        })),
        referencedMessage: normalizeLegacyMessage(message.referencedMessage ?? message.referenced_message, depth + 1),
        referenced_message: undefined,
    };
}
