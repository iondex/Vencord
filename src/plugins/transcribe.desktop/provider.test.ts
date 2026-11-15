import assert from "node:assert/strict";
import { test } from "node:test";

import { createWhisperLiveKitSession, normalizeWhisperLiveKit } from "@plugins/transcribe.desktop/providers/whisperLiveKit";
import type { TranscriptUpdate } from "@plugins/transcribe.desktop/types";

class FakeSocket {
    binaryType = "";
    readyState = 1;
    bufferedAmount = 0;
    onmessage?: (event: { data: string; }) => void;
    onerror?: () => void;
    onclose?: () => void;
    sent: Uint8Array[] = [];
    send(data: Uint8Array) { this.sent.push(data); }
    close() { this.readyState = 3; this.onclose?.(); }
    message(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

function fixture() {
    const socket = new FakeSocket();
    const errors: Error[] = [];
    const transcripts: TranscriptUpdate[] = [];
    let url = "";
    const session = createWhisperLiveKitSession({
        url: "ws://localhost:18000/asr?existing=1", language: "en",
        onTranscript: update => transcripts.push(update), onError: error => errors.push(error)
    }, address => { url = address; return socket as unknown as WebSocket; });
    return { socket, session, errors, transcripts, url: () => new URL(url) };
}

test("normalization publishes committed lines and treats VAC silence as an utterance boundary", () => {
    const result = normalizeWhisperLiveKit({
        lines: [
            { speaker: 1, text: " Hello world", start: "0:00:00.20", end: "0:00:01.40" },
            { speaker: -2, text: "", start: "0:00:01.50", end: "0:00:02.40" },
            { speaker: 1, text: " Next", start: "0:00:02.40", end: "0:00:03.00" }
        ], buffer_transcription: "unconfirmed words"
    });
    assert.deepEqual(result.segments.map(segment => [segment.text, segment.final]), [["Hello world", true], ["Next", false]]);
    assert.equal(result.segments[0].startMs, 200);
    assert.equal(result.draft, "unconfirmed words");
});

test("PCM handshake, audio frames and graceful final draining follow the deployed protocol", async () => {
    const { session, socket, errors, transcripts, url } = fixture();
    const connected = session.connect();
    socket.message({ type: "config", useAudioWorklet: true });
    await connected;
    assert.equal(url().searchParams.get("language"), "en");
    assert.equal(url().searchParams.get("existing"), "1");
    session.sendAudio(new Uint8Array(6400));
    const finished = session.finish();
    socket.message({ lines: [{ speaker: 1, text: " Final words.", start: "0:00:00.00", end: "0:00:01.00" }] });
    socket.message({ type: "ready_to_stop" });
    await finished;
    assert.deepEqual(socket.sent.map(frame => frame.byteLength), [6400, 0]);
    assert.equal(transcripts[0].segments[0].text, "Final words.");
    assert.equal(errors.length, 0);
});

test("wrong server mode and early disconnection fail the session", async () => {
    const first = fixture();
    const opening = first.session.connect();
    first.socket.message({ type: "config", useAudioWorklet: false });
    await assert.rejects(opening, /--pcm-input/);
    assert.equal(first.errors.length, 1);
    const second = fixture();
    const connected = second.session.connect();
    second.socket.message({ type: "config", useAudioWorklet: true });
    await connected;
    const finished = second.session.finish();
    second.socket.close();
    await assert.rejects(finished, /before the final transcript/);
});

test("aborting a pending handshake releases it without reporting a transport failure", async () => {
    const { session, errors } = fixture();
    const opening = session.connect();
    session.abort();
    await assert.rejects(opening, /cancelled/);
    assert.equal(errors.length, 0);
});

test("backpressure and incomplete PCM samples cannot create unbounded audio queues", async () => {
    const { session, socket } = fixture();
    const connected = session.connect();
    socket.message({ type: "config", useAudioWorklet: true });
    await connected;
    assert.throws(() => session.sendAudio(new Uint8Array(3)), /complete PCM16/);
    socket.bufferedAmount = 200_000;
    assert.throws(() => session.sendAudio(new Uint8Array(6400)), /too slow/);
    session.abort();
});
