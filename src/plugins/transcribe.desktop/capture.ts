import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import type { CaptureOptions, CaptureRead } from "@plugins/transcribe.desktop/types";

const run = promisify(execFile);

export function descendantPids(root: number, processList: string): Set<number> {
    const processes = processList.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
    const result = new Set([root]);
    let previous = -1;
    while (previous !== result.size) {
        previous = result.size;
        for (const [pid, parent] of processes) if (Number.isInteger(pid) && result.has(parent)) result.add(pid);
    }
    return result;
}

export function capturePaths(executable: string) {
    const expanded = executable.startsWith("~/") ? join(homedir(), executable.slice(2)) : executable;
    const binary = expanded || join(homedir(), ".local/share/vencord-transcribe/audiotee");
    if (!isAbsolute(binary)) throw new Error("The capture executable must be an absolute path");
    return { binary, resolver: join(dirname(binary), "transcribe-audio-processes") };
}

export async function checkCapture(options: CaptureOptions) {
    if (process.platform !== "darwin") throw new Error("The current capture adapter requires macOS");
    const paths = capturePaths(options.executable);
    await Promise.all([access(paths.binary, constants.X_OK), access(paths.resolver, constants.X_OK)]).catch(() => {
        throw new Error("Capture tools are missing. Run: bash scripts/transcribe/setup-capture.sh");
    });
    return paths;
}

async function findAudioPids(resolver: string) {
    const [processes, audio] = await Promise.all([
        run("/bin/ps", ["-axo", "pid=,ppid="], { timeout: 5000, maxBuffer: 1024 * 1024 }),
        run(resolver, [], { timeout: 5000, maxBuffer: 1024 * 1024 })
    ]);
    const descendants = descendantPids(process.pid, processes.stdout);
    const objects: Array<{ pid: number; }> = JSON.parse(audio.stdout);
    return [...new Set(objects.map(object => object.pid).filter(pid => descendants.has(pid)))];
}

interface CaptureState {
    id: string;
    chunks: Buffer[];
    bytes: number;
    error?: string;
    stderr: string;
    child?: ChildProcessWithoutNullStreams;
    stopping: boolean;
    closed?: Promise<void>;
    stoppingPromise?: Promise<CaptureRead>;
}

export function createCaptureManager(dependencies = { findAudioPids, spawn }) {
    let current: CaptureState | undefined;

    function drain(state: CaptureState): CaptureRead {
        const data = Buffer.concat(state.chunks, state.bytes);
        const length = data.length - data.length % 2;
        const remainder = data.subarray(length);
        state.chunks = remainder.length ? [remainder] : [];
        state.bytes = remainder.length;
        return { pcm: Uint8Array.from(data.subarray(0, length)), error: state.error };
    }

    async function stop(id: string): Promise<CaptureRead> {
        if (!current || current.id !== id) return { pcm: new Uint8Array() };
        const state = current;
        if (state.stoppingPromise) return state.stoppingPromise;
        state.stopping = true;
        state.stoppingPromise = (async () => {
            if (state.child && state.closed) {
                state.child.kill("SIGINT");
                let timer: ReturnType<typeof setTimeout> | undefined;
                await Promise.race([
                    state.closed,
                    new Promise<void>(resolve => {
                        timer = setTimeout(() => { state.child?.kill("SIGKILL"); resolve(); }, 1500);
                    })
                ]);
                clearTimeout(timer);
            }
            const result = drain(state);
            if (current === state) current = undefined;
            return result;
        })();
        return state.stoppingPromise;
    }

    return {
        async start(id: string, binary: string, resolver: string) {
            if (!/^[\w-]{1,100}$/.test(id)) throw new Error("Invalid capture session ID");
            if (current) await stop(current.id);
            const state: CaptureState = { id, chunks: [], bytes: 0, stderr: "", stopping: false };
            current = state;
            const pids = await dependencies.findAudioPids(resolver);
            if (current !== state || state.stopping) throw new Error("Capture was cancelled");
            if (!pids.length) throw new Error("Discord has no audio process yet; waiting for the live stream to produce audio");
            const child = state.child = dependencies.spawn(binary, ["--include-processes", ...pids.map(String), "--sample-rate", "16000", "--chunk-duration", "0.2"], { stdio: ["pipe", "pipe", "pipe"] });
            state.closed = new Promise<void>(resolve => {
                child.once("close", (code, signal) => {
                    if (!state.stopping) state.error ??= `Audio capture exited (${code ?? signal}): ${state.stderr.slice(-1200)}`;
                    resolve();
                });
                child.once("error", error => { state.error = error.message; resolve(); });
            });
            child.stdout.on("data", (chunk: Buffer) => {
                if (state.error) return;
                state.chunks.push(chunk);
                state.bytes += chunk.byteLength;
                if (state.bytes > 160_000) {
                    state.error = "Audio capture backlog exceeded five seconds";
                    child.kill("SIGINT");
                    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
                    timer.unref();
                    void state.closed?.finally(() => clearTimeout(timer));
                }
            });
            child.stderr.on("data", (chunk: Buffer) => { state.stderr = (state.stderr + chunk.toString()).slice(-4000); });
            return id;
        },
        read(id: string): CaptureRead {
            if (!current || current.id !== id) throw new Error("Audio capture session is no longer active");
            return drain(current);
        },
        stop
    };
}
