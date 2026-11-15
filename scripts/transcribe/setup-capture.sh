#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
    echo "The current transcribe capture adapter requires macOS 14.2 or later." >&2
    exit 1
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
install_dir="${1:-$HOME/.local/share/vencord-transcribe}"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/vencord-transcribe.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT

revision=56ac954369a09318e46b88a6eec33c2d2b0d32a3
archive_sha256=233e8ea460e6116be15f0ee3ce4610c2c69f508a21d42b3064ee733adaf00af5
curl --fail --silent --show-error --location --retry 2 --max-time 120 \
    "https://codeload.github.com/makeusabrew/audiotee/tar.gz/$revision" \
    --output "$build_dir/audiotee.tar.gz"
printf '%s  %s\n' "$archive_sha256" "$build_dir/audiotee.tar.gz" | shasum --algorithm 256 --check
tar -xzf "$build_dir/audiotee.tar.gz" -C "$build_dir"
swift build --package-path "$build_dir/audiotee-$revision" --configuration release --product audiotee
swiftc -O "$script_dir/audio-processes.swift" -o "$build_dir/transcribe-audio-processes"
mkdir -p "$install_dir"
install -m 755 "$build_dir/audiotee-$revision/.build/release/audiotee" "$install_dir/audiotee"
install -m 755 "$build_dir/transcribe-audio-processes" "$install_dir/transcribe-audio-processes"
printf 'Installed capture tools in %s\nNo audio was captured. macOS will request recording permission on first use.\n' "$install_dir"
