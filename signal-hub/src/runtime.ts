import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { validateServiceUrl } from "../contracts/ingest.js";
import { writeDurable } from "./files.js";

const settingsSchema = z.object({
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535),
    cfBaseUrl: z.string(),
    excludedServerIds: z.array(z.string().regex(/^\d{1,32}$/)).default([]),
    loggerDatabase: z.string().default(""),
    recoveryAccountId: z.string().regex(/^\d{1,32}$|^$/).default(""),
    botHistoryEnabled: z.boolean().default(false),
    testMode: z.boolean().default(false),
    forwardAfter: z.string().datetime({ offset: true }).or(z.literal("")).default(""),
});
const secretsSchema = z.object({
    pairingToken: z.string().min(24).or(z.literal("")).default(""),
    adminToken: z.string().min(24).or(z.literal("")).default(""),
    botToken: z.string().default(""),
    modelApiKey: z.string().default(""),
    cfToken: z.string().default(""),
    dingTalkWebhook: z.string().default(""),
    webhooks: z.record(z.string(), z.string()).default({}),
}).refine(value => !value.pairingToken || !value.adminToken || value.pairingToken !== value.adminToken, "Non-empty pairing and admin tokens must be distinct");

export function getRuntimeDirectory(environment = process.env) {
    const directory = environment.SIGNAL_HUB_VAR ?? fileURLToPath(new URL("../var", import.meta.url));
    if (!isAbsolute(directory)) throw new Error("SIGNAL_HUB_VAR must be absolute");
    return directory;
}

function parseSettings(value: unknown) {
    const settings = settingsSchema.parse(value);
    validateServiceUrl(settings.cfBaseUrl);
    return settings;
}

export function initializeRuntime(directory: string, environment = process.env) {
    if (existsSync(join(directory, "secrets.json")) || existsSync(join(directory, "settings.json"))) {
        throw new Error("Initialization files already exist; preserve existing tokens and settings");
    }
    const settings = parseSettings({
        host: environment.SIGNAL_HUB_HOST ?? "127.0.0.1",
        port: Number(environment.SIGNAL_HUB_PORT ?? 49321),
        cfBaseUrl: environment.SIGNAL_HUB_CF_BASE_URL ?? "https://forwarder.yufeng.run",
    });
    const secrets = secretsSchema.parse({});
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeDurable(join(directory, "secrets.json"), JSON.stringify(secrets, null, 4));
    writeDurable(join(directory, "settings.json"), JSON.stringify(settings, null, 4));
}

export function loadSettings(directory: string, environment = process.env) {
    const settings = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"));
    return parseSettings({
        ...settings,
        host: environment.SIGNAL_HUB_HOST ?? settings.host,
        port: Number(environment.SIGNAL_HUB_PORT ?? settings.port),
        cfBaseUrl: environment.SIGNAL_HUB_CF_BASE_URL ?? settings.cfBaseUrl,
    });
}

export function loadSecrets(directory: string, environment = process.env) {
    const secrets = JSON.parse(readFileSync(join(directory, "secrets.json"), "utf8"));
    return secretsSchema.parse({
        ...secrets,
        botToken: environment.DISCORD_BOT_TOKEN || secrets.botToken,
        modelApiKey: environment.OPENAI_KEY || environment.OPENAI_API_KEY || secrets.modelApiKey,
        cfToken: environment.SIGNAL_HUB_CF_TOKEN || secrets.cfToken,
        dingTalkWebhook: environment.DINGTALK_WEBHOOK || secrets.dingTalkWebhook,
    });
}

export function loadDingTalkWebhook(directory: string, environment = process.env) {
    if (environment.DINGTALK_WEBHOOK) return environment.DINGTALK_WEBHOOK;
    const secrets = JSON.parse(readFileSync(join(directory, "secrets.json"), "utf8"));
    return z.string().parse(secrets.dingTalkWebhook ?? "");
}
