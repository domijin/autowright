# scripts/commit.sh on Windows (§18): commit all uncommitted changes with an
# AI-generated message. Uses claude (opus 5) to summarize the staged diff, then
# commits. Does not push.
# Developer-only: agents must never run this script.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail([string]$message) {
    Write-Host $message
    exit 1
}

$top = git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0 -or -not $top) { Fail 'not inside a git repository' }

# Windows PowerShell 5.1 defaults mangle non-ASCII diff content in both
# directions: $OutputEncoding (the stdin pipe to claude) is ASCII, and native
# output is read in the OEM codepage. UTF-8 for the duration; the console
# encoding is restored on exit (.ps1 scripts share the calling PowerShell
# process).
$prevConsole = [Console]::OutputEncoding
$utf8 = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = $utf8
[Console]::OutputEncoding = $utf8

Push-Location $top
try {
    if (-not (git status --porcelain)) {
        Write-Host 'No uncommitted changes.'
        exit 0
    }

    git add -A
    if ($LASTEXITCODE -ne 0) { Fail "git add failed (exit $LASTEXITCODE)" }

    $stat = (git diff --cached --stat) -join "`n"
    $diff = (git diff --cached) -join "`n"

    $prompt = @"
Write a git commit message for the following changes.
First line: concise summary under 72 characters, imperative mood.
Keep the message short: at most 2-3 sentences total, including the summary line.
Output only the commit message, nothing else. **Never** add any co-contribute to the message.

File stats:
$stat

Diff:
$diff
"@

    # prompt on stdin, not as an argument — Windows caps a process command line
    # at ~32K characters, which a real diff overflows
    $message = ($prompt | claude --model claude-opus-5 -p) -join "`n"
    if ($LASTEXITCODE -ne 0) { Fail "claude failed (exit $LASTEXITCODE)" }

    # The model sometimes wraps the message in markdown code fences; drop those
    # lines, then any leading blank lines.
    $message = (($message -split "`r?`n" | Where-Object { $_ -notmatch '^\s*```' }) -join "`n").Trim("`r", "`n")

    if ($message -notmatch '\S') { Fail 'Failed to generate commit message.' }

    Write-Host 'Commit message:'
    Write-Host '---'
    Write-Host $message
    Write-Host '---'

    git commit -m $message
    if ($LASTEXITCODE -ne 0) { Fail "git commit failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
    [Console]::OutputEncoding = $prevConsole
}
