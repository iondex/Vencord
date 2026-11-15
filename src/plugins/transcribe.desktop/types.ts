export interface StreamTarget {
    key: string;
    guildId: string;
    channelId: string;
    ownerId: string;
    streamType: "guild";
}

export interface TranscriptSegment {
    id: string;
    text: string;
    startMs: number;
    endMs: number;
    final: boolean;
}

export interface TranscriptUpdate {
    segments: TranscriptSegment[];
    draft: string;
}

export interface TranscriptionOptions {
    url: string;
    language: string;
    onTranscript(update: TranscriptUpdate): void;
    onError(error: Error): void;
}

export interface TranscriptionSession {
    connect(): Promise<void>;
    sendAudio(pcm: Uint8Array): void;
    finish(): Promise<void>;
    abort(): void;
}

export interface TranscriptionProvider {
    id: string;
    audioFormat: { sampleRate: number; channels: number; encoding: "pcm_s16le"; };
    createSession(options: TranscriptionOptions): TranscriptionSession;
}

export interface Sentence {
    id: string;
    text: string;
    startMs: number;
    endMs: number;
}

export interface CaptureOptions {
    executable: string;
}

export interface CaptureRead {
    pcm: Uint8Array;
    error?: string;
}

export interface RuntimeStatus {
    phase: "stopped" | "idle" | "joining" | "transcribing" | "finishing" | "paused" | "error";
    detail: string;
    target?: StreamTarget;
    draft: string;
    sentences: number;
    recent: string[];
}
