# Publish the Windows half of a release (SPEC §3/§18). The mac half stays with
# scripts/release.sh (bash + BSD sed, run from macOS): that script owns the
# version bump, the tag and the GitHub release. A release that ships both
# platforms is two script runs against one tag/version — release.sh first, then
# this one on the Windows machine.
#
#   .\windows-scripts\release.ps1
#
# What it does, in order:
#   1. read the repo-root VERSION and require the GitHub release v<version> to
#      exist already (created by release.sh);
#   2. build the distributable via windows-scripts\prod.ps1 (which re-checks
#      that every version site matches VERSION and prints the §3 UNSIGNED
#      warning when no certificate is configured);
#   3. upload the installer + its blockmap to that release;
#   4. rewrite release\win32-x86_64\latest.yml from the build output — the
#      §3 electron-updater feed — pointing it at the released binaries, update
#      the win32-x86_64 entry in docs\downloads.json (the website's download
#      index), then commit + push those files, exactly as release.sh does for
#      the mac feed.
#
# Running it is always the developer's act: it is the only thing here that
# commits, and it commits nothing but the feed.
$ErrorActionPreference = 'Stop'

$ROOT = Split-Path -Parent $PSScriptRoot

function Fail([string]$message) {
    Write-Host $message
    exit 1
}

function Invoke-Native([string]$what, [scriptblock]$block) {
    & $block
    if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit $LASTEXITCODE)" }
}

# ---- prerequisites ---------------------------------------------------------
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Fail 'gh CLI not found — install it from https://cli.github.com and run: gh auth login'
}
gh auth status *> $null
if ($LASTEXITCODE -ne 0) { Fail 'gh CLI not authenticated — run: gh auth login' }

$VERSION = (Get-Content (Join-Path $ROOT 'VERSION') -Raw).Trim()
if (-not $VERSION) { Fail "empty $ROOT\VERSION" }
$TAG = "v$VERSION"

gh release view $TAG *> $null
if ($LASTEXITCODE -ne 0) {
    Fail "no GitHub release $TAG — cut it from macOS first: ./scripts/release.sh $VERSION"
}

# The feed commit lands on top of whatever is checked out, so the tree must be
# clean beforehand — the same rule release.sh applies before a release.
$dirty = git -C $ROOT status --porcelain
if ($dirty) { Fail 'working tree dirty — commit or stash before releasing' }

# ---- build -----------------------------------------------------------------
Write-Host "· version: $VERSION — building the Windows release"
Invoke-Native 'prod.ps1' { & (Join-Path $PSScriptRoot 'prod.ps1') }

$OUT = Join-Path $ROOT 'build\win'
$INSTALLER = Join-Path $OUT "Autowright-$VERSION-win32-x86_64.exe"
$BLOCKMAP = "$INSTALLER.blockmap"
$BUILT_YML = Join-Path $OUT 'latest.yml'
foreach ($artifact in @($INSTALLER, $BLOCKMAP, $BUILT_YML)) {
    if (-not (Test-Path $artifact)) { Fail "missing after build: $artifact" }
}

# ---- publish the binaries onto the existing release ------------------------
# --clobber so a re-run after a failed feed write replaces the assets instead
# of erroring out on the second upload.
Write-Host "· uploading the installer + blockmap to $TAG"
Invoke-Native 'gh release upload' { gh release upload $TAG $INSTALLER $BLOCKMAP --clobber }

# ---- update feed (§3): latest.yml under docs/, binaries on the release ------
# Same hosting split as the mac feed: GitHub Pages serves the yml, the release
# serves the bytes. electron-updater's generic provider resolves each file's
# `url` against the feed's base URL, and an absolute URL is taken as-is — so
# the rewrite below is all that is needed to point it at the release assets.
# Written only after the upload, so the feed never names a URL that is not live.
$OWNER_REPO = (gh repo view --json nameWithOwner -q .nameWithOwner).Trim()
if ($LASTEXITCODE -ne 0 -or -not $OWNER_REPO) { Fail 'could not read the repository name from gh' }

$INSTALLER_NAME = [System.IO.Path]::GetFileName($INSTALLER)
$DOWNLOAD_URL = "https://github.com/$OWNER_REPO/releases/download/$TAG/$INSTALLER_NAME"

$FEED_DIR = Join-Path $ROOT 'release\win32-x86_64'
New-Item -ItemType Directory -Force -Path $FEED_DIR | Out-Null
$FEED = Join-Path $FEED_DIR 'latest.yml'

$rewritten = Get-Content $BUILT_YML | ForEach-Object {
    # `path:` (top level) and `- url:` (files[]) both carry the bare file name
    # in electron-builder's output; nothing else in the yml mentions it.
    $_ -replace [regex]::Escape($INSTALLER_NAME), $DOWNLOAD_URL
}
# UTF-8 *without* a BOM: Set-Content/Out-File would add one in Windows
# PowerShell 5.1, and a BOM at the top of the feed is not YAML the updater's
# parser accepts.
[System.IO.File]::WriteAllLines($FEED, $rewritten, (New-Object System.Text.UTF8Encoding($false)))
if (-not (Select-String -Path $FEED -SimpleMatch $DOWNLOAD_URL -Quiet)) {
    Fail "latest.yml was not rewritten with the release URL — check $BUILT_YML"
}

# §17 docs/downloads.json — the website's download index: update only the
# win32-x86_64 entry, leaving the other OS legs' entries alone. Python runs
# the same merge as the bash legs (indent-2, sorted keys, LF), so the three
# release scripts never churn each other's output.
$DOWNLOADS = Join-Path $ROOT 'docs\downloads.json'
$PYMERGE = @'
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
'@
# The script goes in over stdin (`-`), not `-c`: Windows PowerShell 5.1 does
# not escape embedded double quotes when building a native command line, so a
# `-c` payload would reach Python with its string quotes stripped.
if (Get-Command py -ErrorAction SilentlyContinue) {
    Invoke-Native 'downloads.json merge' { $PYMERGE | py -3 - $DOWNLOADS 'win32-x86_64' $VERSION $DOWNLOAD_URL }
} else {
    Invoke-Native 'downloads.json merge' { $PYMERGE | python - $DOWNLOADS 'win32-x86_64' $VERSION $DOWNLOAD_URL }
}

Write-Host '· publishing update feed (release/win32-x86_64/latest.yml + docs/downloads.json)'
Invoke-Native 'git add' { git -C $ROOT add $FEED $DOWNLOADS }
$staged = git -C $ROOT status --porcelain -- $FEED $DOWNLOADS
if ($staged) {
    Invoke-Native 'git commit' { git -C $ROOT commit -q -m "Publish $TAG update feed (win32-x86_64)" }
    Invoke-Native 'git push' { git -C $ROOT push -q origin HEAD }
} else {
    Write-Host '· feed already current — nothing to commit'
}

Write-Host "· release $TAG published (win32-x86_64)"
