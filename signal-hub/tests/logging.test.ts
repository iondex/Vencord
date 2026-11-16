import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";

import { createLogger } from "../src/logging.js";

function fixture(context: TestContext) {
    const directory = mkdtempSync(join(tmpdir(), "hub-logging-"));
    const loggers: ReturnType<typeof createLogger>[] = [];
    context.after(async () => {
        await Promise.all(loggers.map(log => log.close()));
        rmSync(directory, { recursive: true, force: true });
    });
    return {
        directory,
        logger(options: Parameters<typeof createLogger>[1] = {}, path = directory) {
            const log = createLogger(path, options);
            loggers.push(log);
            return log;
        },
    };
}

function records(directory: string) {
    return readdirSync(directory).filter(file => file.endsWith(".jsonl"))
        .flatMap(file => readFileSync(join(directory, file), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

async function waitFor(condition: () => boolean) {
    for (let attempt = 0; attempt < 300; attempt++) {
        if (condition()) return;
        await delay(10);
    }
    assert.fail("Timed out waiting for log I/O");
}

test("JSONL keeps capture and routing events while the default console shows concise delivery results", async context => {
    const { directory, logger } = fixture(context);
    const output: string[] = [];
    const log = logger({ output: line => output.push(line), color: false, debug: false });
    log("capture_committed", { eventId: "event:1", duplicate: false, bytes: 1234 });
    log("message_planned", { messageKey: "discord:2:3:4", state: "no_matching_route", routeIds: "" });
    log("delivery_sent", { jobId: "0123456789abcdef", routeName: "测试路由", target: "5", attempts: 2, durationMs: 41, messageId: "6", hash: "full-audit-hash" });
    log("delivery_finished", { jobId: "failed-job", state: "uncertain", code: "send_outcome_unknown" });
    await log.close();
    assert.equal(output.length, 2);
    assert.match(output[0], /✓ Delivered · route 测试路由 · → 5 · attempt 2 · 41ms · job 01234567/);
    assert.match(output[1], /ERROR Delivery pending.*awaiting reconciliation.*send_outcome_unknown/);
    assert.doesNotMatch(output.join(""), /capture_committed|Capture saved|no matching route|full-audit-hash|0123456789abcdef|\x1b/);
    const entries = records(directory);
    assert.equal(entries.length, 4);
    assert.deepEqual(entries.map(entry => entry.level), ["debug", "debug", "info", "error"]);
    assert.equal(entries[0].eventId, "event:1");
    assert.equal(entries[0].bytes, 1234);
    assert.equal(entries[2].hash, "full-audit-hash");
    assert.equal(entries[2].jobId, "0123456789abcdef");
    assert.ok(entries.every(entry => Number.isFinite(Date.parse(entry.time)) && !Object.hasOwn(entry, "message")));
    const files = readdirSync(directory).filter(file => file.endsWith(".jsonl"));
    assert.ok(files.every(file => (statSync(join(directory, file)).mode & 0o777) === 0o600));
});

test("debug output is opt-in and color does not alter raw JSONL or allow terminal control characters", async context => {
    const { directory, logger } = fixture(context);
    const output: string[] = [];
    const log = logger({ output: line => output.push(line), color: true, debug: true });
    log("capture_committed", { eventId: "event:1", bytes: 100 });
    log("delivery_sent", { routeName: "route\n\x1b[31m", reconciled: true });
    await log.close();
    assert.match(output[0], /\x1b\[90mDEBUG\x1b\[0m Capture saved/);
    assert.match(output[1], /\x1b\[32m✓\x1b\[0m Delivery confirmed by reconciliation/);
    assert.equal((output[1].match(/\x1b/g) ?? []).length, 2);
    assert.equal(output[1].split("\n").length, 2);
    assert.equal(records(directory)[1].routeName, "route\n\x1b[31m");
});

test("file open errors do not crash logging, block shutdown or flood the console", async context => {
    const { directory, logger } = fixture(context);
    const path = join(directory, "logs");
    const output: string[] = [];
    const errors: string[] = [];
    const log = logger({ output: line => output.push(line), errorOutput: line => errors.push(line), color: false }, path);
    rmSync(path, { recursive: true });
    writeFileSync(path, "blocked");
    await waitFor(() => errors.length > 0);
    log("hub_started");
    log("hub_stopped");
    await log.close();
    assert.equal(errors.length, 1);
    assert.equal(output.length, 2);
    assert.match(errors[0], /log file operation failed/);
});

test("an unavailable log directory leaves console logging operational", async context => {
    const { directory, logger } = fixture(context);
    const blocked = join(directory, "blocked");
    writeFileSync(blocked, "not a directory");
    const output: string[] = [];
    const errors: string[] = [];
    const log = logger({ output: line => output.push(line), errorOutput: line => errors.push(line), color: false }, join(blocked, "logs"));
    log("hub_started");
    await log.close();
    assert.equal(errors.length, 1);
    assert.match(output[0], /INFO Hub started/);
});

test("console failures do not interrupt callers or lose the JSONL record", async context => {
    const { directory, logger } = fixture(context);
    const log = logger({ output: () => { throw new Error("closed terminal"); }, color: false });
    assert.doesNotThrow(() => log("delivery_sent", { jobId: "job", messageId: "6" }));
    await log.close();
    assert.equal(records(directory)[0].event, "delivery_sent");
});

test("daily rotation compresses complete JSONL, expires managed logs after seven days and preserves unrelated files", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-08T23:59:59Z") });
    const { directory, logger } = fixture(context);
    const log = logger({ output: () => {}, color: false });
    const original = join(directory, "hub-2026-11-08.jsonl");
    const archive = `${original}.gz`;
    log("hub_started");
    await waitFor(() => existsSync(original) && statSync(original).size > 0);
    const body = readFileSync(original, "utf8");
    const unrelated = join(directory, "notes.jsonl");
    const legacy = join(directory, "hub-2026-11-01-0.jsonl");
    writeFileSync(unrelated, "unrelated");
    writeFileSync(legacy, "previous logger");
    context.mock.timers.setTime(new Date("2026-11-09T00:00:00Z").getTime());
    log("config_sync_ok");
    await waitFor(() => existsSync(archive) && !existsSync(original));
    assert.equal(gunzipSync(readFileSync(archive)).toString(), body);
    assert.equal(statSync(archive).mode & 0o777, 0o600);
    context.mock.timers.setTime(new Date("2026-11-15T23:59:58Z").getTime());
    log("config_sync_ok");
    await waitFor(() => existsSync(join(directory, "hub-2026-11-09.jsonl.gz")));
    assert.ok(existsSync(archive), "The archive is kept until its full seven-day retention has elapsed");
    context.mock.timers.setTime(new Date("2026-11-16T00:00:00Z").getTime());
    log("hub_stopped");
    await log.close();
    await waitFor(() => !existsSync(join(directory, "hub-2026-11-15.jsonl")));
    assert.equal(existsSync(archive), false);
    assert.equal(readFileSync(unrelated, "utf8"), "unrelated");
    assert.equal(readFileSync(legacy, "utf8"), "previous logger");
    assert.equal(JSON.parse(readFileSync(join(directory, "hub-2026-11-16.jsonl"), "utf8")).event, "hub_stopped");
});

test("size rotation compresses at 10 MiB and restart appends without losing records", async context => {
    const { directory, logger } = fixture(context);
    const log = logger({ output: () => {}, color: false });
    const today = new Date().toISOString().slice(0, 10);
    const original = join(directory, `hub-${today}.jsonl`);
    log("capture_committed", { eventId: "large", payload: "x".repeat(10 * 1024 * 1024) });
    await waitFor(() => existsSync(original) && statSync(original).size > 10 * 1024 * 1024);
    log("delivery_sent", { messageId: "before-restart" });
    await log.close();
    await waitFor(() => existsSync(`${original}.gz`) && !existsSync(original));
    assert.equal(JSON.parse(gunzipSync(readFileSync(`${original}.gz`)).toString()).eventId, "large");
    const restarted = logger({ output: () => {}, color: false });
    restarted("hub_started", { messageId: "after-restart" });
    await restarted.close();
    assert.deepEqual(records(directory).map(entry => entry.messageId), ["before-restart", "after-restart"]);
});

test("a burst crossing the size limit retains every record across compressed and active files", async context => {
    const { directory, logger } = fixture(context);
    const log = logger({ output: () => {}, color: false });
    const original = join(directory, `hub-${new Date().toISOString().slice(0, 10)}.jsonl`);
    log("hub_started");
    await waitFor(() => existsSync(original) && statSync(original).size > 0);
    for (let index = 0; index < 24; index++) log("capture_committed", { eventId: `burst:${index}`, payload: "x".repeat(512 * 1024) });
    await log.close();
    await waitFor(() => existsSync(`${original}.gz`) && !existsSync(original));
    const archived = gunzipSync(readFileSync(`${original}.gz`)).toString().trim().split("\n").map(line => JSON.parse(line));
    const entries = [...archived, ...records(directory)];
    assert.equal(entries[0].event, "hub_started");
    assert.deepEqual(entries.slice(1).map(entry => entry.eventId), Array.from({ length: 24 }, (_, index) => `burst:${index}`));
});

test("restart uses the persisted rotation audit to expire old files and flushes the final record", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-01T12:00:00Z") });
    const { directory, logger } = fixture(context);
    const previous = logger({ output: () => {}, color: false });
    previous("hub_started");
    await previous.close();
    const expired = join(directory, "hub-2026-11-01.jsonl");
    assert.ok(existsSync(expired));
    context.mock.timers.setTime(new Date("2026-11-16T12:00:00Z").getTime());
    const restarted = logger({ output: () => {}, color: false });
    restarted("hub_stopped");
    await restarted.close();
    assert.equal(existsSync(expired), false);
    assert.equal(records(directory)[0].event, "hub_stopped");
});
