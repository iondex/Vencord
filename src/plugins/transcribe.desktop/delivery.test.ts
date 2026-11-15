import assert from "node:assert/strict";
import { test } from "node:test";

import { createSentenceDelivery, type SentenceMessage } from "@plugins/transcribe.desktop/delivery";

const sentence = { id: "line:0", text: "A sentence.", startMs: 0, endMs: 1000 };

test("optional output disables delivery and repeated snapshots do not enqueue duplicate messages", async () => {
    const sent: SentenceMessage[] = [];
    const delivery = createSentenceDelivery({ send: async message => { sent.push(message); }, onError: assert.fail, intervalMs: 0 });
    delivery.enqueue(sentence, "session", "", "");
    delivery.enqueue(sentence, "session", "channel", "Source: ");
    delivery.enqueue(sentence, "session", "channel", "Source: ");
    delivery.enqueue(sentence, "next-session", "channel", "");
    await delivery.idle();
    assert.equal(sent.length, 2);
    assert.equal(sent[0].content, "Source: A sentence.");
});

test("transient retries keep the same Discord nonce", async () => {
    const nonces: string[] = [];
    const delivery = createSentenceDelivery({
        async send(message) {
            nonces.push(message.nonce);
            if (nonces.length === 1) throw new Error("Connection lost after sending");
        }, onError: assert.fail, retryMs: 0
    });
    delivery.enqueue(sentence, "session", "channel", "");
    await delivery.idle();
    assert.equal(nonces.length, 2);
    assert.equal(new Set(nonces).size, 1);
});

test("permission errors stop the queue without sending later sentences", async () => {
    let attempts = 0;
    const errors: Error[] = [];
    const delivery = createSentenceDelivery({
        async send() { attempts++; throw Object.assign(new Error("Forbidden"), { status: 403 }); },
        onError: error => errors.push(error), intervalMs: 0, retryMs: 0
    });
    delivery.enqueue(sentence, "session", "channel", "");
    delivery.enqueue({ ...sentence, id: "next" }, "session", "channel", "");
    await delivery.idle();
    assert.equal(attempts, 1);
    assert.equal(errors.length, 1);
    assert.equal(delivery.pending(), 2);
    delivery.stop();
});

test("disabling the plugin cancels queued writes", async () => {
    const sent: string[] = [];
    let release!: () => void;
    const delivery = createSentenceDelivery({
        async send(message) { sent.push(message.id); await new Promise<void>(resolve => { release = resolve; }); },
        onError: assert.fail, intervalMs: 0
    });
    delivery.enqueue(sentence, "session", "channel", "");
    delivery.enqueue({ ...sentence, id: "next" }, "session", "channel", "");
    delivery.stop();
    release();
    await delivery.idle();
    assert.equal(sent.length, 1);
});

test("an in-flight failure after disabling does not pause or notify a later plugin instance", async () => {
    let rejectSend!: (error: Error) => void;
    const errors: Error[] = [];
    const delivery = createSentenceDelivery({
        send: () => new Promise<void>((_resolve, reject) => { rejectSend = reject; }),
        onError: error => errors.push(error)
    });
    delivery.enqueue(sentence, "session", "channel", "");
    delivery.stop();
    rejectSend(new Error("Disconnected"));
    await delivery.idle();
    assert.equal(errors.length, 0);
});

test("message spacing also applies when a sentence arrives after the queue became empty", async () => {
    const times: number[] = [];
    const delivery = createSentenceDelivery({
        async send() { times.push(Date.now()); }, onError: assert.fail, intervalMs: 25
    });
    delivery.enqueue(sentence, "session", "channel", "");
    await delivery.idle();
    delivery.enqueue({ ...sentence, id: "later" }, "session", "channel", "");
    await delivery.idle();
    assert.ok(times[1] - times[0] >= 25);
});
