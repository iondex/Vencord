import { existsSync, readFileSync } from "node:fs";

export const pluginProfilePath = new URL("../../signal-hub/plugin-profile.json", import.meta.url);
const profile = JSON.parse(readFileSync(pluginProfilePath, "utf8"));
if (!Array.isArray(profile.plugins) || profile.plugins.length !== 2
    || profile.plugins.some(plugin => !["forwarder", "channel-logger"].includes(plugin.name)
        || plugin.directory !== `${plugin.name}.desktop`)
    || new Set(profile.plugins.map(plugin => plugin.name)).size !== 2) {
    throw new Error("Invalid signal-hub plugin profile");
}
for (const plugin of profile.plugins) {
    if (!existsSync(new URL(`../../src/plugins/${plugin.directory}/index.tsx`, import.meta.url))) {
        throw new Error(`Missing signal-hub plugin: ${plugin.name}`);
    }
}

export function includePlugin(directory, name) {
    return ["plugins/_api", "plugins/_core", "src/plugins/_api", "src/plugins/_core"].includes(directory)
        || (["plugins", "src/plugins"].includes(directory)
            && (name === "transcribe.desktop" || profile.plugins.some(plugin => plugin.directory === name)));
}
