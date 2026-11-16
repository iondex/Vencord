import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createLocalTransport } from "./localTransport";

test("daily cleanup runs at 20:00 Shanghai, only removes acknowledged captures, and catches up after restart", async context => {
    const directory = mkdtempSync(join(tmpdir(), "forwarder-retention-"));
    const root = join(directory, "spool/forwarder");
    mkdirSync(root, { recursive: true });
    const cutoff = Date.parse("2026-11-15T20:00:00+08:00");
    const state = { lastCutoff: cutoff, lastRunAt: cutoff, removed: 0, freedBytes: 0, totalRemoved: 0 };
    const transport = createLocalTransport();
    context.after(async () => { await transport.stop(); rmSync(directory, { recursive: true, force: true }); });
    transport.configure({ url: "http://127.0.0.1:1/forward", runtimeDirectory: directory, token: "" });
    await transport.stop();
    writeFileSync(join(root, "cleanup-state.json"), JSON.stringify(state));
    transport.configure({ url: "http://127.0.0.1:1/forward", runtimeDirectory: directory, token: "" });
    await transport.stop();
    const nextCutoff = transport.status().nextCleanupAt!;
    const filename = `${"a".repeat(64)}.json`;
    for (const name of ["acked", "pending", "quarantine"]) writeFileSync(join(root, name, filename), "capture");
    writeFileSync(join(root, "acked", "unrelated.txt"), "preserve");
    await transport.cleanup(nextCutoff - 1);
    assert.ok(existsSync(join(root, "acked", filename)));
    await transport.cleanup(nextCutoff);
    assert.equal(existsSync(join(root, "acked", filename)), false);
    assert.ok(existsSync(join(root, "pending", filename)));
    assert.ok(existsSync(join(root, "quarantine", filename)));
    assert.ok(existsSync(join(root, "acked", "unrelated.txt")));
    assert.equal(transport.status().lastCleanupCount, 1);
    assert.equal(transport.status().lastCleanupBytes, Buffer.byteLength("capture"));
    assert.equal(new Date(transport.status().nextCleanupAt!).getUTCHours(), 12);
    await transport.cleanup(nextCutoff + 1000);
    assert.equal(transport.status().totalCleaned, 1);
    const saved = JSON.parse(readFileSync(join(root, "cleanup-state.json"), "utf8"));
    assert.equal(saved.lastCutoff, nextCutoff);
    saved.lastCutoff = cutoff - 86_400_000;
    writeFileSync(join(root, "cleanup-state.json"), JSON.stringify(saved));
    writeFileSync(join(root, "acked", filename), "missed-while-offline");
    transport.configure({ url: "http://127.0.0.1:1/forward", runtimeDirectory: directory, token: "" });
    await transport.stop();
    assert.equal(existsSync(join(root, "acked", filename)), false);
    assert.ok(existsSync(join(root, "pending", filename)));
});

test("a damaged cleanup plan cannot prevent the collector from starting", async context => {
    const directory = mkdtempSync(join(tmpdir(), "forwarder-retention-invalid-"));
    const root = join(directory, "spool/forwarder");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "cleanup-state.json"), "{");
    const transport = createLocalTransport();
    context.after(async () => { await transport.stop(); rmSync(directory, { recursive: true, force: true }); });
    assert.doesNotThrow(() => transport.configure({ url: "http://127.0.0.1:1/forward", runtimeDirectory: directory, token: "" }));
    assert.equal(transport.status().active, true);
    assert.ok(transport.status().cleanupError);
});

test("large cleanup yields the event loop while preserving unacknowledged files", async context => {
    const directory = mkdtempSync(join(tmpdir(), "forwarder-retention-large-"));
    const transport = createLocalTransport();
    context.after(async () => { await transport.stop(); rmSync(directory, { recursive: true, force: true }); });
    transport.configure({ url: "http://127.0.0.1:1/forward", runtimeDirectory: directory, token: "" });
    await transport.stop();
    const root = join(directory, "spool/forwarder");
    for (let index = 0; index < 150; index++) writeFileSync(join(root, "acked", `${index.toString(16).padStart(64, "0")}.json`), "acknowledged");
    const pending = join(root, "pending", `${"f".repeat(64)}.json`);
    writeFileSync(pending, "must-preserve");
    const yielded = new Promise<number>(resolveYield => setImmediate(() => resolveYield(transport.status().acked)));
    const cleaning = transport.cleanup(transport.status().nextCleanupAt!);
    const remainingDuringCleanup = await yielded;
    assert.ok(remainingDuringCleanup > 0 && remainingDuringCleanup < 150);
    await cleaning;
    assert.equal(transport.status().acked, 0);
    assert.equal(readFileSync(pending, "utf8"), "must-preserve");
});
