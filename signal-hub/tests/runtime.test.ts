import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { getRuntimeDirectory, initializeRuntime, loadDingTalkWebhook, loadSecrets, loadSettings } from "../src/runtime.js";

test("runtime initialization validates addresses before writing and preserves existing credentials", context => {
    const directory = mkdtempSync(join(tmpdir(), "hub-runtime-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    assert.throws(() => getRuntimeDirectory({ SIGNAL_HUB_VAR: "relative/var" }), /absolute/);
    for (const environment of [{ SIGNAL_HUB_HOST: " " }, { SIGNAL_HUB_PORT: "0" }, { SIGNAL_HUB_CF_BASE_URL: "ftp://config.test" }]) {
        assert.throws(() => initializeRuntime(directory, environment));
        assert.equal(existsSync(join(directory, "secrets.json")), false);
    }
    initializeRuntime(directory, { SIGNAL_HUB_HOST: "::", SIGNAL_HUB_PORT: "49325" });
    assert.deepEqual(readdirSync(directory).sort(), ["secrets.json", "settings.json"]);
    const settings = loadSettings(directory, {});
    assert.equal(settings.host, "::");
    assert.equal(settings.port, 49325);
    const secrets = loadSecrets(directory, {});
    assert.equal(secrets.pairingToken, "");
    assert.equal(secrets.adminToken, "");
    for (const filename of ["settings.json", "secrets.json"]) assert.equal(statSync(join(directory, filename)).mode & 0o777, 0o600);
    writeFileSync(join(directory, "secrets.json"), JSON.stringify({ ...secrets, pairingToken: "existing-pairing-token-for-test", adminToken: "existing-admin-token-for-test" }));
    const original = readFileSync(join(directory, "secrets.json"), "utf8");
    assert.throws(() => initializeRuntime(directory, {}), /preserve/);
    assert.equal(readFileSync(join(directory, "secrets.json"), "utf8"), original);
});

test("runtime settings and secret overrides are shared without rewriting private files", context => {
    const directory = mkdtempSync(join(tmpdir(), "hub-runtime-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    initializeRuntime(directory, {});
    const settingsPath = join(directory, "settings.json");
    const secretsPath = join(directory, "secrets.json");
    const originalSettings = readFileSync(settingsPath, "utf8");
    const originalSecrets = readFileSync(secretsPath, "utf8");
    const settings = loadSettings(directory, { SIGNAL_HUB_HOST: "0.0.0.0", SIGNAL_HUB_PORT: "49326", SIGNAL_HUB_CF_BASE_URL: "https://config.test" });
    assert.equal(settings.host, "0.0.0.0");
    assert.equal(settings.port, 49326);
    assert.equal(settings.cfBaseUrl, "https://config.test");
    const secrets = loadSecrets(directory, { DISCORD_BOT_TOKEN: "test-bot", OPENAI_KEY: "test-primary", OPENAI_API_KEY: "test-secondary", SIGNAL_HUB_CF_TOKEN: "test-cf", DINGTALK_WEBHOOK: "https://alert.test" });
    assert.equal(secrets.botToken, "test-bot");
    assert.equal(secrets.modelApiKey, "test-primary");
    assert.equal(secrets.cfToken, "test-cf");
    assert.equal(secrets.dingTalkWebhook, "https://alert.test");
    assert.equal(readFileSync(settingsPath, "utf8"), originalSettings);
    assert.equal(readFileSync(secretsPath, "utf8"), originalSecrets);
    const saved = JSON.parse(originalSettings);
    writeFileSync(settingsPath, JSON.stringify({ ...saved, botHistoryEnabled: "false" }));
    assert.throws(() => loadSettings(directory, {}));
    writeFileSync(settingsPath, JSON.stringify({ ...saved, excludedServerIds: [123] }));
    assert.throws(() => loadSettings(directory, {}));
    const savedSecrets = JSON.parse(originalSecrets);
    const token = "optional-pairing-token-for-test";
    for (const tokens of [{ pairingToken: "", adminToken: "" }, { pairingToken: token, adminToken: "" }, { pairingToken: "", adminToken: token }, { pairingToken: token, adminToken: "optional-admin-token-for-test" }]) {
        writeFileSync(secretsPath, JSON.stringify({ ...savedSecrets, ...tokens }));
        const loaded = loadSecrets(directory, {});
        assert.equal(loaded.pairingToken, tokens.pairingToken);
        assert.equal(loaded.adminToken, tokens.adminToken);
    }
    for (const tokens of [{ pairingToken: "short", adminToken: "" }, { pairingToken: "", adminToken: "short" }]) {
        writeFileSync(secretsPath, JSON.stringify({ ...savedSecrets, ...tokens }));
        assert.throws(() => loadSecrets(directory, {}));
    }
    writeFileSync(secretsPath, JSON.stringify({ ...savedSecrets, pairingToken: token, adminToken: token }));
    assert.throws(() => loadSecrets(directory, {}), /distinct/);
    assert.equal(loadDingTalkWebhook(directory, {}), "", "Watchdog must not depend on valid main-service tokens");
    writeFileSync(secretsPath, "{");
    assert.equal(loadDingTalkWebhook(directory, { DINGTALK_WEBHOOK: "https://alert.test" }), "https://alert.test", "Explicit watchdog credentials survive damaged service configuration");
});
