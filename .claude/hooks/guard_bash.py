#!/usr/bin/env python3
"""PreToolUse guard for Bash and PowerShell: block commands touching the
repo's scripts/, windows-scripts/, or linux-scripts/ directories (developer-only) or the
repo-root knowledge.md (generated dev-only doc). Scoped to exactly those
repo-root paths — same-named files or directories anywhere else pass through.
Both path separators are recognized (PowerShell commands use backslashes)."""
import json
import os
import re
import sys

data = json.load(sys.stdin)
cmd = (data.get("tool_input") or {}).get("command") or ""
root = os.environ.get("CLAUDE_PROJECT_DIR", "").rstrip("/\\")

# A path token counts only when it starts a shell word: beginning of the
# command or after whitespace/quote/=/;/&/|/(/</>/backtick — never mid-path.
SEP = r'(^|[\s"\'=;&|(<>`])'
ENDCHARS = r'[\s"\';&|)<>`]'
END = "(" + ENDCHARS + "|$)"

MSG_SCRIPTS = (
    "Blocked: the scripts/, windows-scripts/, and linux-scripts/ directories are developer-only "
    "— agents must never run these scripts. The developer runs them by hand in "
    "a terminal."
)
MSG_KNOWLEDGE = (
    "Blocked: knowledge.md is a generated, developer-only doc — agents must "
    "not read, edit, or use it. SPEC.md is the source of truth."
)

DIRS = r"(?:scripts|windows-scripts|linux-scripts)"

# The repo root as a regex where either path separator matches — commands may
# spell the same path with / or \ regardless of OS.
ROOT_RE = r"[/\\]".join(re.escape(p) for p in re.split(r"[/\\]", root)) if root else ""


def refs_scripts() -> bool:
    if re.search(SEP + r"(\.[/\\])?" + DIRS + r"[/\\]", cmd, re.IGNORECASE):
        return True
    if re.search(r"\bcd\s+\.?[/\\]?" + DIRS + r"([/\\]|[\s;&|]|$)", cmd, re.IGNORECASE):
        return True
    if ROOT_RE and re.search(
        ROOT_RE + r"[/\\]" + DIRS + r"([/\\]|" + ENDCHARS + "|$)", cmd, re.IGNORECASE
    ):
        return True
    return False


def refs_knowledge() -> bool:
    if re.search(SEP + r"(\.[/\\])?knowledge\.md" + END, cmd, re.IGNORECASE):
        return True
    if ROOT_RE and re.search(
        ROOT_RE + r"[/\\]knowledge\.md" + END, cmd, re.IGNORECASE
    ):
        return True
    return False


if refs_scripts():
    print(MSG_SCRIPTS, file=sys.stderr)
    sys.exit(2)
if refs_knowledge():
    print(MSG_KNOWLEDGE, file=sys.stderr)
    sys.exit(2)
