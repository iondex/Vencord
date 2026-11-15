import { selectStream } from "@plugins/transcribe.desktop/selection";
import { createSentenceAssembler } from "@plugins/transcribe.desktop/sentences";
import type { CaptureRead, RuntimeStatus, Sentence, StreamTarget, TranscriptionOptions, TranscriptionSession } from "@plugins/transcribe.desktop/types";

export interface RuntimeDependencies {
    channelIds: string[];
    listStreams(): StreamTarget[];
    currentChannelId(): string | undefined;
    isWatching?(target: StreamTarget): boolean;
    voiceConnected?(): boolean;
    prepare(): Promise<void>;
    join(target: StreamTarget, signal: AbortSignal): Promise<() => void>;
    createTranscriber(callbacks: Pick<TranscriptionOptions, "onTranscript" | "onError">): TranscriptionSession;
    startCapture(id: string): Promise<unknown>;
    readCapture(id: string): Promise<CaptureRead>;
    stopCapture(id: string): Promise<CaptureRead>;
    onSentence(sentence: Sentence, target: StreamTarget, sessionId: string): void;
    onError(error: Error): void;
    now?: () => number;
    pollMs?: number;
    retryMs?: number;
}

export function createTranscribeRuntime(dependencies: RuntimeDependencies) {
    const now = dependencies.now ?? Date.now;
    let running = false;
    let paused = false;
    let retryAt = 0;
    let task: Promise<void> | undefined;
    let requested = false;
    let active: {
        id: string;
        target: StreamTarget;
        abort: AbortController;
        assembler: ReturnType<typeof createSentenceAssembler>;
        transcriber?: TranscriptionSession;
        cleanup?: () => void;
        pump?: Promise<void>;
        ready: boolean;
        accepting: boolean;
        error?: Error;
    } | undefined;
    const status: RuntimeStatus = { phase: "stopped", detail: "Stopped", draft: "", sentences: 0, recent: [] };

    function report(error: unknown) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        status.phase = "error";
        status.detail = normalized.message;
        dependencies.onError(normalized);
    }

    function interrupted() {
        return !running || paused || (active?.ready && dependencies.currentChannelId() !== active.target.channelId);
    }

    async function closeSession(graceful: boolean) {
        const session = active;
        if (!session) return;
        status.phase = "finishing";
        status.detail = "Finishing the current transcript";
        session.abort.abort();
        try {
            await session.pump;
            const tail = await dependencies.stopCapture(session.id);
            if (graceful && session.ready && !session.error && session.transcriber) {
                if (tail.pcm.byteLength) session.transcriber.sendAudio(tail.pcm);
                await session.transcriber.finish();
            }
        } catch (error) {
            if (running && !session.error) report(error);
        } finally {
            try { if (running) session.assembler.flush(); } catch (error) { report(error); }
            session.accepting = false;
            session.transcriber?.abort();
            try { session.cleanup?.(); } catch (error) { report(error); }
            if (active === session) active = undefined;
            status.target = undefined;
            status.draft = "";
        }
    }

    async function openSession(target: StreamTarget) {
        const id = crypto.randomUUID();
        const session = active = {
            id, target, abort: new AbortController(), ready: false, accepting: true,
            assembler: createSentenceAssembler(sentence => {
                if (!running || !session.accepting) return;
                status.sentences++;
                status.recent = [...status.recent.slice(-9), sentence.text];
                dependencies.onSentence(sentence, target, id);
            })
        } as NonNullable<typeof active>;
        const { signal } = session.abort;
        signal.addEventListener("abort", () => { if (!session.ready) session.transcriber?.abort(); }, { once: true });
        function checkCancelled() {
            if (signal.aborted || !running || paused) throw new Error("Session cancelled");
        }
        status.phase = "joining";
        status.detail = "Preparing audio capture and joining the live stream";
        status.target = target;
        try {
            await dependencies.prepare();
            checkCancelled();
            session.cleanup = await dependencies.join(target, signal);
            checkCancelled();
            session.transcriber = dependencies.createTranscriber({
                onTranscript(update) {
                    if (!session.accepting) return;
                    session.assembler.update(update.segments);
                    status.draft = [session.assembler.pending(), update.draft].filter(Boolean).join(" ");
                },
                onError(error) {
                    if (!session.accepting || signal.aborted) return;
                    session.error = error;
                    session.abort.abort();
                    scan();
                }
            });
            await session.transcriber.connect();
            checkCancelled();
            await dependencies.startCapture(id);
            checkCancelled();
            session.ready = true;
            status.phase = "transcribing";
            status.detail = "Listening to Discord audio";
            session.pump = (async () => {
                while (!signal.aborted) {
                    const { pcm, error } = await dependencies.readCapture(id);
                    if (signal.aborted) break;
                    if (error) throw new Error(error);
                    if (pcm.byteLength) session.transcriber!.sendAudio(pcm);
                    await new Promise<void>(resolve => {
                        const timer = setTimeout(done, dependencies.pollMs ?? 150);
                        function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
                        signal.addEventListener("abort", done, { once: true });
                        if (signal.aborted) done();
                    });
                }
            })().catch(error => {
                if (!signal.aborted) {
                    session.error = error instanceof Error ? error : new Error(String(error));
                    session.abort.abort();
                    scan();
                }
            });
        } catch (error) {
            if (!signal.aborted) session.error = error instanceof Error ? error : new Error(String(error));
            const failure = session.error;
            await closeSession(false);
            if (failure) {
                retryAt = now() + (dependencies.retryMs ?? 30_000);
                report(failure);
            }
        }
    }

    async function reconcile() {
        const streams = running && !paused ? dependencies.listStreams() : [];
        if (active?.ready && running && !paused && streams.some(stream => stream.key === active!.target.key)) {
            if (dependencies.currentChannelId() !== active.target.channelId) paused = true;
            else if (dependencies.voiceConnected?.() === false) {
                active.error ??= new Error("Discord's voice connection was interrupted");
                active.abort.abort();
            } else if (dependencies.isWatching?.(active.target) === false) paused = true;
        }
        const target = paused ? undefined : selectStream(streams, dependencies.channelIds, active?.target);
        if (active && (interrupted() || active.error || target?.key !== active.target.key || active.abort.signal.aborted)) {
            const failure = active.error;
            await closeSession(running && !failure);
            if (failure) {
                retryAt = now() + (dependencies.retryMs ?? 30_000);
                report(failure);
            }
        }
        if (!running) {
            status.phase = "stopped";
            status.detail = "Stopped";
        } else if (paused) {
            status.phase = "paused";
            status.detail = "Paused; resume to follow live streams again";
        } else if (!active && now() >= retryAt) {
            if (target) await openSession(target);
            else {
                status.phase = "idle";
                status.detail = dependencies.channelIds.length ? "Waiting for a live stream in the configured channels" : "Configure at least one voice channel ID";
            }
        }
    }

    function scan(): Promise<void> {
        try {
            if (active && (interrupted() || (running && !dependencies.listStreams().some(stream => stream.key === active!.target.key)))) active.abort.abort();
        } catch (error) {
            if (active) { active.error = error instanceof Error ? error : new Error(String(error)); active.abort.abort(); }
            else report(error);
        }
        requested = true;
        if (!task) {
            task = (async () => {
                while (requested) {
                    requested = false;
                    try { await reconcile(); } catch (error) { report(error); retryAt = now() + (dependencies.retryMs ?? 30_000); }
                }
            })().finally(() => { task = undefined; });
        }
        return task;
    }

    return {
        start() { running = true; paused = false; return scan(); },
        scan,
        pause() { paused = true; return scan(); },
        resume() { paused = false; retryAt = 0; return scan(); },
        stop() { running = false; active?.abort.abort(); return scan(); },
        status(): RuntimeStatus { return { ...status, recent: [...status.recent] }; }
    };
}
