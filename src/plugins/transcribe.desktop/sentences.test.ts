import assert from "node:assert/strict";
import { test } from "node:test";

import { createSentenceAssembler } from "@plugins/transcribe.desktop/sentences";
import type { Sentence, TranscriptSegment } from "@plugins/transcribe.desktop/types";

function segment(text: string, final = false, id = "1"): TranscriptSegment {
    return { id, text, startMs: 0, endMs: 1000, final };
}

test("full transcript snapshots emit each English sentence once as the line grows", () => {
    const output: Sentence[] = [];
    const assembler = createSentenceAssembler(sentence => output.push(sentence));
    assembler.update([segment("Hello")]);
    assembler.update([segment("Hello world.")]);
    assert.equal(output.length, 0);
    assembler.update([segment("Hello world. How are")]);
    assembler.update([segment("Hello world. How are you?", true)]);
    assembler.update([segment("Hello world. How are you?", true)]);
    assembler.flush();
    assert.deepEqual(output.map(sentence => sentence.text), ["Hello world.", "How are you?"]);
});

test("Chinese punctuation and a pause without punctuation both finish sentences", () => {
    const output: string[] = [];
    const assembler = createSentenceAssembler(sentence => output.push(sentence.text));
    assembler.update([segment("你好。今天怎么样？", true)]);
    assembler.update([segment("A pause without punctuation", true, "2")]);
    assert.deepEqual(output, ["你好。", "今天怎么样？", "A pause without punctuation"]);
});

test("identical phrases in different utterances are not lost to text deduplication", () => {
    const output: Sentence[] = [];
    const assembler = createSentenceAssembler(sentence => output.push(sentence));
    assembler.update([segment("Yes.", true), segment("Yes.", true, "2")]);
    assert.equal(output.length, 2);
    assert.notEqual(output[0].id, output[1].id);
});

test("unpublished revisions and English abbreviations do not publish prematurely", () => {
    const output: string[] = [];
    const assembler = createSentenceAssembler(sentence => output.push(sentence.text));
    assembler.update([segment("Dr.")]);
    assembler.update([segment("Dr. Smith is here")]);
    assembler.update([segment("Dr. Smith was here.", true)]);
    assert.deepEqual(output, ["Dr. Smith was here."]);
});

test("oversize sentences split without breaking UTF-16 surrogate pairs", () => {
    const output: string[] = [];
    const assembler = createSentenceAssembler(sentence => output.push(sentence.text), 7);
    const text = "abcdef🙂中文🙂结束";
    assembler.update([segment(text, true)]);
    assert.equal(output.join(""), text);
    assert.ok(output.every(part => part.length <= 7 && !/[\uD800-\uDBFF]$/.test(part)));
});

test("provider revisions to already published text fail instead of reposting it", () => {
    const assembler = createSentenceAssembler(() => {});
    assembler.update([segment("First. Next")]);
    assert.throws(() => assembler.update([segment("Changed. Next sentence", true)]), /already published/);
});
