/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { resolve } from "node:path";

import { parseLoggerArgs } from "./cli";
import { createChannelLoggerServer } from "./server";
import { ChannelLogStore } from "./storage";

function log(message: string) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

try {
    const { directory, port } = parseLoggerArgs(process.argv.slice(2));
    const resolvedDirectory = resolve(directory);
    const store = new ChannelLogStore(resolvedDirectory);
    const server = createChannelLoggerServer({ store, log });

    server.listen(port, "127.0.0.1", () => {
        log(`listening url=http://127.0.0.1:${port} database=${store.databasePath}`);
    });
    server.on("error", error => {
        log(`server error=${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        process.exitCode = 1;
    });

    const close = (signal: string) => {
        log(`received ${signal}; closing`);
        server.close(() => {
            store.close();
            log("closed");
        });
    };
    process.once("SIGINT", () => close("SIGINT"));
    process.once("SIGTERM", () => close("SIGTERM"));
} catch (error) {
    console.error(`channel logger: ${error instanceof Error ? error.message : String(error)}`);
    console.error("usage: pnpm run logger -- --dir /path/to/logs [--port 49322]");
    process.exitCode = 1;
}
