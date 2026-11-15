import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { createTranscribeRuntime, type RuntimeDependencies } from "@plugins/transcribe.desktop/runtime";
import type { Sentence, StreamTarget, TranscriptionOptions } from "@plugins/transcribe.desktop/types";

const target: StreamTarget = { key: "guild:g:c:u", guildId: "g", channelId: "c", ownerId: "u", streamType: "guild" };

function fixture(context: TestContext, overrides: Partial<RuntimeDependencies> = {}) {
    let streams = [target];
    let channel: string | undefined;
    let callbacks: Pick<TranscriptionOptions, "onTranscript" | "onError">;
    const calls: string[] = [];
    const sentences: Sentence[] = [];
    const errors: Error[] = [];
    const runtime = createTranscribeRuntime({
        channelIds: ["c"],
        listStreams: () => streams,
        currentChannelId: () => channel,
        async prepare() { calls.push("prepare"); },
        async join(stream) { calls.push("join"); channel = stream.channelId; return () => { calls.push("leave"); }; },
        createTranscriber(handlers) {
            callbacks = handlers;
            return {
                async connect() { calls.push("connect"); },
                sendAudio() { calls.push("audio"); },
                async finish() {
                    calls.push("finish");
                    callbacks.onTranscript({ segments: [{ id: "final", text: "Final sentence", startMs: 0, endMs: 1000, final: false }], draft: "" });
                },
                abort() { calls.push("abort"); }
            };
        },
        async startCapture() { calls.push("capture"); },
        async readCapture() { return { pcm: new Uint8Array() }; },
        async stopCapture() { calls.push("stop-capture"); return { pcm: new Uint8Array() }; },
        onSentence(sentence) { sentences.push(sentence); },
        onError(error) { errors.push(error); },
        pollMs: 5,
        ...overrides
    });
    context.after(() => runtime.stop());
    return {
        runtime, calls, sentences, errors,
        setStreams(value: StreamTarget[]) { streams = value; },
        setChannel(value: string | undefined) { channel = value; },
        update(text: string) { callbacks.onTranscript({ segments: [{ id: "first", text, startMs: 0, endMs: 1000, final: true }], draft: "" }); }
    };
}

test("a stream already live at startup joins once and repeated scans keep one ASR session", async context => {
    const { runtime, calls, update, sentences } = fixture(context);
    await runtime.start();
    await Promise.all([runtime.scan(), runtime.scan(), runtime.scan()]);
    assert.equal(runtime.status().phase, "transcribing");
    assert.deepEqual(calls.slice(0, 4), ["prepare", "join", "connect", "capture"]);
    assert.equal(calls.filter(call => call === "join").length, 1);
    update("Confirmed sentence.");
    update("Confirmed sentence.");
    assert.equal(sentences.length, 1);
});

test("ending a stream drains final ASR output, leaves, then returns to monitoring", async context => {
    const { runtime, calls, setStreams, sentences } = fixture(context);
    await runtime.start();
    setStreams([]);
    await runtime.scan();
    assert.equal(runtime.status().phase, "idle");
    assert.equal(sentences.at(-1)?.text, "Final sentence");
    assert.ok(calls.indexOf("stop-capture") < calls.indexOf("finish"));
    assert.ok(calls.includes("leave"));
    setStreams([target]);
    await runtime.scan();
    assert.equal(calls.filter(call => call === "join").length, 2);
});

test("a manual channel move pauses following until explicitly resumed", async context => {
    const { runtime, calls, setChannel } = fixture(context);
    await runtime.start();
    setChannel("another-channel");
    await runtime.scan();
    await runtime.scan();
    assert.equal(runtime.status().phase, "paused");
    assert.equal(calls.filter(call => call === "join").length, 1);
    await runtime.resume();
    assert.equal(runtime.status().phase, "transcribing");
    assert.equal(calls.filter(call => call === "join").length, 2);
});

test("manually closing a still-live stream pauses rather than transcribing unrelated playback", async context => {
    let watching = true;
    const { runtime } = fixture(context, { isWatching: () => watching });
    await runtime.start();
    watching = false;
    await runtime.scan();
    assert.equal(runtime.status().phase, "paused");
});

test("a transport disconnect in the selected channel backs off rather than treating it as a manual pause", async context => {
    let connected = true;
    const { runtime, errors } = fixture(context, { voiceConnected: () => connected, isWatching: () => connected });
    await runtime.start();
    connected = false;
    await runtime.scan();
    assert.equal(runtime.status().phase, "error");
    assert.match(errors[0].message, /voice connection was interrupted/);
});

test("a stream ending during voice connection cancels joining before recording starts", async context => {
    let entered!: () => void;
    const joining = new Promise<void>(resolve => { entered = resolve; });
    const { runtime, calls, setStreams } = fixture(context, {
        async join(_stream, signal) {
            entered();
            await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
            return () => {};
        }
    });
    const starting = runtime.start();
    await joining;
    setStreams([]);
    await runtime.scan();
    await starting;
    assert.ok(!calls.includes("capture"));
    assert.equal(runtime.status().phase, "idle");
});

test("backend failures clean up and back off before attempting another session", async context => {
    let clock = 0;
    let attempts = 0;
    const { runtime, calls, errors } = fixture(context, {
        now: () => clock,
        createTranscriber() {
            return {
                async connect() { attempts++; throw new Error("backend offline"); },
                sendAudio() {}, async finish() {}, abort() {}
            };
        }
    });
    await runtime.start();
    await runtime.scan();
    assert.equal(attempts, 1);
    assert.equal(runtime.status().phase, "error");
    assert.ok(calls.includes("leave"));
    assert.equal(errors.length, 1);
    clock = 31_000;
    await runtime.scan();
    assert.equal(attempts, 2);
});

test("disabling stops capture and aborts ASR without publishing a final sentence", async context => {
    const { runtime, calls, sentences } = fixture(context);
    await runtime.start();
    await runtime.stop();
    assert.equal(runtime.status().phase, "stopped");
    assert.ok(calls.includes("stop-capture"));
    assert.ok(!calls.includes("finish"));
    assert.equal(sentences.length, 0);
});

test("cancellation while the native capture starts still cleans up its eventual session", async context => {
    let release!: () => void;
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const { runtime, calls } = fixture(context, {
        async startCapture() { entered(); await new Promise<void>(resolve => { release = resolve; }); }
    });
    const starting = runtime.start();
    await entering;
    const stopping = runtime.stop();
    release();
    await Promise.all([starting, stopping]);
    assert.ok(calls.includes("stop-capture"));
    assert.ok(calls.includes("leave"));
    assert.equal(runtime.status().phase, "stopped");
});
