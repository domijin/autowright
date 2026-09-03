#!/usr/bin/env bash
# Draft the next docs/CHANGELOG.md section (§17 changelog format, §18).
#
# Finds the last released version (the newest "## v" heading; its git tag must
# exist), gathers every change since it - commit subjects and bodies, the range
# diffstat, and uncommitted work - and asks Claude (Opus 5) to write the
# user-facing bullet list in the house voice. Inserts the new
# "## v<version> - <today>" section above the previous newest one and prints it.
# The section is a draft: curate it by hand before release.sh cuts the version.
# Run by hand, or by release.sh <version> when its changelog gate finds no section
# for the version (it drafts, then stops for curation).
#
# Developer-only: agents must never run this script.
#
#   ./scripts/update-changelog.sh <version>      e.g. ./scripts/update-changelog.sh 0.8.3

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

CHANGELOG="docs/CHANGELOG.md"

usage() {
  echo "usage: $(basename "$0") <version>"
  exit 2
}

[ $# -eq 1 ] || usage
VERSION="${1#v}"
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' \
  || { echo "invalid version: '$1' (expected MAJOR.MINOR.PATCH[-prerelease])"; exit 2; }

command -v claude > /dev/null || { echo "claude CLI not found."; exit 1; }
[ -f "$CHANGELOG" ] || { echo "missing $CHANGELOG"; exit 1; }

LAST="$(grep -Em1 '^## v' "$CHANGELOG" | sed -E 's/^## v([^ ]+).*/\1/' || true)"
[ -n "$LAST" ] || { echo "no '## v' heading in $CHANGELOG"; exit 1; }
git rev-parse -q --verify "refs/tags/v$LAST" > /dev/null \
  || { echo "tag v$LAST (newest changelog heading) not found - run: git fetch --tags"; exit 1; }

if grep -Eq "^## v${VERSION//./\\.}( |\$)" "$CHANGELOG"; then
  echo "$CHANGELOG already has a '## v$VERSION' entry"
  exit 1
fi

# Same ordering rule as release.sh semver_gt: numeric base compared first; a
# release beats its own prereleases, prereleases compare lexically.
python3 - "$VERSION" "$LAST" << 'PY' \
  || { echo "version $VERSION is not higher than the last release $LAST"; exit 1; }
import sys
def parts(v):
    base, _, pre = v.partition("-")
    return tuple(int(x) for x in base.split(".")), pre
(a, apre), (b, bpre) = parts(sys.argv[1]), parts(sys.argv[2])
ok = a > b or (a == b and bpre != "" and (apre == "" or apre > bpre))
sys.exit(0 if ok else 1)
PY

LOG="$(git log --no-merges --pretty='* %s%n%b' "v$LAST..HEAD" | head -c 60000)"
RANGE_STAT="$(git diff --stat "v$LAST..HEAD" | head -c 10000)"
DIRTY="$(git status --porcelain | head -c 4000)"
DIRTY_STAT="$(git diff --stat HEAD | head -c 10000)"
[ -n "$LOG$DIRTY" ] || { echo "no changes since v$LAST"; exit 1; }

# The two newest sections, as voice examples for the model.
EXAMPLES="$(awk '/^## /{n++} n>2{exit} n>=1' "$CHANGELOG")"

RAW="$(claude --model claude-opus-5 -p << EOF
Write the release-notes bullets for Autowright v$VERSION from the changes below.

Output ONLY bullet lines, each starting with "- ". No heading, no code fences,
no blank lines, no commentary before or after. Write for end users of the app:
features, UI changes, and fixes in plain language, never a commit dump. Skip
purely internal changes (tests, refactors, spec or docs edits, build tooling)
unless they change what users see. Merge related changes into one bullet. Use
plain hyphens; never use an em dash. Match the voice and level of detail of
these recent sections:

$EXAMPLES

Commits since v$LAST (newest first; * marks each subject):

$LOG

Diffstat for the range:

$RANGE_STAT

Uncommitted changes in the working tree (also part of this release):

$DIRTY

$DIRTY_STAT
EOF
)"

# Drop fence and blank lines, swap any em dash for a plain hyphen, trim
# trailing whitespace; then every surviving line must be a "- " bullet.
BULLETS="$(printf '%s\n' "$RAW" \
  | sed -e '/^```/d' -e '/^[[:space:]]*$/d' -e $'s/\xe2\x80\x94/-/g' -e 's/[[:space:]]*$//')"
[ -n "$BULLETS" ] || { echo "claude returned no output"; exit 1; }
if printf '%s\n' "$BULLETS" | grep -Eqv '^- '; then
  echo "unexpected model output (every line must be a '- ' bullet):"
  printf '%s\n' "$BULLETS"
  exit 1
fi

DATE="$(date +%Y-%m-%d)"
BULLETS="$BULLETS" VERSION="$VERSION" DATE="$DATE" CHANGELOG="$CHANGELOG" python3 - << 'PY'
import os, pathlib
path = pathlib.Path(os.environ["CHANGELOG"])
lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
at = next((i for i, line in enumerate(lines) if line.startswith("## ")), len(lines))
section = "## v{VERSION} - {DATE}\n\n{BULLETS}\n\n".format(**os.environ)
path.write_text("".join(lines[:at]) + section + "".join(lines[at:]), encoding="utf-8")
PY

echo "added to $CHANGELOG:"
echo
echo "## v$VERSION - $DATE"
echo
printf '%s\n' "$BULLETS"
echo
echo "draft only - curate by hand before running ./scripts/release.sh $VERSION"
