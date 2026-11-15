import assert from "node:assert/strict";
import { test } from "node:test";

import { parseChannelIds, selectStream } from "@plugins/transcribe.desktop/selection";
import type { StreamTarget } from "@plugins/transcribe.desktop/types";

import { includePlugin } from "../../../scripts/build/pluginProfile.mjs";

const first: StreamTarget = { key: "a", channelId: "1", guildId: "guild", ownerId: "alice", streamType: "guild" };
const second: StreamTarget = { ...first, key: "b", channelId: "2", ownerId: "bob" };

test("configured channel order selects a target while an active stream stays selected", () => {
    assert.deepEqual(parseChannelIds("1, 2\n1；3"), ["1", "2", "3"]);
    assert.equal(selectStream([first, second], ["2", "1"]), second);
    assert.equal(selectStream([first, second], ["2", "1"], first), first);
    assert.equal(selectStream([first], ["2"]), undefined);
});

test("the restricted build profile includes transcribe and preserves the existing plugin allowlist", () => {
    assert.equal(includePlugin("plugins", "transcribe.desktop"), true);
    assert.equal(includePlugin("src/plugins", "transcribe.desktop"), true);
    assert.equal(includePlugin("userplugins", "transcribe.desktop"), false);
    assert.equal(includePlugin("src/userplugins", "transcribe.desktop"), false);
    assert.equal(includePlugin("plugins", "forwarder.desktop"), true);
    assert.equal(includePlugin("plugins", "channel-logger.desktop"), true);
    assert.equal(includePlugin("userplugins", "unrelated.desktop"), false);
    assert.equal(includePlugin("plugins", "unrelated"), false);
});
