#!/bin/bash
# Uninstall Codex CLI (installed by backend/autowright/installer.py via the
# official installer script: `codex` symlink in ~/.local/bin, versioned
# payloads under ~/.codex/packages/standalone).
# DEVELOPER-ONLY — run by hand in a terminal. Agents must never execute this.
# Usage: ./codex.sh [--purge]    --purge also deletes ~/.codex (config + auth)
set -euo pipefail
cd "$(dirname "$0")"
. ./_lib.sh

guard "codex"

remove "$HOME/.local/bin/codex" \
       "$HOME/.local/bin/codex-code-mode-host" \
       "$HOME/.codex/packages/standalone"

if [ "${1:-}" = "--purge" ]; then
  remove "$HOME/.codex"
fi

echo "Codex uninstalled."
