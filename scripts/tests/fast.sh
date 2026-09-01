#!/bin/bash
# Cheap-first test gate (§15 shift-left order): fail fast, cheapest tier first.
# Developer-only, run by hand: ./scripts/tests/fast.sh
# Slower tiers, run when the gate is green:
#   .venv/bin/python -m pytest -m integration     (~10s, real backend subprocess)
#   cd app && npm run test:e2e                    (minutes, real Electron)
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "── 1/3 Vitest unit (app/tests) ──"
(cd app && npx vitest run)

# Two configs, because one `include` cannot hold both (§15 typecheck coverage):
# tsconfig.json is the shipped renderer (src), tsconfig.test.json is everything
# else that is TypeScript but never ships: tests/, e2e/, the Vite/Vitest
# configs, ds-entry.ts.
echo "── 2/3 tsc --noEmit (src, then tests/e2e/configs) ──"
(cd app && npx tsc --noEmit && npx tsc --noEmit -p tsconfig.test.json)

echo "── 3/3 pytest unit (parallel) ──"
.venv/bin/python -m pytest

echo "fast gate green ✓"
