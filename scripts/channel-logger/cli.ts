/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface LoggerArgs {
    directory: string;
    port: number;
}

export function parseLoggerArgs(args: string[]): LoggerArgs {
    let directory: string | undefined;
    let port = 49322;

    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (argument === "--dir") {
            directory = args[++index];
        } else if (argument.startsWith("--dir=")) {
            directory = argument.slice("--dir=".length);
        } else if (argument === "--port") {
            port = Number(args[++index]);
        } else if (argument.startsWith("--port=")) {
            port = Number(argument.slice("--port=".length));
        } else if (argument === "--") {
            continue;
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }

    if (!directory) throw new Error("--dir is required");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("--port must be a valid TCP port");
    }

    return { directory, port };
}
