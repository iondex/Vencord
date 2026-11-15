#!/usr/bin/env bash
set -euo pipefail

service_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export SIGNAL_HUB_VAR="${SIGNAL_HUB_VAR:-$service_directory/var}"
action="${1:-serve}"

if [[ $# -gt 1 || ! "$action" =~ ^(configure|serve|status|backup|watchdog)$ ]]; then
    printf 'Usage: bash signal-hub/scripts/start.sh [configure|serve|status|backup|watchdog]\n' >&2
    exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
    printf 'pnpm is required to install and start signal-hub.\n' >&2
    exit 1
fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error("Node.js >=22.13.0 is required"); process.exit(1); }'
if [[ ! -x "$service_directory/node_modules/.bin/tsx" ]]; then
    pnpm --dir "$service_directory" install --frozen-lockfile
fi
if [[ ! -f "$SIGNAL_HUB_VAR/settings.json" && ! -f "$SIGNAL_HUB_VAR/secrets.json" && ( "$action" == "configure" || "$action" == "serve" ) ]]; then
    pnpm --dir "$service_directory" run init
elif [[ ( "$action" == "configure" || "$action" == "serve" ) && ( ! -f "$SIGNAL_HUB_VAR/settings.json" || ! -f "$SIGNAL_HUB_VAR/secrets.json" ) ]]; then
    printf 'Incomplete configuration under %s; restore settings.json and secrets.json before starting.\n' "$SIGNAL_HUB_VAR" >&2
    exit 1
fi
if [[ "$action" == "configure" ]]; then
    printf 'Configuration: %s/settings.json\nSecrets: %s/secrets.json\nPlugin connection: %s/plugin-connection.json\n' "$SIGNAL_HUB_VAR" "$SIGNAL_HUB_VAR" "$SIGNAL_HUB_VAR"
    exit 0
fi
cd -- "$service_directory"
if [[ "$action" == "watchdog" ]]; then
    exec node --import tsx src/watchdog.ts
fi
exec node --import tsx src/main.ts "$action"
