#!/usr/bin/env bash
# Single version source (SPEC §17/§18): the repo-root VERSION file, synced into
# the three version sites — app/package.json, backend/pyproject.toml, and
# backend/autowright/__init__.py.
#
#   ./scripts/release.sh <version>   cut a release: write VERSION, sync all sites,
#                                    run the full test suite (fast gate →
#                                    integration → E2E), commit + push the bump,
#                                    build the distributable via prod.sh, then
#                                    publish a GitHub release (tag v<version>)
#                                    with the DMG + update zip attached and
#                                    rewrite the §3 Squirrel feed in docs/updates/.
#                                    Needs a clean working tree and an authenticated
#                                    `gh` CLI.
#   ./scripts/release.sh --sync      rewrite the sites from VERSION (build.sh runs this)
#   ./scripts/release.sh --check     verify all sites match VERSION; exit 1 listing
#                                    mismatches (prod.sh refuses to build on failure)
#
# Files are rewritten only when their version actually differs, so pyproject.toml's
# mtime (build.sh's .backend-stamp trigger) never churns on a no-op sync.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION_FILE="$ROOT/VERSION"

PKG_JSON="$ROOT/app/package.json"
PYPROJECT="$ROOT/backend/pyproject.toml"
INIT_PY="$ROOT/backend/autowright/__init__.py"

usage() {
  echo "usage: $(basename "$0") <version> | --sync | --check"
  exit 2
}

# semver_gt <a> <b> — true when a is strictly higher than b. Numeric core compared
# field by field; on an equal core a release outranks any pre-release, and two
# pre-releases compare lexically (close enough to semver for this repo's tags).
semver_gt() {
  local a_core="${1%%-*}" b_core="${2%%-*}" a_pre="" b_pre=""
  [ "$1" = "$a_core" ] || a_pre="${1#*-}"
  [ "$2" = "$b_core" ] || b_pre="${2#*-}"
  if [ "$a_core" != "$b_core" ]; then
    [ "$(printf '%s\n%s\n' "$a_core" "$b_core" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" = "$a_core" ]
    return
  fi
  [ -z "$a_pre" ] && [ -n "$b_pre" ] && return 0
  [ -n "$a_pre" ] && [ -n "$b_pre" ] && [ "$a_pre" != "$b_pre" ] \
    && [ "$(printf '%s\n%s\n' "$a_pre" "$b_pre" | sort | tail -1)" = "$a_pre" ]
}

[ $# -eq 1 ] || usage
MODE="$1"

if [ "$MODE" != "--sync" ] && [ "$MODE" != "--check" ]; then
  if ! printf '%s' "$MODE" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
    echo "invalid version: '$MODE' (expected MAJOR.MINOR.PATCH[-prerelease])"
    exit 2
  fi
  # Release prerequisites, checked before touching anything: the release commit
  # must contain only the version bump, and publishing needs an authenticated gh.
  command -v gh > /dev/null \
    || { echo "gh CLI not found — install with: brew install gh && gh auth login"; exit 1; }
  gh auth status > /dev/null 2>&1 \
    || { echo "gh CLI not authenticated — run: gh auth login"; exit 1; }
  [ -z "$(git -C "$ROOT" status --porcelain)" ] \
    || { echo "working tree dirty — commit or stash before releasing"; exit 1; }
  if git -C "$ROOT" rev-parse -q --verify "refs/tags/v$MODE" > /dev/null \
     || git -C "$ROOT" ls-remote --exit-code --tags origin "refs/tags/v$MODE" > /dev/null 2>&1; then
    echo "tag v$MODE already exists — pick a new version"
    exit 1
  fi
  CURRENT="$(tr -d '[:space:]' < "$VERSION_FILE")"
  if [ -n "$CURRENT" ] && ! semver_gt "$MODE" "$CURRENT"; then
    echo "version $MODE is not higher than current $CURRENT"
    exit 1
  fi
  printf '%s\n' "$MODE" > "$VERSION_FILE"
fi

[ -f "$VERSION_FILE" ] || { echo "missing $VERSION_FILE"; exit 1; }
VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
[ -n "$VERSION" ] || { echo "empty $VERSION_FILE"; exit 1; }

# read_version <file> — print the version currently in a site
read_version() {
  case "$1" in
    "$PKG_JSON")  sed -nE 's/^  "version": "([^"]+)",$/\1/p' "$1" ;;
    "$PYPROJECT") sed -nE 's/^version = "([^"]+)"$/\1/p' "$1" ;;
    "$INIT_PY")   sed -nE 's/^__version__ = "([^"]+)"$/\1/p' "$1" ;;
  esac
}

# write_version <file> — rewrite a site's version line to $VERSION
write_version() {
  case "$1" in
    "$PKG_JSON")  sed -i '' -E "s/^(  \"version\": \")[^\"]+(\",)$/\1$VERSION\2/" "$1" ;;
    "$PYPROJECT") sed -i '' -E "s/^(version = \")[^\"]+(\")$/\1$VERSION\2/" "$1" ;;
    "$INIT_PY")   sed -i '' -E "s/^(__version__ = \")[^\"]+(\")$/\1$VERSION\2/" "$1" ;;
  esac
}

MISMATCH=0
for f in "$PKG_JSON" "$PYPROJECT" "$INIT_PY"; do
  current="$(read_version "$f")"
  if [ -z "$current" ]; then
    echo "no version line found in ${f#"$ROOT"/}"
    exit 1
  fi
  if [ "$current" = "$VERSION" ]; then
    continue
  fi
  if [ "$MODE" = "--check" ]; then
    echo "version mismatch: ${f#"$ROOT"/} has $current, VERSION has $VERSION"
    MISMATCH=1
  else
    write_version "$f"
    echo "· ${f#"$ROOT"/}: $current → $VERSION"
  fi
done

if [ "$MODE" = "--check" ]; then
  [ "$MISMATCH" -eq 0 ] || { echo "run ./scripts/release.sh --sync (or <version>) to fix"; exit 1; }
  echo "· version OK: $VERSION"
elif [ "$MODE" = "--sync" ]; then
  echo "· version: $VERSION"
else
  # ---- full test suite, before anything is committed or built ----
  # Shift-left order (§15): cheap gate, then integration, then E2E. A failure
  # aborts here with the version bump still uncommitted.
  echo "· running tests"
  "$ROOT/scripts/build.sh" --deps
  "$ROOT/scripts/test-fast.sh"
  "$ROOT/.venv/bin/python" -m pytest -m integration
  (cd "$ROOT/app" && npm run test:e2e)

  # ---- commit + push the version bump (skipped when nothing changed) ----
  # Tree was clean at preflight, so commit.sh only picks up the version bump.
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    echo "· committing version bump (commit.sh)"
    "$ROOT/scripts/commit.sh"
  fi
  echo "· pushing"
  git -C "$ROOT" push -q origin HEAD

  # ---- build the distributable ----
  echo "· version: $VERSION — building release"
  "$ROOT/scripts/prod.sh"

  # ---- publish the GitHub release (tags the pushed commit, uploads DMG + zip) ----
  ARCH="$(uname -m)"
  DMG="$ROOT/build/Autowright-$VERSION-darwin-$ARCH.dmg"
  ZIP="$ROOT/build/Autowright-$VERSION-darwin-$ARCH.zip"
  [ -f "$DMG" ] || { echo "DMG missing after build: $DMG"; exit 1; }
  [ -f "$ZIP" ] || { echo "update zip missing after build: $ZIP"; exit 1; }
  echo "· creating GitHub release v$VERSION"
  gh release create "v$VERSION" "$DMG" "$ZIP" \
    --title "v$VERSION" --generate-notes

  # ---- update feed (SPEC §3): Squirrel.Mac JSON for this arch, via GitHub Pages ----
  # Written only after the release exists, so the feed never points at a URL
  # that isn't live yet.
  OWNER_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
  FEED="$ROOT/docs/updates/darwin-$ARCH.json"
  mkdir -p "$ROOT/docs/updates"
  cat > "$FEED" <<EOF
{
  "currentRelease": "$VERSION",
  "releases": [
    {
      "version": "$VERSION",
      "updateTo": {
        "version": "$VERSION",
        "name": "v$VERSION",
        "url": "https://github.com/$OWNER_REPO/releases/download/v$VERSION/$(basename "$ZIP")"
      }
    }
  ]
}
EOF
  echo "· publishing update feed (docs/updates/darwin-$ARCH.json)"
  git -C "$ROOT" add "$FEED"
  git -C "$ROOT" commit -q -m "Publish v$VERSION update feed (darwin-$ARCH)"
  git -C "$ROOT" push -q origin HEAD
  echo "· release v$VERSION published"
fi
