import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync,readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { digest } from "../src/config.js";

test("CLI init, HTTP capture, shutdown, offline-cache restart and verified backup", { timeout: 20_000 }, async context => {
    const directory = mkdtempSync(join(tmpdir(), "hub-cli-"));
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const environment = { ...process.env, SIGNAL_HUB_VAR: directory, DISCORD_BOT_TOKEN: "", OPENAI_KEY: "", OPENAI_API_KEY: "", SIGNAL_HUB_CF_TOKEN: "", DINGTALK_WEBHOOK: "" };
    const command = (action: string) => execFileSync(process.execPath, ["--import", "tsx", "src/main.ts", action], { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const output = command("init");
    const secrets = JSON.parse(readFileSync(join(directory, "secrets.json"), "utf8"));
    assert.equal(secrets.pairingToken, "");
    assert.equal(secrets.adminToken, "");
    assert.match(output, /default to empty/);
    assert.throws(() => command("init"));
    const mock = createServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        if (request.url?.startsWith("/routes")) response.end(JSON.stringify({ routes: [], total: 0, page: 1 }));
        else if (request.url?.endsWith("signal-config")) response.end(JSON.stringify({ enabled: false }));
        else response.end(JSON.stringify({ profiles: [] }));
    });
    mock.listen(0, "127.0.0.1"); await once(mock, "listening");
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const { port } = (reservation.address() as any);
    await new Promise<void>(done => reservation.close(() => done()));
    const settings = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"));
    settings.port = port;
    settings.cfBaseUrl = `http://127.0.0.1:${(mock.address() as any).port}`;
    writeFileSync(join(directory, "settings.json"), JSON.stringify(settings));
    const base = `http://127.0.0.1:${port}`;
    let child: ReturnType<typeof spawn> | undefined;
    let exited: Promise<any> | undefined;
    let logs = "";
    async function start() {
        child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
        exited = once(child, "exit");
        child.stdout?.on("data", data => { logs += data.toString(); });
        for (let attempt = 0; attempt < 100; attempt++) {
            try { if ((await fetch(`${base}/healthz`)).ok) return; } catch {}
            await delay(30);
        }
        throw new Error("hub startup timed out");
    }
    async function stop() {
        if (child && child.exitCode === null) { child.kill("SIGTERM"); await exited; }
        child = undefined;
    }
    context.after(async () => {
        await stop();
        if (mock.listening) await new Promise<void>(done => mock.close(() => done()));
        rmSync(directory, { recursive: true, force: true });
    });
    const getStatus = async () => (await fetch(`${base}/api/status`)).json();
    await start();
    let status: any;
    for (let attempt = 0; attempt < 100; attempt++) {
        status = await getStatus();
        if (status.configHash) break;
        await delay(20);
    }
    assert.ok(status.configHash);
    const event = {
        schemaVersion: 2, eventId: "cli:1", eventType: "MESSAGE_CREATE", capturedAt: new Date().toISOString(),
        accountId: "1", serverId: "2", channelId: "3", excludedServerIds: [], message: { id: "4", content: "test only" },
    };
    const submit = async (payload: unknown) => fetch(`${base}/forward`, { method: "POST", body: JSON.stringify(payload) });
    const captured = await submit(event);
    assert.equal(captured.status, 202);
    assert.equal((await captured.json()).hash, digest(JSON.stringify(event)));
    await stop();
    await new Promise<void>(done => mock.close(() => done()));
    await start();
    assert.equal((await getStatus()).configHash, status.configHash);
    assert.equal((await submit({ ...event, eventId: "cli:2", message: { id: "5", content: null, embeds: [{ title: "embed only" }] } })).status, 202);
    assert.equal((await getStatus()).receipts, 2);
    await stop();
    assert.match(command("backup"), /Created SQLite backup/);
    const backups = readdirSync(join(directory, "backups"));
    assert.ok(backups.some(file => file.endsWith(".sqlite3.json")));
    assert.equal(JSON.parse(command("status")).receipts, 2);
    assert.ok(!logs.includes("test only"));
    assert.match(logs, /INFO Hub started/);
    assert.doesNotMatch(logs, /capture_committed|Capture saved|\x1b/);
    const entries = readdirSync(join(directory, "logs")).filter(file => file.endsWith(".jsonl"))
        .flatMap(file => readFileSync(join(directory, "logs", file), "utf8").trim().split("\n").map(line => JSON.parse(line)));
    const captures = entries.filter(entry => entry.event === "capture_committed");
    assert.equal(captures.length, 2);
    assert.ok(captures.every(entry => entry.level === "debug" && !Object.hasOwn(entry, "hash")));
    assert.equal(entries.filter(entry => entry.event === "hub_stopped").length, 2, "Shutdown flushes the final JSONL record on each run");
});
