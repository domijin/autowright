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
#                                    with the DMG attached, rewrite
#                                    the §3 Squirrel feed in release/ plus the
#                                    docs/downloads.json download entry, and
#                                    last publish the §3 Homebrew cask to the
#                                    homebrew-tap repo. Needs a clean working tree
#                                    and an authenticated `gh` CLI.
#   ./scripts/release.sh --sync      rewrite the sites from VERSION (build.sh runs this)
#   ./scripts/release.sh --check     verify all sites match VERSION; exit 1 listing
#                                    mismatches (prod.sh refuses to build on failure)
#   ./scripts/release.sh --cask      republish the §3 Homebrew cask for the current
#                                    VERSION against its existing GitHub release —
#                                    the recovery path when the cask step failed after
#                                    the release went out (a re-run of <version> can't:
#                                    the tag already exists). Idempotent.
#   ./scripts/release.sh --feed      rewrite and push the §3 update feed
#                                    (release/darwin-<arch>/feed.json) plus the
#                                    docs/downloads.json entry for the current VERSION
#                                    against its existing GitHub release - the recovery
#                                    path when the feed commit or push failed after the
#                                    release went out. Idempotent.
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
# The cask's `livecheck` reads the same §3 feed the in-app updater reads. The cask is
# arm64-only, so it is always the arm64 mac feed - and always the raw GitHub URL, never
# the retired autowright.ai/updates/… Pages path. publish_cask pins it on every release
# so a hand-edit or a stale checkout can never leave `brew livecheck` pointing at a dead
# host.
CASK_LIVECHECK_URL="https://raw.githubusercontent.com/hansololz/autowright/main/release/darwin-arm64/feed.json"

ARCH="$(uname -m)"

# §3 update feed for the built arch + the §17 website download index. Both are
# rewritten after the GitHub release exists, and pushed together.
FEED="$ROOT/release/darwin-$ARCH/feed.json"
DOWNLOADS="$ROOT/docs/downloads.json"

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

# release_dmg_url <version> - the download URL of that release's arm64/x86_64 DMG.
# One spelling of the URL for every caller, so the feed, the download index, and the
# --feed recovery path can never disagree about it.
release_dmg_url() {
  local version="$1" owner_repo
  owner_repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
  printf 'https://github.com/%s/releases/download/v%s/Autowright-%s-darwin-%s.dmg' \
    "$owner_repo" "$version" "$version" "$ARCH"
}

# write_feed <version> <dmg-url> - rewrite the built arch's Squirrel.Mac JSON feed
# (SPEC §3): `currentRelease` plus one `releases[]` entry pointing at the released
# DMG. Called only once the release is live, so the feed never names a URL that
# isn't. The URL must stay a .dmg - the §3 update-download flow mounts it with
# `hdiutil attach` and builds Squirrel's zip from the mounted .app.
write_feed() {
  local version="$1" dmg_url="$2"
  mkdir -p "$(dirname "$FEED")"
  cat > "$FEED" <<EOF
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
  if [ -n "$(git -C "$ROOT" status --porcelain -- "$FEED" "$DOWNLOADS")" ]; then
    echo "· publishing update feed (release/darwin-$ARCH/feed.json + docs/downloads.json)"
    git -C "$ROOT" add "$FEED" "$DOWNLOADS"
    git -C "$ROOT" commit -q -m "Publish v$version update feed (darwin-$ARCH)" \
      -- "$FEED" "$DOWNLOADS"
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
  CURRENT="$(tr -d '[:space:]' < "$VERSION_FILE")"
  if [ -n "$CURRENT" ] && ! semver_gt "$MODE" "$CURRENT"; then
    echo "version $MODE is not higher than current $CURRENT"
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
# out (a re-run of <version> can't: the tag already exists). Touches no version site,
# builds nothing, and never downloads the DMG - only the release's asset list is read,
# to prove the URL the feed is about to name is live.
if [ "$MODE" = "--feed" ]; then
  require_gh
  require_main_branch
  gh release view "v$VERSION" > /dev/null 2>&1 \
    || { echo "no GitHub release v$VERSION — cut it with: $(basename "$0") $VERSION"; exit 1; }
  FEED_DMG_NAME="Autowright-$VERSION-darwin-$ARCH.dmg"
  gh release view "v$VERSION" --json assets -q '.assets[].name' \
    | grep -qx "$FEED_DMG_NAME" \
    || { echo "release v$VERSION has no asset $FEED_DMG_NAME - the feed would name a dead URL"; exit 1; }
  FEED_DMG_URL="$(release_dmg_url "$VERSION")"
  write_feed "$VERSION" "$FEED_DMG_URL"
  write_downloads "darwin-$ARCH" "$VERSION" "$FEED_DMG_URL"
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

  # ---- publish the GitHub release (tags the pushed commit, uploads the DMG) ----
  DMG="$ROOT/build/Autowright-$VERSION-darwin-$ARCH.dmg"
  [ -f "$DMG" ] || { echo "DMG missing after build: $DMG"; exit 1; }
  echo "· creating GitHub release v$VERSION"
  gh release create "v$VERSION" "$DMG" \
    --title "v$VERSION" --generate-notes

  # ---- update feed (SPEC §3): Squirrel.Mac JSON for this arch, raw from GitHub ----
  # Written only after the release exists, so the feed never points at a URL
  # that isn't live yet. Same three functions the --feed recovery mode runs.
  DMG_URL="$(release_dmg_url "$VERSION")"
  write_feed "$VERSION" "$DMG_URL"
  write_downloads "darwin-$ARCH" "$VERSION" "$DMG_URL"
  push_feed "$VERSION"

  # ---- Homebrew cask (SPEC §3): bump the tap, last, once the release is live ----
  publish_cask "$VERSION" "$DMG"
  echo "· release v$VERSION published"
fi
