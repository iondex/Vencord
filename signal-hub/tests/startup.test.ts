import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

test("startup script configures a LAN connection, preserves tokens and forwards shutdown", { timeout: 20_000 }, async context => {
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
    const env = { ...process.env, SIGNAL_HUB_VAR: directory, SIGNAL_HUB_HOST: "0.0.0.0", SIGNAL_HUB_PORT: String(port),
        SIGNAL_HUB_CF_BASE_URL: `http://127.0.0.1:${(mock.address() as any).port}`, SIGNAL_HUB_PUBLIC_URL: `http://192.168.1.10:${port}/forward`,
        DISCORD_BOT_TOKEN: "", OPENAI_KEY: "", OPENAI_API_KEY: "", SIGNAL_HUB_CF_TOKEN: "", DINGTALK_WEBHOOK: "" };
    const processState: { child?: ReturnType<typeof spawn>; exited?: Promise<any>; } = {};
    context.after(async () => {
        if (processState.child && processState.child.exitCode === null) { processState.child.kill("SIGKILL"); await processState.exited; }
        await new Promise<void>(done => { mock.close(() => done()); mock.closeAllConnections(); });
        rmSync(directory, { recursive: true, force: true });
    });
    const configure = () => execFileSync("bash", [script, "configure"], { cwd: tmpdir(), env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const output = configure();
    const secret = readFileSync(join(directory, "secrets.json"), "utf8");
    const settings = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"));
    const connection = JSON.parse(readFileSync(join(directory, "plugin-connection.json"), "utf8"));
    assert.equal(settings.host, "0.0.0.0");
    assert.equal(settings.port, port);
    assert.equal(connection.localServerUrl, env.SIGNAL_HUB_PUBLIC_URL);
    assert.ok(!output.includes(connection.localPairingToken));
    configure();
    assert.equal(readFileSync(join(directory, "secrets.json"), "utf8"), secret);
    const child = processState.child = spawn("bash", [script], { cwd: tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });
    const exited = processState.exited = once(child, "exit");
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        try { ready = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch {}
        if (ready) break;
        await delay(30);
    }
    assert.equal(ready, true);
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
});
