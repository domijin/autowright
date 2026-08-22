#!/usr/bin/env bash
# scripts/commit.sh on Linux (§18): commit all uncommitted changes with an
# AI-generated message. Uses claude (opus 5) to summarize the staged diff, then
# commits. Does not push.
# Developer-only: agents must never run this script.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ -z "$(git status --porcelain)" ]]; then
  echo "No uncommitted changes."
  exit 0
fi

git add -A

diff="$(git diff --cached)"
stat="$(git diff --cached --stat)"

prompt="Write a git commit message for the following changes.
First line: concise summary under 72 characters, imperative mood.
Keep the message short: at most 2-3 sentences total, including the summary line.
Output only the commit message, nothing else. **Never** add any co-contribute to the message.

File stats:
$stat

Diff:
$diff"

# prompt on stdin, not as an argument — Linux caps a single argv string at
# MAX_ARG_STRLEN (128 KiB), which a real diff overflows
message="$(printf '%s\n' "$prompt" | claude --model claude-opus-5 -p)"

# The model sometimes wraps the message in markdown code fences; drop those
# lines, then any leading blank lines.
message="$(printf '%s\n' "$message" | sed '/^[[:space:]]*```/d' | sed '/./,$!d')"

if [[ -z "${message//[[:space:]]/}" ]]; then
  echo "Failed to generate commit message." >&2
  exit 1
fi

echo "Commit message:"
echo "---"
echo "$message"
echo "---"

git commit -m "$message"
