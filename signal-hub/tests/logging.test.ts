import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createLogger } from "../src/logging.js";

function fixture(context: any) {
    const directory = mkdtempSync(join(tmpdir(), "hub-logging-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function records(directory: string) {
    return readdirSync(directory).filter(file => file.endsWith(".jsonl"))
        .flatMap(file => readFileSync(join(directory, file), "utf8").trim().split("\n").map(line => JSON.parse(line)));
}

test("JSONL keeps capture and routing events while the default console shows concise delivery results", context => {
    const directory = fixture(context);
    const output: string[] = [];
    const log = createLogger(directory, { output: line => output.push(line), color: false, debug: false });
    log("capture_committed", { eventId: "event:1", duplicate: false, bytes: 1234 });
    log("message_planned", { messageKey: "discord:2:3:4", state: "no_matching_route", routeIds: "" });
    log("delivery_sent", { jobId: "0123456789abcdef", routeName: "测试路由", target: "5", attempts: 2, durationMs: 41, messageId: "6", hash: "full-audit-hash" });
    log("delivery_finished", { jobId: "failed-job", state: "uncertain", code: "send_outcome_unknown" });
    assert.equal(output.length, 2);
    assert.match(output[0], /✓ 转发成功 · 路由 测试路由 · → 5 · 第 2 次 · 41ms · 任务 01234567/);
    assert.match(output[1], /错误 投递暂未完成.*结果待对账.*send_outcome_unknown/);
    assert.doesNotMatch(output.join(""), /capture_committed|消息已保存|未匹配路由|full-audit-hash|0123456789abcdef|\x1b/);
    const entries = records(directory);
    assert.equal(entries.length, 4);
    assert.deepEqual(entries.map(entry => entry.level), ["debug", "debug", "info", "error"]);
    assert.equal(entries[0].eventId, "event:1");
    assert.equal(entries[0].bytes, 1234);
    assert.equal(entries[2].hash, "full-audit-hash");
    assert.equal(entries[2].jobId, "0123456789abcdef");
    assert.ok(entries.every(entry => Number.isFinite(Date.parse(entry.time))));
});

test("debug output is opt-in and color does not alter raw JSONL or allow terminal control characters", context => {
    const directory = fixture(context);
    const output: string[] = [];
    const log = createLogger(directory, { output: line => output.push(line), color: true, debug: true });
    log("capture_committed", { eventId: "event:1", bytes: 100 });
    log("delivery_sent", { routeName: "route\n\x1b[31m", reconciled: true });
    assert.match(output[0], /\x1b\[90m调试\x1b\[0m 消息已保存/);
    assert.match(output[1], /\x1b\[32m✓\x1b\[0m 对账确认送达/);
    assert.equal((output[1].match(/\x1b/g) ?? []).length, 2);
    assert.equal(output[1].split("\n").length, 2);
    assert.equal(records(directory)[1].routeName, "route\n\x1b[31m");
});

test("file failures keep console output working and report once until file writes recover", context => {
    const directory = fixture(context);
    const logDirectory = join(directory, "logs");
    const output: string[] = [];
    const errors: string[] = [];
    const log = createLogger(logDirectory, { output: line => output.push(line), errorOutput: line => errors.push(line), color: false });
    rmSync(logDirectory, { recursive: true });
    writeFileSync(logDirectory, "blocked");
    log("hub_started");
    log("hub_stopped");
    assert.equal(errors.length, 1);
    assert.equal(output.length, 2);
    rmSync(logDirectory);
    mkdirSync(logDirectory);
    log("hub_started");
    assert.equal(records(logDirectory).length, 1);
    rmSync(logDirectory, { recursive: true });
    log("hub_stopped");
    assert.equal(errors.length, 2);
});

test("console failures do not interrupt callers or lose the JSONL record", context => {
    const directory = fixture(context);
    const log = createLogger(directory, { output: () => { throw new Error("closed terminal"); }, color: false });
    assert.doesNotThrow(() => log("delivery_sent", { jobId: "job", messageId: "6" }));
    assert.equal(records(directory)[0].event, "delivery_sent");
});
