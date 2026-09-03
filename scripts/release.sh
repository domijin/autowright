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
#                                    with the DMG (install) and update zip
#                                    attached, rewrite the §3 electron-updater
#                                    feed (latest-mac.yml) in release/ plus the
#                                    docs/downloads.json download entry (and,
#                                    for 0.6.1 only, the §3 legacy-bridge
#                                    feed.json), and
#                                    last publish the §3 Homebrew cask to the
#                                    homebrew-tap repo. Needs a clean working tree,
#                                    an authenticated `gh` CLI, and a committed
#                                    docs/CHANGELOG.md entry for the version (§18);
#                                    when the entry is missing it runs
#                                    update-changelog.sh to draft one and stops for
#                                    the developer to curate + commit, then re-run.
#   ./scripts/release.sh --sync      rewrite the sites from VERSION (build.sh runs this)
#   ./scripts/release.sh --check     verify all sites match VERSION; exit 1 listing
#                                    mismatches (prod.sh refuses to build on failure)
#   ./scripts/release.sh --cask      republish the §3 Homebrew cask for the current
#                                    VERSION against its existing GitHub release —
#                                    the recovery path when the cask step failed after
#                                    the release went out (a re-run of <version> can't:
#                                    the tag already exists). Idempotent.
#   ./scripts/release.sh --feed      rewrite and push the §3 update feed
#                                    (release/darwin-<arch>/latest-mac.yml, plus the
#                                    legacy feed.json for 0.6.1 only) and the
#                                    docs/downloads.json entry for the current VERSION
#                                    against its existing GitHub release - the recovery
#                                    path when the feed commit or push failed after the
#                                    release went out. Reuses the zip in build/ for the
#                                    yml's sha512/size when it survived, otherwise
#                                    downloads the released zip to hash it. Idempotent.
#
# Files are rewritten only when their version actually differs, so pyproject.toml's
# mtime (build.sh's .backend-stamp trigger) never churns on a no-op sync.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION_FILE="$ROOT/VERSION"

PKG_JSON="$ROOT/app/package.json"
PYPROJECT="$ROOT/backend/pyproject.toml"
INIT_PY="$ROOT/backend/autowright/__init__.py"

# §3 Homebrew cask: a separate repository, always checked out beside this one.
TAP_DIR="$(dirname "$ROOT")/homebrew-tap"
TAP_REMOTE="https://github.com/hansololz/homebrew-tap.git"
CASK_REL="Casks/autowright.rb"
# The cask's `livecheck` reads the same §3 latest-mac.yml the in-app updater reads. The
# cask is arm64-only, so it is always the arm64 mac feed - and always the raw GitHub URL,
# never the retired autowright.ai/updates/… Pages path and never the frozen legacy
# feed.json (pinned at 0.6.1 forever, it would silently stop livecheck reporting).
# publish_cask pins it on every release so a hand-edit or a stale checkout can never
# leave `brew livecheck` pointing at a dead host.
CASK_LIVECHECK_URL="https://raw.githubusercontent.com/hansololz/autowright/main/release/darwin-arm64/latest-mac.yml"

ARCH="$(uname -m)"

# §3 update feed for the built arch + the §17 website download index. Both are
# rewritten after the GitHub release exists, and pushed together.
FEED="$ROOT/release/darwin-$ARCH/latest-mac.yml"
DOWNLOADS="$ROOT/docs/downloads.json"

# §3 legacy 0.6.0 bridge: the Squirrel.Mac JSON feed pre-0.6.1 installs read. It is
# rewritten exactly once - by the 0.6.1 release, pointing stranded 0.6.0 copies at the
# 0.6.1 DMG - and frozen forever after (§21.4 decision log; the §15 drift guards pin it).
LEGACY_FEED="$ROOT/release/darwin-$ARCH/feed.json"
LEGACY_BRIDGE_VERSION="0.6.1"

# GNU sed and BSD sed disagree on in-place editing (GNU: -i, BSD: -i '') — probe
# the dialect once so the version rewrites run on Linux too (build.sh --sync path).
if sed --version > /dev/null 2>&1; then SED_I=(sed -i -E); else SED_I=(sed -i '' -E); fi

usage() {
  echo "usage: $(basename "$0") <version> | --sync | --check | --cask | --feed"
  exit 2
}

# require_gh — the GitHub CLI, installed and authenticated
require_gh() {
  command -v gh > /dev/null \
    || { echo "gh CLI not found — install with: brew install gh && gh auth login"; exit 1; }
  gh auth status > /dev/null 2>&1 \
    || { echo "gh CLI not authenticated — run: gh auth login"; exit 1; }
}

# require_main_branch - this repo's checkout must sit on main before anything is
# published. The §3 update feeds are fetched from
# raw.githubusercontent.com/<owner>/<repo>/main/release/..., so a feed committed on
# any other branch is never the file installed apps read: the release would go out
# with an update feed that silently stays at the previous version. Same rule
# tap_preflight applies to the homebrew-tap checkout, applied to this repo.
require_main_branch() {
  local branch
  branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
  [ "$branch" = "main" ] \
    || { echo "on branch '$branch', not main - the §3 feed URLs are pinned to /main/; switch before releasing"; exit 1; }
}

# tap_preflight — make the §3 Homebrew tap checkout ready to receive a bump: cloned,
# on main, clean, holding the cask, and fast-forwarded to origin. The checkout is
# always `../homebrew-tap`, the sibling of this repo. Called before a release modifies
# anything, so a broken tap can never strand a published release next to an un-bumped
# cask.
tap_preflight() {
  if [ ! -d "$TAP_DIR/.git" ]; then
    echo "· cloning homebrew tap into ${TAP_DIR}"
    git clone -q "$TAP_REMOTE" "$TAP_DIR" \
      || { echo "failed to clone $TAP_REMOTE into $TAP_DIR"; exit 1; }
  fi
  [ -f "$TAP_DIR/$CASK_REL" ] \
    || { echo "cask missing: $TAP_DIR/$CASK_REL"; exit 1; }
  local branch
  branch="$(git -C "$TAP_DIR" rev-parse --abbrev-ref HEAD)"
  [ "$branch" = "main" ] \
    || { echo "homebrew tap is on '$branch', not main — switch it before releasing"; exit 1; }
  [ -z "$(git -C "$TAP_DIR" status --porcelain)" ] \
    || { echo "homebrew tap working tree dirty ($TAP_DIR) — commit or stash before releasing"; exit 1; }
  git -C "$TAP_DIR" fetch -q origin main \
    || { echo "cannot reach the homebrew tap remote ($TAP_REMOTE)"; exit 1; }
  git -C "$TAP_DIR" merge -q --ff-only origin/main \
    || { echo "homebrew tap has diverged from origin/main ($TAP_DIR) — reconcile it before releasing"; exit 1; }
}

# publish_cask <version> <dmg> — point the cask at a released DMG and push the tap.
# Only ever called once the GitHub release is live: the cask pins that asset's hash.
# arm64 only — the cask declares `depends_on arch: :arm64`, so an x86_64 release must
# not overwrite its URL and hash. Idempotent: an already-current cask pushes nothing.
publish_cask() {
  local version="$1" dmg="$2" cask="$TAP_DIR/$CASK_REL" sha style_out
  if [ "$ARCH" != "arm64" ]; then
    echo "· skipping homebrew cask (built $ARCH; the cask is arm64-only)"
    return 0
  fi
  sha="$(shasum -a 256 "$dmg" | awk '{print $1}')"
  echo "· updating homebrew cask ($version, sha256 ${sha:0:12}…)"
  "${SED_I[@]}" "s/^(  version \")[^\"]+(\")$/\1$version\2/" "$cask"
  "${SED_I[@]}" "s/^(  sha256 \")[^\"]+(\")$/\1$sha\2/" "$cask"
  grep -q "^  version \"$version\"$" "$cask" \
    || { echo "cask version line not rewritten — check $cask"; exit 1; }
  grep -q "^  sha256 \"$sha\"$" "$cask" \
    || { echo "cask sha256 line not rewritten — check $cask"; exit 1; }
  # The livecheck URL is pinned, not just left alone: it is the only line naming the §3
  # feed host, and a stale one fails silently (brew livecheck just stops reporting). The
  # four-space indent scopes the match to the `livecheck do` block - the cask's own `url`
  # stanza sits at two spaces and ends in a comma.
  "${SED_I[@]}" "s|^(    url \")[^\"]+(\")$|\1$CASK_LIVECHECK_URL\2|" "$cask"
  grep -q "^    url \"$CASK_LIVECHECK_URL\"$" "$cask" \
    || { echo "cask livecheck url not rewritten - check $cask"; exit 1; }
  # Output is captured rather than streamed: brew re-bundles its rubocop gems on stderr
  # from time to time, which has no place in a release log unless the lint fails.
  if command -v brew > /dev/null; then
    if ! style_out="$(brew style "$cask" 2>&1)"; then
      echo "brew style failed on $cask"
      printf '%s\n' "$style_out"
      exit 1
    fi
  fi
  if [ -n "$(git -C "$TAP_DIR" status --porcelain)" ]; then
    git -C "$TAP_DIR" commit -q -am "autowright $version"
  else
    echo "· cask already at $version — no bump commit"
  fi
  # Pushing is decided by what origin is missing, not by whether this run wrote the
  # bump: a tap holding earlier local commits (a README edit, a hand-fixed stanza)
  # must still reach GitHub, or the published cask silently lags the checkout.
  if [ -z "$(git -C "$TAP_DIR" log --oneline origin/main..main)" ]; then
    echo "· homebrew tap already in sync with origin/main — nothing to push"
    return 0
  fi
  git -C "$TAP_DIR" push -q origin main \
    || { echo "failed to push the homebrew tap — re-run: $(basename "$0") --cask"; exit 1; }
  echo "· homebrew cask published (hansololz/tap/autowright $version)"
}

# release_asset_url <version> <ext> - the download URL of that release's arm64/x86_64
# artifact (.dmg installs, .zip updates). One spelling of the URL for every caller, so
# the feed, the download index, and the --feed recovery path can never disagree about it.
release_asset_url() {
  local version="$1" ext="$2" owner_repo
  owner_repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
  printf 'https://github.com/%s/releases/download/v%s/Autowright-%s-darwin-%s%s' \
    "$owner_repo" "$version" "$version" "$ARCH" "$ext"
}

# write_feed <version> <zip-url> <zip-path> - rewrite the built arch's electron-updater
# feed (SPEC §3, latest-mac.yml): the released zip's absolute URL plus its base64 sha512
# and byte size, computed from the local artifact (electron-updater refuses a download
# whose digest disagrees, so the hashed file must be the uploaded one). Called only once
# the release is live, so the feed never names a URL that isn't. Only the zip is listed -
# the DMG is the install artifact and belongs to docs/downloads.json.
write_feed() {
  local version="$1" zip_url="$2" zip_path="$3" sha512 size
  sha512="$(openssl dgst -sha512 -binary "$zip_path" | base64 | tr -d '\n')"
  size="$(stat -f%z "$zip_path" 2>/dev/null || stat -c%s "$zip_path")"
  mkdir -p "$(dirname "$FEED")"
  cat > "$FEED" <<EOF
version: $version
files:
  - url: $zip_url
    sha512: $sha512
    size: $size
path: $zip_url
sha512: $sha512
releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
EOF
}

# write_legacy_feed <version> <dmg-url> - the §3 one-time 0.6.0 bridge: rewrite the built
# arch's legacy Squirrel.Mac JSON feed so installed 0.6.0 copies (whose updater downloads
# the DMG and rebuilds Squirrel's zip from it on-device) can still reach 0.6.1. Runs only
# when the released version IS the bridge version; every later release leaves feed.json
# frozen - rewriting it past 0.6.1 would hand 0.6.0 installs a release whose DMG their
# flow can still consume, but the frozen two-hop bridge is the §21.4-logged decision and
# the §15 drift guards enforce it.
write_legacy_feed() {
  local version="$1" dmg_url="$2"
  [ "$version" = "$LEGACY_BRIDGE_VERSION" ] || return 0
  echo "· writing the §3 legacy 0.6.0 bridge feed (feed.json → v$version DMG)"
  mkdir -p "$(dirname "$LEGACY_FEED")"
  cat > "$LEGACY_FEED" <<EOF
{
  "currentRelease": "$version",
  "releases": [
    {
      "version": "$version",
      "updateTo": {
        "version": "$version",
        "name": "v$version",
        "url": "$dmg_url"
      }
    }
  ]
}
EOF
}

# write_downloads <key> <version> <url> - the §17 docs/downloads.json website
# download index: update only this OS/arch's entry, leaving the other OS legs'
# entries alone. python3 keeps the merge and formatting identical across all three
# release scripts, so the legs never churn each other's output.
write_downloads() {
  python3 - "$DOWNLOADS" "$1" "$2" "$3" <<'PY'
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
}

# push_feed <version> - commit + push just the feed and the download index (plain
# git commit, not commit.sh). Idempotent, and split the way publish_cask splits:
# an already-current pair commits nothing, but the push still runs whenever main
# is ahead of origin/main, so an earlier failed push can never leave the served
# feed lagging the checkout. The commit names its paths explicitly, so a --feed
# recovery run never sweeps up unrelated work.
push_feed() {
  local version="$1"
  # The legacy bridge feed is part of the commit only where it exists on disk
  # (it changes on the 0.6.1 release; a fresh x86_64 leg may never have one) -
  # a pathspec naming a file git has never seen would fail the commit.
  local paths=("$FEED" "$DOWNLOADS")
  [ -f "$LEGACY_FEED" ] && paths+=("$LEGACY_FEED")
  if [ -n "$(git -C "$ROOT" status --porcelain -- "${paths[@]}")" ]; then
    echo "· publishing update feed (release/darwin-$ARCH/latest-mac.yml + docs/downloads.json)"
    git -C "$ROOT" add "${paths[@]}"
    git -C "$ROOT" commit -q -m "Publish v$version update feed (darwin-$ARCH)" \
      -- "${paths[@]}"
  else
    echo "· update feed already at $version - no feed commit"
  fi
  git -C "$ROOT" fetch -q origin main \
    || { echo "cannot reach origin - the feed commit is local only; re-run: $(basename "$0") --feed"; exit 1; }
  if [ -z "$(git -C "$ROOT" log --oneline origin/main..HEAD)" ]; then
    echo "· update feed already on origin/main - nothing to push"
    return 0
  fi
  git -C "$ROOT" push -q origin HEAD \
    || { echo "failed to push the update feed - re-run: $(basename "$0") --feed"; exit 1; }
  echo "· update feed pushed (v$version, darwin-$ARCH)"
}

[ $# -eq 1 ] || usage
MODE="$1"

if [ "$MODE" != "--sync" ] && [ "$MODE" != "--check" ] \
   && [ "$MODE" != "--cask" ] && [ "$MODE" != "--feed" ]; then
  if ! printf '%s' "$MODE" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
    echo "invalid version: '$MODE' (expected MAJOR.MINOR.PATCH[-prerelease])"
    exit 2
  fi
  # Release prerequisites, checked before touching anything: the release commit
  # must contain only the version bump, and publishing needs an authenticated gh.
  require_gh
  [ -z "$(git -C "$ROOT" status --porcelain)" ] \
    || { echo "working tree dirty — commit or stash before releasing"; exit 1; }
  require_main_branch
  if git -C "$ROOT" rev-parse -q --verify "refs/tags/v$MODE" > /dev/null \
     || git -C "$ROOT" ls-remote --exit-code --tags origin "refs/tags/v$MODE" > /dev/null 2>&1; then
    echo "tag v$MODE already exists — pick a new version"
    exit 1
  fi
  # §17/§18 changelog gate: the §9.4 What's-new notes are written (and, per the
  # clean-tree rule above, committed) before the release is cut, never after. A
  # missing entry is drafted on the spot by update-changelog.sh (the tree is clean,
  # so the draft is the only change left behind), then this run stops: the draft is
  # curated by hand and committed before release.sh is run again. A release is never
  # cut on the same run that drafted its notes.
  if ! grep -Eq "^## v${MODE//./\\.}( |\$)" "$ROOT/docs/CHANGELOG.md" 2> /dev/null; then
    echo "docs/CHANGELOG.md has no '## v$MODE' entry - drafting it (update-changelog.sh)"
    echo
    "$ROOT/scripts/update-changelog.sh" "$MODE"
    echo
    echo "release not cut: curate the '## v$MODE' section in docs/CHANGELOG.md, commit it,"
    echo "then re-run: $(basename "$0") $MODE"
    exit 1
  fi
  tap_preflight
  printf '%s\n' "$MODE" > "$VERSION_FILE"
fi

[ -f "$VERSION_FILE" ] || { echo "missing $VERSION_FILE"; exit 1; }
VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
[ -n "$VERSION" ] || { echo "empty $VERSION_FILE"; exit 1; }

# ---- --cask: republish the §3 cask alone, against an existing release ----
# Recovery for a cask step that failed after the GitHub release went out. Touches no
# version site and no autowright commit — only the tap. The DMG comes from the local
# build when it survived, otherwise straight back down from the release it pins.
if [ "$MODE" = "--cask" ]; then
  require_gh
  gh release view "v$VERSION" > /dev/null 2>&1 \
    || { echo "no GitHub release v$VERSION — cut it with: $(basename "$0") $VERSION"; exit 1; }
  tap_preflight
  DMG_NAME="Autowright-$VERSION-darwin-$ARCH.dmg"
  CASK_TMP="$(mktemp -d)"
  trap 'rm -rf "$CASK_TMP"' EXIT
  echo "· downloading $DMG_NAME from release v$VERSION"
  gh release download "v$VERSION" -p "$DMG_NAME" -D "$CASK_TMP" \
    || { echo "release v$VERSION has no asset $DMG_NAME"; exit 1; }
  publish_cask "$VERSION" "$CASK_TMP/$DMG_NAME"
  exit 0
fi

# ---- --feed: republish the §3 update feed alone, against an existing release ----
# Recovery for a feed rewrite/commit/push that failed after the GitHub release went
# out (a re-run of <version> can't: the tag already exists). Touches no version site
# and builds nothing. The release's asset list is read to prove the URLs the feed is
# about to name are live; the zip itself is reused from build/ when it survived (the
# yml needs its sha512/size), otherwise downloaded back from the release to hash.
if [ "$MODE" = "--feed" ]; then
  require_gh
  require_main_branch
  gh release view "v$VERSION" > /dev/null 2>&1 \
    || { echo "no GitHub release v$VERSION — cut it with: $(basename "$0") $VERSION"; exit 1; }
  FEED_ASSETS="$(gh release view "v$VERSION" --json assets -q '.assets[].name')"
  for name in "Autowright-$VERSION-darwin-$ARCH.dmg" "Autowright-$VERSION-darwin-$ARCH.zip"; do
    printf '%s\n' "$FEED_ASSETS" | grep -qx "$name" \
      || { echo "release v$VERSION has no asset $name - the feed would name a dead URL"; exit 1; }
  done
  FEED_ZIP="$ROOT/build/Autowright-$VERSION-darwin-$ARCH.zip"
  if [ ! -f "$FEED_ZIP" ]; then
    FEED_TMP="$(mktemp -d)"
    trap 'rm -rf "$FEED_TMP"' EXIT
    echo "· downloading Autowright-$VERSION-darwin-$ARCH.zip from release v$VERSION (for its sha512)"
    gh release download "v$VERSION" -p "Autowright-$VERSION-darwin-$ARCH.zip" -D "$FEED_TMP" \
      || { echo "failed to download the released zip"; exit 1; }
    FEED_ZIP="$FEED_TMP/Autowright-$VERSION-darwin-$ARCH.zip"
  fi
  write_feed "$VERSION" "$(release_asset_url "$VERSION" .zip)" "$FEED_ZIP"
  write_legacy_feed "$VERSION" "$(release_asset_url "$VERSION" .dmg)"
  write_downloads "darwin-$ARCH" "$VERSION" "$(release_asset_url "$VERSION" .dmg)"
  push_feed "$VERSION"
  exit 0
fi

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
    "$PKG_JSON")  "${SED_I[@]}" "s/^(  \"version\": \")[^\"]+(\",)$/\1$VERSION\2/" "$1" ;;
    "$PYPROJECT") "${SED_I[@]}" "s/^(version = \")[^\"]+(\")$/\1$VERSION\2/" "$1" ;;
    "$INIT_PY")   "${SED_I[@]}" "s/^(__version__ = \")[^\"]+(\")$/\1$VERSION\2/" "$1" ;;
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
  "$ROOT/scripts/tests/fast.sh"
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
  DMG="$ROOT/build/Autowright-$VERSION-darwin-$ARCH.dmg"
  ZIP="$ROOT/build/Autowright-$VERSION-darwin-$ARCH.zip"
  [ -f "$DMG" ] || { echo "DMG missing after build: $DMG"; exit 1; }
  [ -f "$ZIP" ] || { echo "update zip missing after build: $ZIP"; exit 1; }
  # The release body is the curated §17 docs/CHANGELOG.md section for this version
  # (the lines under its "## v<version>" heading, up to the next "## " heading),
  # never GitHub's commit-derived auto-notes, so the release page, the §9.4 What's-new
  # modal, and the file on GitHub say the same thing. The gate above proved the
  # heading exists; a heading with an empty body still refuses here, before the tag
  # is cut, so the notes can be filled in and the same version re-run.
  NOTES_FILE="$(mktemp)"
  trap 'rm -f "$NOTES_FILE"' EXIT
  awk -v v="$VERSION" '
    /^## /           { if (on) exit; on = ($2 == ("v" v)); next }
    !on              { next }
    /^[[:space:]]*$/ { if (started) pending++; next }
                     { for (; pending > 0; pending--) print ""; started = 1; print }
  ' "$ROOT/docs/CHANGELOG.md" > "$NOTES_FILE"
  [ -s "$NOTES_FILE" ] \
    || { echo "docs/CHANGELOG.md '## v$VERSION' section is empty - write the release notes before releasing"; exit 1; }
  echo "· creating GitHub release v$VERSION (notes from docs/CHANGELOG.md)"
  gh release create "v$VERSION" "$DMG" "$ZIP" \
    --title "v$VERSION" --notes-file "$NOTES_FILE"

  # ---- update feed (SPEC §3): latest-mac.yml for this arch, raw from GitHub ----
  # Written only after the release exists, so the feed never points at a URL
  # that isn't live yet. Same functions the --feed recovery mode runs. The
  # legacy write is the §3 one-time 0.6.0 bridge - a no-op for every version
  # but 0.6.1.
  write_feed "$VERSION" "$(release_asset_url "$VERSION" .zip)" "$ZIP"
  write_legacy_feed "$VERSION" "$(release_asset_url "$VERSION" .dmg)"
  write_downloads "darwin-$ARCH" "$VERSION" "$(release_asset_url "$VERSION" .dmg)"
  push_feed "$VERSION"

  # ---- Homebrew cask (SPEC §3): bump the tap, last, once the release is live ----
  publish_cask "$VERSION" "$DMG"
  echo "· release v$VERSION published"
fi
