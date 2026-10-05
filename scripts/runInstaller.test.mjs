/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2026 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import assert from "node:assert/strict";

import { getFilename } from "./runInstaller.mjs";

assert.equal(getFilename("darwin"), "VencordInstallerCli-darwin");
assert.equal(getFilename("linux"), "VencordInstallerCli-linux");
assert.equal(getFilename("win32"), "VencordInstallerCli.exe");
assert.throws(() => getFilename("freebsd"), /Unsupported platform: freebsd/);
