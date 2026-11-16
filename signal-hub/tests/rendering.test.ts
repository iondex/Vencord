import assert from "node:assert/strict";
import { test } from "node:test";

import type { CaptureEnvelope } from "../contracts/ingest.js";
import { validateSnapshot } from "../src/config.js";
import { renderMessage } from "../src/routing.js";

const route = validateSnapshot({ routes: [{ routeId: "futu", name: "futu-news", enabled: true, serverId: "2", channelId: "3", targetChannelId: "5" }], signal: { enabled: false } }).routes[0];
function render(message: Record<string, unknown>, changes = {}) {
    const event: CaptureEnvelope = { schemaVersion: 2, eventId: "test:100", eventType: "MESSAGE_CREATE", capturedAt: new Date().toISOString(), accountId: "1", serverId: "2", channelId: "3", excludedServerIds: [], message: { id: "100", ...message } };
    return renderMessage(event, { ...route, ...changes });
}

test("news embeds retain their original cards, footer and timestamp without added source text", () => {
    const result = render({ content: "", embeds: [{
        type: "rich", id: "internal", title: "市场新闻", rawTitle: "市场新闻", description: "**新闻正文**", rawDescription: "**新闻正文**",
        url: "https://news.test/story", color: 5763719, timestamp: "2026-11-16T04:54:57Z",
        footer: { text: "信源: 富途牛牛", iconURL: "https://cdn.test/footer.png", proxy_icon_url: "https://proxy.test/footer.png" },
        author: { name: "原始作者", iconUrl: "https://cdn.test/author.png" }, fields: [{ name: "行情", value: "上涨", inline: true }],
        provider: { name: "unsupported" }, video: { url: "https://video.test/clip" },
    }] });
    assert.equal(result.reason, "routed");
    assert.equal(result.parts.length, 1);
    assert.equal(result.parts[0].content, "");
    assert.deepEqual(result.parts[0].embeds, [{ title: "市场新闻", description: "**新闻正文**", url: "https://news.test/story", color: 5763719,
        timestamp: "2026-11-16T04:54:57.000Z", author: { name: "原始作者", icon_url: "https://cdn.test/author.png" },
        footer: { text: "信源: 富途牛牛", icon_url: "https://cdn.test/footer.png" }, fields: [{ name: "行情", value: "上涨", inline: true }] }]);
    assert.doesNotMatch(JSON.stringify(result.parts), /discord\.com\/channels|internal|unsupported|rawTitle|rawDescription/);
});

test("forwarded text and embeds remove mentions and source-channel links while retaining ordinary Markdown and URLs", () => {
    const result = render({ content: "@everyone <@123> <@!456> <@&789> <#3> <#999> **hello** [来源](https://discord.com/channels/2/3/100) https://x.com/user/status/123",
        embeds: [{ title: "<@123> Title", description: "@here <#3> description https://discord.com/channels/2/3/100", url: "https://discord.com/channels/2/3/100", footer: { text: "<@&789> Footer" } }] });
    const serialized = JSON.stringify(result.parts);
    assert.doesNotMatch(serialized, /@everyone|@here|<@|<#|discord\.com\/channels|来源/);
    assert.match(result.parts[0].content, /\*\*hello\*\*/);
    assert.match(result.parts[0].content, /https:\/\/x\.com\/user\/status\/123/);
    assert.deepEqual(result.parts[0].allowed_mentions, { parse: [] });
    assert.equal(render({ content: "```\n    indented code\n```" }).parts[0].content, "```\n    indented code\n```");
    assert.equal(render({ embeds: [{ video: { url: "https://cdn.test/clip.mp4" } }] }).parts[0].content, "https://cdn.test/clip.mp4");
});

test("rich content batches within Discord limits and image suppression does not remove the news card", () => {
    const message = { content: "😀".repeat(3000), embeds: Array.from({ length: 12 }, (_, index) => ({ title: `News ${index}`, description: "x".repeat(1000), image: { url: "https://cdn.test/image.png" } })) };
    const result = render(message, { forwardImages: false });
    assert.equal(result.parts.reduce((sum, part) => sum + (part.embeds?.length ?? 0), 0), 12);
    assert.equal(result.parts.map(part => part.content).join(""), message.content);
    for (const part of result.parts) {
        assert.ok(part.content.length <= 2000);
        assert.ok(!/[\uD800-\uDBFF]$/.test(part.content));
        assert.ok((part.embeds?.length ?? 0) <= 10);
        assert.ok((part.embeds ?? []).reduce((sum, embed) => sum + String(embed.title ?? "").length + String(embed.description ?? "").length, 0) <= 6000);
        assert.ok((part.embeds ?? []).every(embed => !embed.image));
    }
    assert.deepEqual(message.embeds[0].image, { url: "https://cdn.test/image.png" });
});
