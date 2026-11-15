import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { build } from "esbuild";

import { CaptureEnvelope } from "../../../signal-hub/contracts/ingest";
import { createLocalTransport } from "./localTransport";
import { localSkipReason, normalizeLegacyMessage } from "./logic";

async function checkPluginModeLifecycle() {
    const store = {
        mode: "remote", excludedServerIds: "", logFailures: false,
        serverUrl: "https://legacy.test/forward", fallbackUrl: "",
        enableDingTalkAlerts: false, dingTalkWebhookUrl: "",
        localServerUrl: "http://192.168.1.50:49321/forward",
        localRuntimeDirectory: "/collector/signal-hub/var", localPairingToken: "test-pairing-token-only",
    };
    let notificationsEnabled = true;
    let configured = 0;
    let sentRemote = 0;
    let queuedLocal = 0;
    let finishConfiguration: () => void = () => { throw new Error("Local configuration has not started"); };
    const errors: unknown[] = [];
    const native = {
        async configureLocal() {
            configured++;
            await new Promise<void>(resolve => { finishConfiguration = resolve; });
        },
        async stopLocal() {},
        async enqueueLocal() { queuedLocal++; return { ok: true }; },
        async send() { sentRemote++; return { ok: true }; },
    };
    const mocks: Record<string, unknown> = {
        "@api/Settings": { definePluginSettings: () => ({ store, use: () => store }) },
        "@components/Button": { Button() {} },
        "@components/ErrorBoundary": { default: { wrap: (component: unknown) => component } },
        "@components/Flex": { Flex() {} },
        "@components/Heading": { Heading() {} },
        "@components/Paragraph": { Paragraph() {} },
        "@utils/constants": { Devs: { iondex: {} } },
        "@utils/Logger": { Logger: function () { return { error: (...values: unknown[]) => errors.push(values) }; } },
        "@utils/margins": { Margins: {} },
        "@utils/types": { default: (plugin: unknown) => plugin, OptionType: { SELECT: 0, STRING: 1, BOOLEAN: 2 } },
        "@webpack": { findByCodeLazy: () => () => notificationsEnabled },
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({ id: "2", guild_id: "4", type: 0, name: "source" }) },
            GuildStore: { getGuild: () => ({ id: "4", name: "server" }) },
            UserStore: { getCurrentUser: () => ({ id: "1", username: "collector" }) },
        },
    };
    const bundle = await build({
        entryPoints: [join(__dirname, "index.tsx")], bundle: true, write: false,
        platform: "node", format: "cjs", external: ["@*"], jsx: "transform", logLevel: "silent",
    });
    const output = { exports: {} as { default: { start(): void; stop(): void; flux: { MESSAGE_CREATE(event: unknown): void; }; }; } };
    runInNewContext(bundle.outputFiles[0].text, {
        module: output, VencordNative: { pluginHelpers: { forwarder: native } },
        require(name: string) {
            assert.ok(name in mocks, `Unexpected plugin dependency: ${name}`);
            return { __esModule: true, ...mocks[name] as object };
        },
    });
    const plugin = output.exports.default;
    const message = { id: "3", channel_id: "2", guild_id: "4", content: "fixture", author: { id: "5", username: "sender" } };
    const receive = async (authorId = "5") => {
        plugin.flux.MESSAGE_CREATE({ message: { ...message, author: { ...message.author, id: authorId } } });
        await new Promise<void>(resolve => setImmediate(resolve));
    };
    await receive();
    assert.equal(sentRemote, 0, "Stopped plugin must ignore callbacks");
    plugin.start();
    await receive();
    assert.equal(sentRemote, 1);
    store.mode = "local";
    await receive();
    assert.equal(sentRemote, 2, "Selecting Local must keep the active Remote transport until restart");
    assert.equal(configured, 0);
    assert.equal(queuedLocal, 0);
    plugin.stop();
    await receive();
    assert.equal(sentRemote, 2);
    plugin.start();
    assert.equal(configured, 1);
    store.mode = "remote";
    notificationsEnabled = false;
    await receive();
    assert.equal(queuedLocal, 0, "Local capture waits for native configuration");
    finishConfiguration();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(queuedLocal, 1, "Selecting Remote must keep Local capture, independent of notification rules");
    assert.equal(sentRemote, 2);
    store.excludedServerIds = "4";
    await receive();
    store.excludedServerIds = "";
    await receive("1");
    assert.equal(queuedLocal, 1, "Mode transitions must preserve excluded-server and self filters");
    plugin.stop();
    await receive();
    assert.equal(queuedLocal, 1);
    plugin.start();
    notificationsEnabled = true;
    await receive();
    assert.equal(sentRemote, 3);
    assert.equal(configured, 1);
    plugin.stop();
    assert.deepEqual(errors, []);
}

async function main() {
    await checkPluginModeLifecycle();
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
