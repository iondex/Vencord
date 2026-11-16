import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

test("startup script uses JSON settings, preserves credentials and forwards shutdown", { timeout: 20_000 }, async context => {
    const directory = mkdtempSync(join(tmpdir(), "hub-startup-"));
    const script = fileURLToPath(new URL("../scripts/start.sh", import.meta.url));
    const mock = createServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(request.url?.startsWith("/routes") ? { routes: [], total: 0, page: 1 }
            : request.url?.endsWith("signal-config") ? { enabled: false } : { profiles: [] }));
    });
    mock.listen(0, "127.0.0.1"); await once(mock, "listening");
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const { port } = reservation.address() as any;
    await new Promise<void>(done => reservation.close(() => done()));
    const env: NodeJS.ProcessEnv = { ...process.env, SIGNAL_HUB_VAR: directory,
        DISCORD_BOT_TOKEN: "", OPENAI_KEY: "", OPENAI_API_KEY: "", SIGNAL_HUB_CF_TOKEN: "", DINGTALK_WEBHOOK: "" };
    for (const key of ["SIGNAL_HUB_HOST", "SIGNAL_HUB_PORT", "SIGNAL_HUB_CF_BASE_URL"]) delete env[key];
    const processState: { child?: ReturnType<typeof spawn>; exited?: Promise<any>; watchdog?: ReturnType<typeof spawn>; watchdogExited?: Promise<any>; } = {};
    context.after(async () => {
        if (processState.child && processState.child.exitCode === null) { processState.child.kill("SIGKILL"); await processState.exited; }
        if (processState.watchdog && processState.watchdog.exitCode === null) { processState.watchdog.kill("SIGKILL"); await processState.watchdogExited; }
        await new Promise<void>(done => { mock.close(() => done()); mock.closeAllConnections(); });
        rmSync(directory, { recursive: true, force: true });
    });
    const command = (action: string) => execFileSync("bash", [script, action], { cwd: tmpdir(), env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.throws(() => command("status"), /No signal-hub database/);
    const output = command("configure");
    assert.match(output, /settings\.json/);
    assert.match(output, /secrets\.json/);
    assert.match(output, /Discord Settings > Vencord > Plugins > forwarder/);
    assert.match(output, /pairingToken/);
    const secret = readFileSync(join(directory, "secrets.json"), "utf8");
    const credentials = JSON.parse(secret);
    assert.equal(credentials.pairingToken, "");
    assert.equal(credentials.adminToken, "");
    const defaults = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"));
    assert.equal(defaults.host, "127.0.0.1");
    assert.equal(defaults.port, 49321);
    assert.equal(existsSync(join(directory, "plugin-connection.json")), false);
    assert.equal(existsSync(join(directory, "db")), false, "Configure must not start the service");
    assert.match(output, /Leave localPairingToken empty/);
    const settings = { ...defaults, host: "0.0.0.0", port, cfBaseUrl: `http://127.0.0.1:${(mock.address() as any).port}` };
    assert.throws(() => command("status"), /No signal-hub database/);
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ ...settings, botHistoryEnabled: "false" }));
    assert.throws(() => command("serve"));
    assert.equal(existsSync(join(directory, "db", "signal-hub.sqlite3")), false, "Invalid startup settings must fail before creating the database");
    writeFileSync(join(directory, "settings.json"), JSON.stringify(settings));
    const repeatedOutput = command("configure");
    assert.equal(readFileSync(join(directory, "secrets.json"), "utf8"), secret);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "settings.json"), "utf8")), settings);
    assert.match(repeatedOutput, /Leave localPairingToken empty/);
    const child = processState.child = spawn("bash", [script], { cwd: tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });
    const exited = processState.exited = once(child, "exit");
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        try { ready = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch {}
        if (ready) break;
        await delay(30);
    }
    assert.equal(ready, true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status, 200);
    assert.equal(JSON.parse(command("status")).receipts, 0);
    assert.match(command("backup"), /Created SQLite backup/);
    const watchdog = processState.watchdog = spawn("bash", [script, "watchdog"], { cwd: tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });
    const watchdogExited = processState.watchdogExited = once(watchdog, "exit");
    let watchdogOutput = "";
    watchdog.stdout?.on("data", data => { watchdogOutput += data.toString(); });
    for (let attempt = 0; attempt < 100 && !watchdogOutput.includes("watchdog started"); attempt++) await delay(30);
    assert.match(watchdogOutput, /watchdog started; notifications disabled/);
    watchdog.kill("SIGTERM");
    assert.deepEqual(await watchdogExited, [null, "SIGTERM"]);
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
    writeFileSync(join(directory, "settings.json"), "{");
    writeFileSync(join(directory, "secrets.json"), "{");
    assert.equal(JSON.parse(command("status")).receipts, 0, "Diagnostics must remain usable when service settings are damaged");
    assert.match(command("backup"), /Created SQLite backup/);
    rmSync(join(directory, "settings.json"));
    rmSync(join(directory, "secrets.json"));
    assert.equal(JSON.parse(command("status")).receipts, 0);
    assert.match(command("backup"), /Created SQLite backup/);
});
