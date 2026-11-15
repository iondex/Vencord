import type { StreamTarget } from "@plugins/transcribe.desktop/types";

export function parseChannelIds(value: string): string[] {
    return [...new Set(value.split(/[\s,，;；]+/).filter(Boolean))];
}

export function selectStream(streams: StreamTarget[], channelIds: string[], current?: StreamTarget): StreamTarget | undefined {
    const matches = streams.filter(stream => channelIds.includes(stream.channelId));
    if (current) {
        const existing = matches.find(stream => stream.key === current.key);
        if (existing) return existing;
    }
    return matches.sort((left, right) => channelIds.indexOf(left.channelId) - channelIds.indexOf(right.channelId)
        || left.ownerId.localeCompare(right.ownerId))[0];
}
