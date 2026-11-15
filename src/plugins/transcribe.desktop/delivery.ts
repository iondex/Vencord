import type { Sentence } from "@plugins/transcribe.desktop/types";

export interface SentenceMessage {
    id: string;
    channelId: string;
    content: string;
    nonce: string;
}

export function createSentenceDelivery(options: {
    send(message: SentenceMessage): Promise<void>;
    onError(error: Error): void;
    intervalMs?: number;
    retryMs?: number;
}) {
    const queue: SentenceMessage[] = [];
    const seen = new Set<string>();
    let stopped = false;
    let paused = false;
    let nextSendAt = 0;
    let task: Promise<void> | undefined;
    let wake: (() => void) | undefined;

    async function delay(milliseconds: number) {
        await new Promise<void>(resolve => {
            const timer = setTimeout(done, milliseconds);
            function done() { clearTimeout(timer); wake = undefined; resolve(); }
            wake = done;
        });
    }

    function processQueue() {
        task ??= (async () => {
            while (!stopped && !paused && queue.length) {
                while (!stopped && Date.now() < nextSendAt) await delay(nextSendAt - Date.now());
                if (stopped || paused) break;
                const message = queue[0];
                let delivered = false;
                for (let attempt = 0; attempt < 3 && !stopped; attempt++) {
                    try {
                        await options.send(message);
                        nextSendAt = Date.now() + (options.intervalMs ?? 1500);
                        delivered = true;
                        break;
                    } catch (error) {
                        if (stopped) break;
                        const status = Number((error as { status?: number; })?.status);
                        if ((status >= 400 && status < 500 && status !== 429) || attempt === 2) {
                            options.onError(new Error(`Sentence delivery failed: ${error instanceof Error ? error.message : String(error)}`));
                            break;
                        }
                        await delay(options.retryMs ?? 1500);
                    }
                }
                if (!delivered && !stopped) {
                    paused = true;
                    break;
                }
                queue.shift();
            }
        })().finally(() => { task = undefined; });
    }

    return {
        enqueue(sentence: Sentence, sessionId: string, channelId: string, prefix: string) {
            if (!channelId) return;
            if (stopped) throw new Error("Sentence delivery has been disabled");
            const id = `${sessionId}:${sentence.id}`;
            if (seen.has(id)) return;
            if (queue.length >= 200) throw new Error("Sentence delivery queue is full");
            const content = `${prefix}${sentence.text}`;
            if (content.length > 2000) throw new Error("The transcription message exceeds Discord's 2000-character limit");
            const random = crypto.getRandomValues(new Uint32Array(2));
            const nonce = ((BigInt(random[0]) << 32n) | BigInt(random[1])).toString();
            seen.add(id);
            queue.push({ id, channelId, content, nonce });
            processQueue();
        },
        stop() { stopped = true; queue.length = 0; wake?.(); },
        retry() { if (!stopped) { paused = false; processQueue(); } },
        pending() { return queue.length; },
        async idle() { await task; }
    };
}
