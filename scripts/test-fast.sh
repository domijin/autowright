#!/bin/bash
# Cheap-first test gate (§15 shift-left order): fail fast, cheapest tier first.
# Developer-only, run by hand: ./scripts/test-fast.sh
# Slower tiers, run when the gate is green:
#   .venv/bin/python -m pytest -m integration     (~10s, real backend subprocess)
#   cd app && npm run test:e2e                    (minutes, real Electron)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── 1/3 Vitest unit (app/tests) ──"
(cd app && npx vitest run)

echo "── 2/3 tsc --noEmit ──"
(cd app && npx tsc --noEmit)

echo "── 3/3 pytest unit (parallel) ──"
.venv/bin/python -m pytest

echo "fast gate green ✓"
