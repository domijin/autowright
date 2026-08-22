#!/usr/bin/env bash
# Publish the Linux half of a release (SPEC §3/§18). The mac half stays with
# scripts/release.sh (bash + BSD sed, run from macOS): that script owns the
# version bump, the tag and the GitHub release. This script follows the Windows
# model (windows-scripts/release.ps1): it only ever adds to an existing
# release, never creates one. A release that ships all three platforms is
# three script runs against one tag/version — release.sh first (macOS), then
# this one and release.ps1 on their machines, in either order.
#
#   ./linux-scripts/release.sh
#
# What it does, in order:
#   1. read the repo-root VERSION and require the GitHub release v<version> to
#      exist already (created by release.sh);
#   2. run the full test suite (§15 shift-left order: build.sh --deps →
#      test-fast.sh → pytest -m integration → npm run test:e2e — the same
#      suite release.sh runs); any failure aborts before anything is built
#      or uploaded;
#   3. build the AppImage via linux-scripts/prod.sh (which re-checks that
#      every version site matches VERSION);
#   4. upload the AppImage to that release.
#
# Commits nothing: no Linux update feed exists yet (§3), so unlike its mac and
# Windows siblings it has no feed rewrite to publish.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---- prerequisites ----------------------------------------------------------
command -v gh > /dev/null \
  || { echo "gh CLI not found — install it from https://cli.github.com and run: gh auth login"; exit 1; }
gh auth status > /dev/null 2>&1 \
  || { echo "gh CLI not authenticated — run: gh auth login"; exit 1; }

VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
[ -n "$VERSION" ] || { echo "empty $ROOT/VERSION"; exit 1; }
TAG="v$VERSION"

gh release view "$TAG" > /dev/null 2>&1 \
  || { echo "no GitHub release $TAG — cut it from macOS first: ./scripts/release.sh $VERSION"; exit 1; }

# The upload must ship exactly what the checkout holds — the same clean-tree
# rule release.sh and release.ps1 apply before a release.
[ -z "$(git -C "$ROOT" status --porcelain)" ] \
  || { echo "working tree dirty — commit or stash before releasing"; exit 1; }

# ---- full test suite, before anything is built or uploaded ------------------
# Shift-left order (§15): cheap gate, then integration, then E2E.
echo "· running tests"
"$ROOT/scripts/build.sh" --deps
"$ROOT/scripts/test-fast.sh"
"$ROOT/.venv/bin/python" -m pytest -m integration
(cd "$ROOT/app" && npm run test:e2e)

# ---- build ------------------------------------------------------------------
echo "· version: $VERSION — building the Linux release"
"$ROOT/linux-scripts/prod.sh"

APPIMAGE="$ROOT/build/linux/Autowright-$VERSION-linux-x86_64.AppImage"
[ -f "$APPIMAGE" ] || { echo "missing after build: $APPIMAGE"; exit 1; }

# ---- publish the AppImage onto the existing release -------------------------
# --clobber so a re-run replaces the asset instead of erroring out on the
# second upload.
echo "· uploading the AppImage to $TAG"
gh release upload "$TAG" "$APPIMAGE" --clobber

echo "· release $TAG published (linux-x86_64)"
