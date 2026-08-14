#!/bin/bash
# Uninstall Ollama (installed by backend/autowright/installer.py as the
# official Mac app in /Applications or ~/Applications, plus a CLI symlink
# in /usr/local/bin — the vendor location, when writable — or ~/.local/bin).
# DEVELOPER-ONLY — run by hand in a terminal. Agents must never execute this.
# Usage: ./ollama.sh [--purge]    --purge also deletes ~/.ollama (downloaded models!)
set -euo pipefail
cd "$(dirname "$0")"
. ./_lib.sh

guard "ollama"

# Quit the menu-bar app and any server first (§19: the app owns the server).
pkill -x Ollama 2>/dev/null && echo "quit Ollama app" || true
pkill -x ollama 2>/dev/null && echo "stopped ollama server" || true

remove "/Applications/Ollama.app" \
       "$HOME/Applications/Ollama.app" \
       "$HOME/.local/bin/ollama"

# §19 vendor-location symlink: remove /usr/local/bin/ollama only when it
# points into an Ollama.app bundle — a foreign install is never touched.
if [ -L /usr/local/bin/ollama ] \
   && readlink /usr/local/bin/ollama | grep -q "Ollama.app/Contents/Resources/ollama"; then
  remove "/usr/local/bin/ollama"
fi

if [ "${1:-}" = "--purge" ]; then
  remove "$HOME/.ollama"
fi

echo "Ollama uninstalled."
