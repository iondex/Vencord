/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import { parseLoggerArgs } from "./cli";

assert.deepEqual(parseLoggerArgs(["--dir", "/tmp/discord-log"]), {
    directory: "/tmp/discord-log",
    port: 49322,
});
assert.deepEqual(parseLoggerArgs(["--", "--dir", "/tmp/discord-log"]), {
    directory: "/tmp/discord-log",
    port: 49322,
});
assert.deepEqual(parseLoggerArgs(["--port", "50000", "--dir=/tmp/discord-log"]), {
    directory: "/tmp/discord-log",
    port: 50000,
});
assert.throws(() => parseLoggerArgs([]), /--dir is required/);
assert.throws(() => parseLoggerArgs(["--dir", "/tmp/log", "--port", "0"]), /valid TCP port/);
assert.throws(() => parseLoggerArgs(["--dir", "/tmp/log", "--unknown"]), /Unknown argument/);
