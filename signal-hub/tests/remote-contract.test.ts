import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeLegacyMessage } from "../contracts/legacy.js";
import { parseForwarderPayload } from "./fixtures/cf-contract/payload.js";

test("legacy serializer satisfies the shared signal-hub/forwarder CF schema for nullable failures", () => {
    const base = { id: "1", content: "hello", timestamp: new Date().toISOString(), author: { id: "2", username: "name", globalName: "Name" }, attachments: [] };
    const cases = [
        { ...base, attachments: [{ id: "3", filename: "image.png", url: "https://cdn.test/image.png", contentType: null, proxyUrl: "https://cdn.test/image.png" }] },
        { ...base, attachments: [{ id: "3", filename: "file.txt", url: "https://cdn.test/file.txt", contentType: "text/plain", proxyUrl: null }] },
        { ...base, author: { id: "2", username: "name", globalName: null } },
        { ...base, content: null, embeds: [{ title: "embed only" }] },
    ];
    for (const message of cases) {
        const envelope = { notification: { title: "test", body: "test" }, message };
        assert.throws(() => parseForwarderPayload(envelope));
        const normalized = JSON.parse(JSON.stringify({ ...envelope, message: normalizeLegacyMessage(message) }));
        assert.doesNotThrow(() => parseForwarderPayload(normalized));
    }
});

test("shared CF contract preserves server aliases, replies and rich-message fields", () => {
    const messages = [
        { content: null, embeds: [{ title: "embed" }], attachments: [] },
        { content: "", attachments: [{ id: "3", filename: "audio.ogg", url: "https://cdn.test/audio.ogg", content_type: null, proxy_url: null }] },
        { content: "reply", referenced_message: { id: "4", content: null, author: { id: "5", global_name: null }, attachments: [] } },
        { content: "", components: [{ type: 17, components: [{ type: 10, content: "text" }] }], poll: { question: { text: "poll" } }, sticker_items: [{ id: "6", name: "sticker" }] },
    ];
    for (const message of messages) {
        const wire = JSON.parse(JSON.stringify({
            source: { plugin: "forwarder", client: "Vencord", kind: "notification" },
            notification: { title: "test", body: "" },
            metadata: { channel: { id: "10", serverId: "20", guildId: "20" }, server: { id: "20", name: "server" }, guild: { id: "20", name: "server" } },
            message: normalizeLegacyMessage({ id: "1", author: { id: "2", globalName: null }, ...message }),
        }));
        const parsed = parseForwarderPayload(wire);
        assert.equal(parsed.metadata.server?.id, "20");
        assert.equal(parsed.message?.author?.globalName, "");
        if ("referenced_message" in message) assert.equal(parsed.message?.referencedMessage?.content, "");
        if ("components" in message) assert.deepEqual(parsed.message?.components, message.components);
    }
});
