import assert from "node:assert/strict";
import { test } from "node:test";

import { createSentenceDelivery } from "@plugins/transcribe.desktop/delivery";

test("retrying after a permission repair keeps queued sentences and their original nonces", async () => {
    let allowed = false;
    const attempts: string[] = [];
    const sent: string[] = [];
    const delivery = createSentenceDelivery({
        async send(message) {
            attempts.push(message.nonce);
            if (!allowed) throw Object.assign(new Error("Forbidden"), { status: 403 });
            sent.push(message.content);
        }, onError() {}, intervalMs: 0
    });
    delivery.enqueue({ id: "first", text: "First.", startMs: 0, endMs: 1 }, "session", "channel", "");
    await delivery.idle();
    delivery.enqueue({ id: "second", text: "Second.", startMs: 1, endMs: 2 }, "session", "channel", "");
    await delivery.idle();
    assert.equal(attempts.length, 1);
    allowed = true;
    delivery.retry();
    await delivery.idle();
    assert.deepEqual(sent, ["First.", "Second."]);
    assert.equal(attempts[0], attempts[1]);
});
