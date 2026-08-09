#!/bin/bash
# Full test gate (§15 shift-left order): every tier, cheapest first, failing fast.
# Developer-only, run by hand: ./scripts/test-all.sh
set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/test-fast.sh

echo "── pytest -m integration (real backend subprocess) ──"
.venv/bin/python -m pytest -m integration

echo "── e2e (real Electron) ──"
(cd app && npm run test:e2e)

echo "all tests green ✓"
