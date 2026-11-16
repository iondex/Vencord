import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createLocalTransport } from "@plugins/forwarder.desktop/localTransport";

function fixture(context: TestContext, rejectStatus = 0) {
    const directory = mkdtempSync(join(tmpdir(), "forwarder-recovery-"));
    const root = join(directory, "spool", "forwarder");
    const requests: string[] = [];
    let status = rejectStatus;
    const transport = createLocalTransport(async (_url, input) => {
        const body = String(input?.body);
        requests.push(body);
        if (status) return new Response("{}", { status });
        return Response.json({ eventId: JSON.parse(body).eventId, hash: createHash("sha256").update(body).digest("hex"), durable: true });
    });
    transport.configure({ url: "http://127.0.0.1:1/forward", token: "", runtimeDirectory: directory });
    context.after(async () => { await transport.stop(); rmSync(directory, { recursive: true, force: true }); });
    const capture = (id = "3") => ({
        schemaVersion: 2 as const, eventId: `discord:1:2:${id}:create`, eventType: "MESSAGE_CREATE" as const,
        capturedAt: "2026-11-16T08:00:00.000Z", accountId: "1", serverId: "4", channelId: "2", excludedServerIds: [],
        message: { id, content: "preserve exactly", timestamp: "2026-11-16T08:00:00.000Z", author: { id: "5" } },
    });
    return { transport, root, requests, capture, accept() { status = 0; } };
}

test("a capture that cannot reach disk remains observable and retries before HTTP handoff", async context => {
    const { transport, root, requests, capture } = fixture(context);
    const pending = join(root, "pending");
    renameSync(pending, `${pending}.saved`);
    writeFileSync(pending, "simulate an unavailable spool");
    const event = capture();
    const result = transport.enqueue(event);
    assert.equal(result.ok, false);
    assert.equal(result.durable, false);
    assert.equal(transport.status().uncommitted, 1);
    assert.ok(transport.status().persistenceError);
    assert.equal(requests.length, 0);
    unlinkSync(pending);
    renameSync(`${pending}.saved`, pending);
    await transport.drain();
    assert.equal(transport.status().uncommitted, 0);
    assert.equal(transport.status().persistenceError, null);
    assert.equal(transport.status().pending, 0);
    assert.equal(transport.status().acked, 1);
    assert.equal(JSON.parse(requests[0]).capturedAt, event.capturedAt);
    assert.equal(JSON.parse(requests[0]).eventId, result.eventId);
});

test("temporary persistence failures stay bounded and expose rejected captures", async context => {
    const { transport, root, capture } = fixture(context);
    const pending = join(root, "pending");
    renameSync(pending, `${pending}.saved`);
    writeFileSync(pending, "unavailable");
    for (let index = 0; index < 256; index++) transport.enqueue(capture(String(index + 10)));
    assert.throws(() => transport.enqueue(capture("9999")), /persistence retry buffer is full/);
    assert.equal(transport.status().uncommitted, 256);
    assert.equal(transport.status().rejectedCaptures, 1);
    unlinkSync(pending);
    renameSync(`${pending}.saved`, pending);
    await transport.drain();
    assert.equal(transport.status().uncommitted, 0);
    assert.equal(transport.status().rejectedCaptures, 1);
});

test("operator recovery preserves the original request and requeues recoverable rejections", async context => {
    const { transport, root, requests, capture, accept } = fixture(context, 413);
    transport.enqueue(capture());
    await transport.drain();
    assert.equal(transport.status().quarantined, 1);
    assert.equal(transport.status().retryableQuarantined, 1);
    assert.deepEqual(transport.status().quarantineReasons, [{ reason: "http_413", total: 1 }]);
    const original = requests[0];
    accept();
    assert.deepEqual(transport.retryQuarantined(), { requeued: 1, held: 0 });
    await transport.drain();
    assert.equal(requests[1], original);
    assert.equal(transport.status().quarantined, 0);
    assert.equal(transport.status().acked, 1);
    const file = readdirSync(join(root, "acked"))[0];
    assert.equal(readFileSync(join(root, "acked", file), "utf8"), original);
});

test("conflicts, corrupt files and legacy quarantines are never blindly replayed", async context => {
    const { transport, root, requests, capture } = fixture(context, 409);
    transport.enqueue(capture());
    await transport.drain();
    writeFileSync(join(root, "quarantine", "legacy.json"), requests[0]);
    writeFileSync(join(root, "quarantine", "broken.json"), "{");
    assert.equal(transport.status().retryableQuarantined, 0);
    assert.deepEqual(transport.retryQuarantined(), { requeued: 0, held: 3 });
    assert.equal(requests.length, 1);
    assert.equal(transport.status().quarantined, 3);
});

test("quarantine recovery refuses modified captures and existing pending files", async context => {
    const { transport, root, requests, capture } = fixture(context, 422);
    transport.enqueue(capture());
    await transport.drain();
    const file = readdirSync(join(root, "quarantine"))[0];
    const path = join(root, "quarantine", file);
    writeFileSync(path, requests[0].replace("preserve exactly", "modified"));
    assert.deepEqual(transport.retryQuarantined(), { requeued: 0, held: 1 });
    writeFileSync(path, requests[0]);
    writeFileSync(join(root, "pending", file), "must not overwrite");
    assert.deepEqual(transport.retryQuarantined(), { requeued: 0, held: 1 });
    assert.equal(readFileSync(join(root, "pending", file), "utf8"), "must not overwrite");
    assert.ok(existsSync(path));
});

test("buffered captures survive transport reconfiguration without changing their identity", async context => {
    const { transport, root, requests, capture } = fixture(context);
    const pending = join(root, "pending");
    renameSync(pending, `${pending}.saved`);
    writeFileSync(pending, "unavailable");
    const result = transport.enqueue(capture());
    await transport.stop();
    const directory = join(root, "..", "..");
    assert.throws(() => transport.configure({ url: "http://127.0.0.1:1/forward", token: "", runtimeDirectory: `${directory}-other` }), /Commit buffered captures/);
    unlinkSync(pending);
    renameSync(`${pending}.saved`, pending);
    transport.configure({ url: "http://127.0.0.1:1/forward", token: "", runtimeDirectory: directory });
    await transport.drain();
    assert.equal(transport.status().uncommitted, 0);
    assert.equal(JSON.parse(requests[0]).eventId, result.eventId);
});

test("damaged quarantine metadata is held and cannot break status inspection", async context => {
    const { transport, root, capture } = fixture(context, 400);
    transport.enqueue(capture());
    await transport.drain();
    const reason = readdirSync(join(root, "quarantine-reasons"))[0];
    writeFileSync(join(root, "quarantine-reasons", reason), "null");
    assert.deepEqual(transport.status().quarantineReasons, [{ reason: "unknown", total: 1 }]);
    assert.deepEqual(transport.retryQuarantined(), { requeued: 0, held: 1 });
});

test("repeated rejection cannot overwrite an existing quarantined capture", async context => {
    const { transport, root, capture } = fixture(context, 422);
    transport.enqueue(capture());
    await transport.drain();
    const file = readdirSync(join(root, "quarantine"))[0];
    const original = readFileSync(join(root, "quarantine", file), "utf8");
    const event = capture();
    event.message.content = "a different capture with the same identity";
    transport.enqueue(event);
    transport.enqueue(capture("99"));
    await transport.drain();
    assert.equal(readFileSync(join(root, "quarantine", file), "utf8"), original);
    assert.equal(transport.status().pending, 0);
    assert.equal(transport.status().quarantined, 3);
    assert.equal(transport.status().quarantineReasons.find(item => item.reason === "capture_conflict")?.total, 2);
    const contents = readdirSync(join(root, "quarantine")).map(name => JSON.parse(readFileSync(join(root, "quarantine", name), "utf8")).message.content);
    assert.ok(contents.includes(event.message.content));
    assert.deepEqual(transport.retryQuarantined(), { requeued: 1, held: 2 });
});
