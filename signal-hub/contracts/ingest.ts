export interface CaptureEnvelope {
    schemaVersion: 2;
    eventId: string;
    eventType: "MESSAGE_CREATE" | "RECOVERY";
    capturedAt: string;
    accountId: string;
    serverId: string;
    channelId: string;
    parentChannelId?: string;
    excludedServerIds: string[];
    message: Record<string, any>;
}

export function validateCapture(value: unknown): value is CaptureEnvelope {
    const input = value as CaptureEnvelope | null;
    const id = (field: unknown): field is string => typeof field === "string" && /^\d{1,32}$/.test(field);
    return Boolean(input && input.schemaVersion === 2
        && typeof input.eventId === "string" && /^[\w:-]{1,240}$/.test(input.eventId)
        && ["MESSAGE_CREATE", "RECOVERY"].includes(input.eventType)
        && typeof input.capturedAt === "string" && Number.isFinite(Date.parse(input.capturedAt))
        && id(input.accountId) && id(input.serverId) && id(input.channelId)
        && (input.parentChannelId === undefined || id(input.parentChannelId))
        && Array.isArray(input.excludedServerIds) && input.excludedServerIds.every(id)
        && input.message && typeof input.message === "object" && !Array.isArray(input.message)
        && id(input.message.id)
        && (!input.message.channel_id || input.message.channel_id === input.channelId)
        && (!input.message.guild_id || input.message.guild_id === input.serverId));
}

export function validateServiceUrl(value: string) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("Service URL must use HTTP(S), without credentials, query or fragment");
    }
    return url;
}

export function jsonSafe(value: unknown) {
    const ancestors: object[] = [];
    return JSON.parse(JSON.stringify(value, function (_key, item) {
        if (typeof item === "bigint") return item.toString();
        if (typeof item === "function") return undefined;
        if (item && typeof item === "object") {
            while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
            if (ancestors.includes(item)) return "[Circular]";
            ancestors.push(item);
        }
        return item;
    }));
}
