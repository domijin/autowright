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
#   4. upload the AppImage + its blockmap to that release;
#   5. rewrite release/linux-x86_64/latest-linux.yml from the build output —
#      the §3 electron-updater feed — pointing it at the released binaries,
#      update the linux-x86_64 entry in docs/downloads.json (the website's
#      download index), then commit + push those files, exactly as release.sh
#      and release.ps1 do for their feeds.
#
# Running it is always the developer's act: it is the only thing here that
# commits, and it commits nothing but the feed.
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

# The feed commit lands on top of whatever is checked out, so the tree must be
# clean beforehand — the same rule release.sh and release.ps1 apply.
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
BLOCKMAP="$APPIMAGE.blockmap"
BUILT_YML="$ROOT/build/linux/latest-linux.yml"
for artifact in "$APPIMAGE" "$BLOCKMAP" "$BUILT_YML"; do
  [ -f "$artifact" ] || { echo "missing after build: $artifact"; exit 1; }
done

# ---- publish the binaries onto the existing release -------------------------
# --clobber so a re-run after a failed feed write replaces the assets instead
# of erroring out on the second upload.
echo "· uploading the AppImage + blockmap to $TAG"
gh release upload "$TAG" "$APPIMAGE" "$BLOCKMAP" --clobber

# ---- update feed (§3): latest-linux.yml under docs/, binaries on the release
# Same hosting split as the mac and Windows feeds: GitHub Pages serves the yml,
# the release serves the bytes. electron-updater's generic provider resolves
# each file's `url` against the feed's base URL, and an absolute URL is taken
# as-is (the blockmap is fetched at `<url>.blockmap`, which is exactly the
# uploaded asset's name) — so the rewrite below is all that is needed to point
# it at the release assets. Written only after the upload, so the feed never
# names a URL that is not live.
OWNER_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner | tr -d '[:space:]')"
[ -n "$OWNER_REPO" ] || { echo "could not read the repository name from gh"; exit 1; }

APPIMAGE_NAME="$(basename "$APPIMAGE")"
DOWNLOAD_URL="https://github.com/$OWNER_REPO/releases/download/$TAG/$APPIMAGE_NAME"

FEED_DIR="$ROOT/release/linux-x86_64"
FEED="$FEED_DIR/latest-linux.yml"
mkdir -p "$FEED_DIR"
DOWNLOADS="$ROOT/docs/downloads.json"
# `path:` (top level) and `- url:` (files[]) both carry the bare file name in
# electron-builder's output; nothing else in the yml mentions it.
sed "s|$APPIMAGE_NAME|$DOWNLOAD_URL|g" "$BUILT_YML" > "$FEED"
grep -qF "$DOWNLOAD_URL" "$FEED" \
  || { echo "latest-linux.yml was not rewritten with the release URL — check $BUILT_YML"; exit 1; }

# §17 docs/downloads.json — the website's download index: update only the
# linux-x86_64 entry, leaving the other OS legs' entries alone. python3 keeps
# the merge and formatting identical across all three release scripts, so the
# legs never churn each other's output.
python3 - "$DOWNLOADS" "linux-x86_64" "$VERSION" "$DOWNLOAD_URL" <<'PY'
import json, sys
path, key, version, url = sys.argv[1:]
try:
    with open(path) as f:
        data = json.load(f)
except FileNotFoundError:
    data = {}
data[key] = {"url": url, "version": version}
with open(path, "w", newline="\n") as f:
    json.dump(data, f, indent=2, sort_keys=True)
    f.write("\n")
PY

echo "· publishing update feed (release/linux-x86_64/latest-linux.yml + docs/downloads.json)"
git -C "$ROOT" add "$FEED" "$DOWNLOADS"
if [ -n "$(git -C "$ROOT" status --porcelain -- "$FEED" "$DOWNLOADS")" ]; then
  git -C "$ROOT" commit -q -m "Publish $TAG update feed (linux-x86_64)"
  git -C "$ROOT" push -q origin HEAD
else
  echo "· feed already current — nothing to commit"
fi

echo "· release $TAG published (linux-x86_64)"
