#!/bin/bash
# Development install: symlink this checkout into the Omarchy plugins directory
# so edits here are what the shell loads.
#
# For normal use install the published plugin instead:
#   omarchy plugin add https://github.com/diddado/omarchy-tailscale-ssh.git --enable

set -euo pipefail

PLUGIN_ID="io.github.diddado.tailscale-ssh"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$HOME/.config/omarchy/plugins/$PLUGIN_ID"

mkdir -p "$(dirname "$TARGET")"
[[ -e $TARGET || -L $TARGET ]] && rm -rf "$TARGET"
ln -s "$SOURCE_DIR" "$TARGET"
echo "Linked $TARGET -> $SOURCE_DIR"

omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
omarchy plugin enable "$PLUGIN_ID" --section right >/dev/null 2>&1 || true

echo
# Measured, not assumed: the inotify watcher fires and rescanPlugins reloads the
# manifest, but neither swaps the QML of a bar widget that is already mounted.
echo "After editing QML, reload with:  omarchy restart shell"
echo "The rules file is watched separately and reloads on its own."
