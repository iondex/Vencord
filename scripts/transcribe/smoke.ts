import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { createWhisperLiveKitSession } from "@plugins/transcribe.desktop/providers/whisperLiveKit";
import { createSentenceAssembler } from "@plugins/transcribe.desktop/sentences";

async function main() {
    const [filename, url = "ws://127.0.0.1:18000/asr", language = "en"] = process.argv.slice(2);
    if (!filename) throw new Error("Usage: pnpm exec tsx scripts/transcribe/smoke.ts <16kHz-mono-PCM16.wav> [ws-url] [language]");
    const wav = await readFile(filename);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    let pcm: Buffer | undefined;
    let formatChecked = false;
    for (let offset = 12; offset + 8 <= wav.length;) {
        const chunk = wav.toString("ascii", offset, offset + 4);
        const length = wav.readUInt32LE(offset + 4);
        if (offset + 8 + length > wav.length) throw new Error("Truncated WAV file");
        if (chunk === "fmt ") {
            assert.equal(wav.readUInt16LE(offset + 8), 1, "WAV must use integer PCM");
            assert.equal(wav.readUInt16LE(offset + 10), 1, "WAV must be mono");
            assert.equal(wav.readUInt32LE(offset + 12), 16_000, "WAV must use 16kHz audio");
            assert.equal(wav.readUInt16LE(offset + 22), 16, "WAV must use 16-bit samples");
            formatChecked = true;
        } else if (chunk === "data") pcm = wav.subarray(offset + 8, offset + 8 + length);
        offset += 8 + length + length % 2;
    }
    assert.ok(pcm?.length && formatChecked, "WAV must contain format and audio data");
    const sentences: string[] = [];
    const assembler = createSentenceAssembler(sentence => { sentences.push(sentence.text); console.log(sentence.text); });
    const session = createWhisperLiveKitSession({
        url, language,
        onTranscript: update => assembler.update(update.segments),
        onError: error => console.error(error.message)
    });
    const started = Date.now();
    try {
        await session.connect();
        for (let offset = 0; offset < pcm.length; offset += 6400) {
            session.sendAudio(pcm.subarray(offset, Math.min(offset + 6400, pcm.length)));
            await delay(200);
        }
        session.sendAudio(new Uint8Array(32_000));
        await delay(1000);
        await session.finish();
        assembler.flush();
        assert.ok(sentences.length, "The ASR server did not produce any confirmed sentences");
        console.log(JSON.stringify({ sentences: sentences.length, elapsedSeconds: (Date.now() - started) / 1000 }));
    } finally { session.abort(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
