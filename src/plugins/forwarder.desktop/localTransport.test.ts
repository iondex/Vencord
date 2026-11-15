import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CaptureEnvelope } from "../../../signal-hub/contracts/ingest";
import { createLocalTransport } from "./localTransport";
import { localSkipReason, normalizeLegacyMessage } from "./logic";

async function main() {
    const directory = mkdtempSync(join(tmpdir(), "forwarder-spool-test-"));
    const event: CaptureEnvelope = {
        schemaVersion: 2, eventId: "discord:1:2:3:create", eventType: "MESSAGE_CREATE", capturedAt: new Date().toISOString(),
        accountId: "1", serverId: "4", channelId: "2", excludedServerIds: [],
        message: { id: "3", channel_id: "2", guild_id: "4", content: null, author: { id: "5", bot: true } },
    };
    let available = false;
    let wrongAck = false;
    const urls: string[] = [];
    const transport = createLocalTransport((async (input: any, init: any) => {
        urls.push(String(input));
        if (!available) throw new Error("offline");
        return new Response(JSON.stringify({ durable: true, eventId: JSON.parse(init.body).eventId, hash: wrongAck ? "wrong" : createHash("sha256").update(init.body).digest("hex") }));
    }) as typeof fetch);
    try {
        transport.configure({ url: "http://192.168.1.50:49321/forward", runtimeDirectory: directory, token: "pairing-token-for-test-only" });
        const firstCapture = transport.enqueue(event);
        const pending = join(directory, "spool/forwarder/pending");
        const clientPath = join(directory, "spool/forwarder/client-id");
        const clientId = readFileSync(clientPath, "utf8");
        assert.match(clientId, /^[\da-f-]{36}$/);
        assert.equal(readdirSync(pending).length, 1);
        await transport.drain();
        assert.equal(transport.status().pending, 1);
        assert.equal(transport.status().consecutiveFailures, 1);
        assert.ok(transport.status().oldestPendingAt);
        assert.ok(transport.status().lastAttemptAt);
        assert.equal(transport.status().lastAcknowledgedAt, null);
        available = true; wrongAck = true;
        await transport.drain();
        assert.equal(transport.status().pending, 1);
        wrongAck = false;
        transport.enqueue({ ...event, capturedAt: new Date().toISOString() });
        assert.equal(JSON.parse(readFileSync(join(pending, readdirSync(pending)[0]), "utf8")).capturedAt, event.capturedAt);
        await transport.drain();
        assert.equal(transport.status().pending, 0);
        assert.equal(transport.status().acked, 1);
        assert.equal(transport.status().consecutiveFailures, 0);
        assert.equal(transport.status().oldestPendingAt, null);
        assert.ok(transport.status().lastAcknowledgedAt);
        transport.enqueue(event);
        assert.equal(transport.status().pending, 0);
        const otherClient = createLocalTransport((async () => { throw new Error("offline"); }) as typeof fetch);
        otherClient.configure({ url: "http://192.168.1.50:49321/forward", runtimeDirectory: join(directory, "other-client"), token: "pairing-token-for-test-only" });
        assert.notEqual(otherClient.enqueue(event).eventId, firstCapture.eventId);
        await otherClient.stop();
        assert.ok(urls.every(url => url === "http://192.168.1.50:49321/forward"));
        await transport.stop();
        const incomplete = { ...event, eventId: "recovered:create" };
        writeFileSync(join(pending, "recover.tmp"), JSON.stringify(incomplete));
        writeFileSync(join(pending, "!invalid.json"), "{");
        writeFileSync(join(pending, "!invalid.tmp"), "{");
        transport.configure({ url: "http://127.0.0.1:49321/forward", runtimeDirectory: directory, token: "pairing-token-for-test-only" });
        assert.equal(readFileSync(clientPath, "utf8"), clientId);
        available = false;
        await transport.drain();
        assert.ok(transport.status().pending >= 1);
        assert.equal(transport.status().quarantined, 2);
        assert.equal(localSkipReason(event.message, { guild_id: "4" }, "1", false, []), null);
        assert.equal(localSkipReason(event.message, { guild_id: "4" }, "1", false, ["4"]), "excluded-server");
        assert.equal(localSkipReason({ ...event.message, author: { id: "1" } }, { guild_id: "4" }, "1", false, []), "self");
        assert.equal(localSkipReason(event.message, { type: 3 }, "1", false, []), "non-server");
        const legacy = JSON.parse(JSON.stringify(normalizeLegacyMessage({ content: null, author: { id: "1", global_name: null }, attachments: [{ contentType: null, proxyUrl: null }], referenced_message: { content: null } })));
        assert.equal(legacy.content, ""); assert.equal(legacy.author.globalName, "");
        assert.equal(legacy.attachments[0].contentType, undefined); assert.equal(legacy.attachments[0].proxyUrl, undefined);
        assert.equal(legacy.referencedMessage.content, "");
        for (const [name, interruptedId] of [["empty", ""], ["partial", "01234567-"]]) {
            const runtimeDirectory = join(directory, name);
            const root = join(runtimeDirectory, "spool/forwarder");
            mkdirSync(root, { recursive: true });
            const identityPath = join(root, "client-id");
            writeFileSync(identityPath, interruptedId);
            writeFileSync(`${identityPath}.interrupted.tmp`, "incomplete");
            const recovering = createLocalTransport();
            try {
                recovering.configure({ url: "http://127.0.0.1:49321/forward", runtimeDirectory, token: "pairing-token-for-test-only" });
                const recoveredId = readFileSync(identityPath, "utf8");
                assert.match(recoveredId, /^[\da-f-]{36}$/);
                assert.equal(recovering.enqueue(event).eventId, `${recoveredId}:${event.eventId}`);
                await recovering.stop();
                recovering.configure({ url: "http://127.0.0.1:49321/forward", runtimeDirectory, token: "pairing-token-for-test-only" });
                assert.equal(readFileSync(identityPath, "utf8"), recoveredId);
                assert.equal(recovering.status().pending, 1);
            } finally { await recovering.stop(); }
        }
        console.log("local transport and legacy nullable contract regression checks passed");
    } finally { await transport.stop(); rmSync(directory, { recursive: true, force: true }); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
