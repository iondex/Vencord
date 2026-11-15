import type { Sentence, TranscriptSegment } from "@plugins/transcribe.desktop/types";

interface SegmentState {
    segment: TranscriptSegment;
    consumed: number;
}

export function createSentenceAssembler(onSentence: (sentence: Sentence) => void, maxLength = 1700) {
    const states = new Map<string, SegmentState>();
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });

    function emit(state: SegmentState, length: number) {
        const { segment, consumed } = state;
        const text = segment.text.slice(consumed, consumed + length).trim();
        state.consumed += length;
        if (text) onSentence({ id: `${segment.id}:${consumed}`, text, startMs: segment.startMs, endMs: segment.endMs });
    }

    function drain(state: SegmentState, final: boolean) {
        while (state.consumed < state.segment.text.length) {
            const remaining = state.segment.text.slice(state.consumed);
            const pieces: string[] = [];
            for (const piece of segmenter.segment(remaining)) {
                const previous = pieces.at(-1);
                if (previous && /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs)|\b[A-Z]|\b(?:[A-Za-z]\.)+[A-Za-z])\.\s*$/u.test(previous)) pieces[pieces.length - 1] += piece.segment;
                else pieces.push(piece.segment);
            }
            const first = pieces[0] ?? remaining;
            const complete = pieces.length > 1;
            if (first.length <= maxLength && (complete || final)) {
                emit(state, first.length);
            } else if (remaining.length > maxLength) {
                const prefix = remaining.slice(0, maxLength);
                const boundary = prefix.lastIndexOf(" ");
                const length = boundary > maxLength / 2 ? boundary + 1 : maxLength - (/[\uD800-\uDBFF]$/.test(prefix) ? 1 : 0);
                emit(state, length);
            } else {
                break;
            }
        }
    }

    return {
        update(segments: TranscriptSegment[]) {
            for (const segment of segments) {
                let state = states.get(segment.id);
                if (!state) {
                    state = { segment, consumed: 0 };
                    states.set(segment.id, state);
                } else {
                    if (segment.text.slice(0, state.consumed) !== state.segment.text.slice(0, state.consumed)) {
                        if (segment.text.length <= state.consumed) continue;
                        throw new Error("The ASR provider revised text that was already published");
                    }
                    state.segment = segment;
                }
                drain(state, segment.final);
            }
        },
        flush() {
            for (const state of states.values()) drain(state, true);
        },
        pending() {
            return [...states.values()].map(state => state.segment.text.slice(state.consumed).trim()).filter(Boolean).join(" ");
        }
    };
}
