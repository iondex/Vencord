import type { TranscriptionOptions, TranscriptionProvider, TranscriptionSession, TranscriptSegment, TranscriptUpdate } from "@plugins/transcribe.desktop/types";

type SocketFactory = (url: string) => WebSocket;

function milliseconds(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
    if (typeof value !== "string" || !/^\d+:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) throw new Error("Invalid WhisperLiveKit timestamp");
    const [hours, minutes, seconds] = value.split(":").map(Number);
    return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

export function normalizeWhisperLiveKit(message: Record<string, any>): TranscriptUpdate {
    if (!Array.isArray(message.lines)) throw new Error("WhisperLiveKit did not return transcript lines");
    const segments: TranscriptSegment[] = [];
    for (let index = 0; index < message.lines.length; index++) {
        const line = message.lines[index];
        if (!line || line.speaker === -2 || typeof line.text !== "string" || !line.text.trim()) continue;
        const startMs = milliseconds(line.start);
        const endMs = milliseconds(line.end);
        if (endMs < startMs) throw new Error("WhisperLiveKit returned an invalid segment range");
        segments.push({
            id: `${startMs}:${line.speaker ?? "unknown"}`,
            text: line.text.trim().replace(/\s+/g, " "),
            startMs,
            endMs,
            final: index < message.lines.length - 1
        });
    }
    return { segments, draft: typeof message.buffer_transcription === "string" ? message.buffer_transcription.trim() : "" };
}

export function createWhisperLiveKitSession(options: TranscriptionOptions, socketFactory: SocketFactory = url => new WebSocket(url)): TranscriptionSession {
    const endpoint = new URL(options.url);
    if (!["ws:", "wss:"].includes(endpoint.protocol)) throw new Error("The transcription URL must use ws:// or wss://");
    endpoint.searchParams.set("language", options.language || "auto");
    let socket: WebSocket | undefined;
    let connected = false;
    let ended = false;
    let finishing = false;
    let opening: Promise<void> | undefined;
    let finishingPromise: Promise<void> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectConnect: ((error: Error) => void) | undefined;
    let resolveFinish: (() => void) | undefined;
    let rejectFinish: ((error: Error) => void) | undefined;

    function clearTimers() {
        clearTimeout(connectTimer);
        clearTimeout(finishTimer);
    }

    function fail(error: Error) {
        if (ended) return;
        ended = true;
        clearTimers();
        rejectConnect?.(error);
        rejectFinish?.(error);
        socket?.close();
        options.onError(error);
    }

    return {
        connect() {
            if (opening) return opening;
            opening = new Promise<void>((resolve, reject) => {
                rejectConnect = reject;
                if (ended) return reject(new Error("Transcription session has ended"));
                connectTimer = setTimeout(() => fail(new Error("WhisperLiveKit connection timed out")), 15_000);
                try {
                    socket = socketFactory(endpoint.toString());
                    socket.binaryType = "arraybuffer";
                    socket.onmessage = event => {
                        try {
                            if (typeof event.data !== "string") throw new Error("Unexpected binary response from WhisperLiveKit");
                            const message = JSON.parse(event.data);
                            if (message.type === "config") {
                                if (!message.useAudioWorklet) throw new Error("WhisperLiveKit must run with --pcm-input");
                                connected = true;
                                clearTimeout(connectTimer);
                                resolve();
                            } else if (message.type === "ready_to_stop") {
                                if (!finishing) throw new Error("WhisperLiveKit ended the session unexpectedly");
                                ended = true;
                                clearTimers();
                                resolveFinish?.();
                                socket?.close();
                            } else if (message.error || message.type === "error") {
                                throw new Error(String(message.error ?? message.message ?? "WhisperLiveKit error"));
                            } else if (Array.isArray(message.lines)) {
                                options.onTranscript(normalizeWhisperLiveKit(message));
                            }
                        } catch (error) {
                            fail(error instanceof Error ? error : new Error(String(error)));
                        }
                    };
                    socket.onerror = () => fail(new Error("WhisperLiveKit WebSocket failed; check the server and SSH tunnel"));
                    socket.onclose = () => {
                        if (!ended) fail(new Error("WhisperLiveKit closed before the final transcript was received"));
                    };
                } catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                }
            });
            return opening;
        },
        sendAudio(pcm) {
            if (!connected || ended || finishing || socket?.readyState !== 1) throw new Error("Transcription session is not accepting audio");
            if (!pcm.byteLength || pcm.byteLength % 2) throw new Error("Audio must contain complete PCM16 samples");
            if (socket.bufferedAmount > 160_000) throw new Error("Transcription connection is too slow; audio backlog exceeded five seconds");
            socket.send(pcm as Uint8Array<ArrayBuffer>);
        },
        finish() {
            if (finishingPromise) return finishingPromise;
            if (ended) return Promise.reject(new Error("Transcription session has already ended"));
            finishingPromise = new Promise<void>((resolve, reject) => {
                resolveFinish = resolve;
                rejectFinish = reject;
                finishing = true;
                if (!connected || socket?.readyState !== 1) return fail(new Error("Cannot finish a disconnected transcription session"));
                finishTimer = setTimeout(() => fail(new Error("Timed out waiting for the final transcript")), 30_000);
                socket.send(new Uint8Array(0));
            });
            return finishingPromise;
        },
        abort() {
            if (ended) return;
            ended = true;
            clearTimers();
            const error = new Error("Transcription session was cancelled");
            rejectConnect?.(error);
            rejectFinish?.(error);
            socket?.close();
        }
    };
}

export const whisperLiveKit: TranscriptionProvider = {
    id: "whisperlivekit",
    audioFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" },
    createSession: createWhisperLiveKitSession
};
