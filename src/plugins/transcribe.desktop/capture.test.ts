import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { capturePaths, createCaptureManager, descendantPids } from "@plugins/transcribe.desktop/capture";

function fixture() {
    const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
        kill() { queueMicrotask(() => child.emit("close", 0, "SIGINT")); return true; }
    });
    const manager = createCaptureManager({ findAudioPids: async () => [42], spawn: (() => child) as unknown as typeof spawn });
    return { child, manager };
}

test("audio PID discovery only includes descendants of the Discord process", () => {
    assert.deepEqual([...descendantPids(10, "30 20\n20 10\n10 1\n99 1\n40 30")].sort((left, right) => left - right), [10, 20, 30, 40]);
    assert.throws(() => capturePaths("relative/audiotee"), /absolute path/);
    assert.ok(capturePaths("").binary.endsWith("vencord-transcribe/audiotee"));
});

test("arbitrary stdout chunk boundaries preserve complete PCM16 samples", async () => {
    const { child, manager } = fixture();
    await manager.start("session", "/test/audiotee", "/test/resolver");
    child.stdout.write(Buffer.from([1, 2, 3]));
    assert.deepEqual([...manager.read("session").pcm], [1, 2]);
    child.stdout.write(Buffer.from([4, 5, 6]));
    assert.deepEqual([...manager.read("session").pcm], [3, 4, 5, 6]);
    await manager.stop("session");
});

test("stale reads and stops cannot drain or kill a new recording session", async () => {
    const { child, manager } = fixture();
    await manager.start("new-session", "/test/audiotee", "/test/resolver");
    child.stdout.write(Buffer.from([1, 2]));
    assert.throws(() => manager.read("old-session"), /no longer active/);
    assert.equal((await manager.stop("old-session")).pcm.byteLength, 0);
    assert.deepEqual([...manager.read("new-session").pcm], [1, 2]);
    await manager.stop("new-session");
});

test("capture queue overflow stops buffering and exposes an actionable error", async () => {
    const { child, manager } = fixture();
    await manager.start("session", "/test/audiotee", "/test/resolver");
    child.stdout.write(Buffer.alloc(160_002));
    child.stdout.write(Buffer.alloc(100));
    const result = manager.read("session");
    assert.match(result.error!, /backlog/);
    assert.equal(result.pcm.byteLength, 160_002);
    await manager.stop("session");
});

test("a cancelled pending PID lookup never spawns an orphan audio recorder", async () => {
    let release!: (pids: number[]) => void;
    let spawned = false;
    const manager = createCaptureManager({
        findAudioPids: () => new Promise<number[]>(resolve => { release = resolve; }),
        spawn: (() => { spawned = true; throw new Error("must not spawn"); }) as unknown as typeof spawn
    });
    const opening = manager.start("session", "/test/audiotee", "/test/resolver");
    await manager.stop("session");
    release([42]);
    await assert.rejects(opening, /cancelled/);
    assert.equal(spawned, false);
});
