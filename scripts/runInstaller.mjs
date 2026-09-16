/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import "./checkNodeVersion.js";

import { execFileSync } from "child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { Readable } from "stream";
import { finished } from "stream/promises";
import { fileURLToPath } from "url";

const BASE_URL = "https://github.com/Vencord/Installer/releases/latest/download/";
const INSTALLER_APP_DARWIN = "VencordInstaller.app";
const INSTALLER_PATH_DARWIN = join(INSTALLER_APP_DARWIN, "Contents", "MacOS", "VencordInstaller");

const BASE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE_DIR = join(BASE_DIR, "dist", "Installer");
const ETAG_FILE = join(FILE_DIR, "etag.txt");

export function getFilename(platform = process.platform) {
    switch (platform) {
        case "win32":
            return "VencordInstallerCli.exe";
        case "darwin":
            return "VencordInstaller.dmg";
        case "linux":
            return "VencordInstallerCli-linux";
        default:
            throw new Error("Unsupported platform: " + platform);
    }
}

async function ensureBinary(platform = process.platform) {
    const filename = getFilename(platform);
    console.log("Downloading " + filename);

    mkdirSync(FILE_DIR, { recursive: true });

    const downloadName = join(FILE_DIR, filename);
    const outputFile = platform === "darwin"
        ? join(FILE_DIR, INSTALLER_PATH_DARWIN)
        : downloadName;

    const etag = existsSync(outputFile) && existsSync(ETAG_FILE)
        ? readFileSync(ETAG_FILE, "utf-8")
        : null;

    const res = await fetch(BASE_URL + filename, {
        headers: {
            "User-Agent": "Vencord (https://github.com/Vendicated/Vencord)",
            "If-None-Match": etag
        }
    });

    if (res.status === 304) {
        console.log("Up to date, not redownloading!");
        return outputFile;
    }
    if (!res.ok)
        throw new Error(`Failed to download installer: ${res.status} ${res.statusText}`);

    // WHY DOES NODE FETCH RETURN A WEB STREAM OH MY GOD
    const body = Readable.fromWeb(res.body);
    await finished(body.pipe(createWriteStream(downloadName, {
        mode: 0o755,
        autoClose: true
    })));

    if (platform === "darwin") {
        console.log("Mounting disk image...");
        const mountDir = join(FILE_DIR, "mount");
        const appDir = join(FILE_DIR, INSTALLER_APP_DARWIN);
        const nextAppDir = join(FILE_DIR, INSTALLER_APP_DARWIN + ".next");
        let mounted = false;

        rmSync(mountDir, { recursive: true, force: true });
        rmSync(nextAppDir, { recursive: true, force: true });
        mkdirSync(mountDir);

        try {
            execFileSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountDir, downloadName], {
                stdio: "inherit"
            });
            mounted = true;
            cpSync(join(mountDir, INSTALLER_APP_DARWIN), nextAppDir, { recursive: true });
        } finally {
            if (mounted)
                execFileSync("hdiutil", ["detach", mountDir], { stdio: "inherit" });
            rmSync(mountDir, { recursive: true, force: true });
        }

        rmSync(appDir, { recursive: true, force: true });
        renameSync(nextAppDir, appDir);
    }

    writeFileSync(ETAG_FILE, res.headers.get("etag") ?? "");
    console.log("Finished downloading!");

    return outputFile;
}



async function main() {
    const installerBin = await ensureBinary();

    console.log("Now running Installer...");

    const argStart = process.argv.indexOf("--");
    const args = argStart === -1 ? [] : process.argv.slice(argStart + 1);

    try {
        execFileSync(installerBin, args, {
            stdio: "inherit",
            env: {
                ...process.env,
                VENCORD_USER_DATA_DIR: BASE_DIR,
                VENCORD_DEV_INSTALL: "1"
            }
        });
    } catch {
        console.error("Something went wrong. Please check the logs above.");
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
    await main();
