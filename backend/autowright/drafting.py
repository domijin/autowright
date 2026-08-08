"""Agent drafting pipeline (§8): two calls — write the spec, then build the steps.

Call 1 (create): framework instructions + available agents + available secrets +
build instructions + the user's request → spec.md; step code never travels here.
Call 2 (create/sync; sync starts here): framework instructions + build
instructions + the spec → manifest.yaml (params, triggers) + step files.
`chat` makes one call of its own shape (§11 chat column): the same context stack
plus the agent's NOTES, the recent CONVERSATION, the RECENT RUNS (test/draft/
version output with log tails, assembled by the API layer), the package install
state, and the current steps — and the RESPONSE SHAPE decides the outcome: any
subset of spec.md / instructions.md / notes.md / actions.yaml blocks is a
rewrite-plus-actions (validated per block), plain prose is an answer, a blocker
envelope blocks. Each envelope-shaped call is
followed by deterministic validation with one automatic repair round; a valid
===BLOCKED=== envelope instead ends the job in the terminal `blocked` state with
the agent's blocker list (§8).
"""
from __future__ import annotations

import ast
import logging
import re
import signal
import threading
import time
import uuid
from pathlib import Path

import yaml

from . import harness, packages as pkglib, reqlog, schedule
from .imports_check import ALLOWED_IMPORTS, disallowed_imports
from .specmd import blocks_to_md, md_to_blocks
from .storage import SECRET_REF_RE

log = logging.getLogger("autowright.drafting")

PARAM_KINDS = {"toggle", "list", "kv", "number", "text"}
STEP_FILE_RE = re.compile(r"^(\d{2})-[a-z0-9][a-z0-9-]*\.py$")
FILE_MARK_RE = re.compile(r"^===FILE: (.+?)===\s*$", re.M)
BLOCKED_MARK_RE = re.compile(r"^===BLOCKED===\s*$", re.M)
END_MARK_RE = re.compile(r"^===END===[ \t]*$", re.M)
FENCE_OPEN_RE = re.compile(r"^```[\w+.-]*$")

# §8 prompt texts live as markdown next to the code so they can be read and
# edited without touching Python: framework-instructions.md travels with EVERY
# drafting call (role, envelope, SDK, §6 policies); default-build-instructions.md seeds
# `instructions` for new automations (users edit or delete freely — it versions like
# any instructions). The per-call TASK directives below stay in Python because
# they define the exact envelope the validators parse.
_INSTRUCTIONS_DIR = Path(__file__).parent / "instructions"
CONTRACT_PREAMBLE = (_INSTRUCTIONS_DIR / "framework-instructions.md").read_text(encoding="utf-8")
DEFAULT_INSTRUCTIONS = (_INSTRUCTIONS_DIR / "default-build-instructions.md").read_text(encoding="utf-8")

# §8: every prompt section opens with a `=== NAME ===` header — one dialect
# throughout, visually distinct from the envelope's ===FILE:/===END=== markers.
_FRAMEWORK_SECTION = "=== FRAMEWORK INSTRUCTIONS ===\n" + CONTRACT_PREAMBLE

# ---------- prompts ----------

SPEC_TASK = """=== TASK ===
Write the SPEC from the USER REQUEST above. Return exactly one file block, spec.md — the full spec: markdown (# title first, then ## sections, - bullets, paragraphs) written for the user in plain words — no code, no yaml, no file names. Shape and tone, for example:

===FILE: spec.md===
# Track new manga chapters

## What it does
- Every morning at 8, check each manga page on my list for a new chapter.
- Only genuinely new chapters count — reprints and reissues don't.

## What I see
- A notification naming the new chapters, only on days something new appeared.
- The result lists each new chapter with its title and date.
===END==="""

STEPS_TASK = """=== TASK ===
Build the automation that implements the SPEC below, following the BUILD INSTRUCTIONS. Derive the triggers, every parameter (each with a default), and the steps from the SPEC — and add any trigger or parameter you judge the automation is missing (see Triggers and Parameters above; message-trigger details come from the SPEC only). Return manifest.yaml plus one file block per step — no spec.md:

===FILE: manifest.yaml===
name: Suggested automation name        # create mode only
description: One-line description
note: One-line version note for the history menu
params:                                # each param MUST carry a default
  - { name: snake_case_name, kind: toggle|list|kv|number|text, label: ..., help: ..., default: ... }
packages:                              # extra PyPI packages beyond the allowed list (see Allowed imports);
  - { pip: pandas, import: pandas }    # bare distribution name, NO version; omit the key when none are needed
triggers:                              # see Triggers above; omit the whole key when the automation needs no trigger (manual / menu bar only)
  - cron: "0 8 * * *"                  # optional timezone: IANA zone, only when the spec names one
  - { imessage: "+15551234567" }       # sender handle from the SPEC only; optional pattern
  - { discord: "1234567890", secret: BOT_TOKEN_NAME }   # channel id + granted token secret from the SPEC only; optional pattern / mention / author (sender filter: numeric user id or list of them)
  - app_start: true                    # executes when the app starts
steps:                                 # ordered; file names NN-name.py, two-digit, gapless from 01;
                                       # timeout: seconds the step may run before it is stopped (see Timeouts above);
                                       # no_timeout: true = no limit, only when asked for — never combined with timeout;
                                       # retries: automatic re-attempts when the step fails (1-10, see Retries above);
                                       # infinite_retries: true = retry until success, only for persistent/listening
                                       # steps — never combined with retries;
                                       # secrets: granted secret names the step uses (omit when none);
                                       # agents: granted agent names an agent step may call,
                                       # first = agent.ask default (omit to use the automation's default)
  - { file: 01-fetch.py, name: ..., description: ..., timeout: 60, secrets: [API_TOKEN] }
  - { file: 02-judge.py, name: ..., description: ..., timeout: 180, agent: true, why: one line — why judgment is needed,
      agents: [Agent name] }
===FILE: 01-fetch.py===
(python source)
===END===

Return every file named in steps."""

# §8 call-2 closing section: restates the response shape after the (possibly
# long) context so the format sits at the end of the prompt as well as in STEPS_TASK.
STEPS_REMINDER = ("=== RESPONSE REMINDER ===\n"
                  "Respond with manifest.yaml plus one file block per step "
                  "(no spec.md), ending with ===END=== exactly.")

CHAT_TASK = """=== TASK ===
Decide what the USER REQUEST above needs:

- A question → answer it in plain markdown prose written for the user — no file blocks, no envelope, no yaml. Ground the answer in the SPEC, the CURRENT steps, and the RECENT RUNS shown above; when something isn't decided there, say so plainly.

- A change to the automation → return file blocks, any subset of these four (prose before the first block is shown to the user as your message):

===FILE: spec.md===
The FULL updated spec — markdown (# title first, then ## sections, - bullets, paragraphs) written for the user in plain words, no code, no yaml, no file names. Keep everything the request doesn't touch unchanged. Never return step files — the steps are rebuilt from the spec later.
===FILE: instructions.md===
The FULL updated build instructions — only when the user asks to change their standing rules.
===FILE: notes.md===
The FULL updated notes — your own working knowledge for this automation: selectors, endpoints, quirks, approaches that failed and why. Update it whenever you learn something a later build or fix should know; keep it a terse cheat sheet, not a log.
===FILE: actions.yaml===
sync: true                  # rebuild the steps from the spec right away (after your rewrites apply)
test: true                  # run a draft test once the steps match the spec (implies sync when they don't)
test_values: { url: "…" }   # parameter values for that test only (name → value, names from CURRENT parameters)
name: New automation name   # rename the automation (current name under AUTOMATION above)
description: One-line description  # rewrite its one-line description
undo: true                  # restore the draft to before the last request — exact revert, one level
===END===

Only the keys shown are valid in actions.yaml; include only what the request calls for, and omit the block when no action is needed. When the user asks you to fix, change and verify, or "make it work", prefer returning the rewrite together with `sync: true` (and `test: true` when a test would prove it) so the user doesn't have to press the buttons. When the user asks to undo or revert your last change ("undo that", "put it back"), return `undo: true` ALONE — no other action keys and no rewrite blocks (an accompanying prose message is fine); the editor restores the draft exactly, and tells the user when there is nothing left to undo — never hand-rewrite the documents back from memory instead. You cannot enable agents or secrets, and you cannot save or create the automation — suggest those in prose; the user does them.

Use the blocker envelope only when a requested change is genuinely impossible."""


def spec_as_md(current: dict | None) -> str:
    """The spec may arrive as §5 blocks (stored versions) or as a raw markdown
    string (the §19 `spec` body field / in-editor draft) — yield markdown either way."""
    spec_val = (current or {}).get("spec") or []
    return spec_val if isinstance(spec_val, str) else blocks_to_md(spec_val)


def _grants_yaml(entries: list[dict]) -> str:
    """§8: grant lists render as yaml (agents: name/description/harness/model,
    secrets: name/description) so the drafting agent can weigh each entry when
    deciding which agents and secrets the automation should use."""
    if not entries:
        return "none"
    return yaml.safe_dump(entries, sort_keys=False, allow_unicode=True).strip()


def _common_context(current: dict | None, grants: dict) -> list[str]:
    """Grants + build instructions — the steps call's shared context (call 1
    builds its own sections in its own order)."""
    parts = [
        "=== GRANTS FOR THIS AUTOMATION ===\n"
        "Enabled agents (yaml: name, description, harness, model; agent: true steps "
        "allowed only if nonempty):\n"
        f"{_grants_yaml(grants.get('agents', []))}\n"
        "Allowed secrets (yaml: name, description; reference by secrets.NAME):\n"
        f"{_grants_yaml(grants.get('secrets', []))}\n"
        "One rule decides which agents and secrets each step uses: when the SPEC or BUILD "
        "INSTRUCTIONS name a choice, follow them; otherwise pick the most appropriate "
        "entries yourself."
    ]
    # §8: instructions travel with every call as context only — never returned by
    # the agent. In create mode the API seeds DEFAULT_INSTRUCTIONS when none given.
    if (current or {}).get("instructions"):
        parts.append("=== BUILD INSTRUCTIONS (the user's standing rules — follow them; "
                     "never return this file) ===\n" + current["instructions"].strip())
    return parts


def build_spec_prompt(user_text: str | None, current: dict | None,
                      grants: dict) -> str:
    """§8 call 1 (create) — framework instructions + available agents + available
    secrets + build instructions + user request → spec.md. Role first, task last.
    Step code never travels here; the closing TASK just asks to write the spec
    from the request."""
    parts = [
        _FRAMEWORK_SECTION,
        "=== AVAILABLE AGENTS (yaml: name, description, harness, model — they can power "
        "judgment steps when the automation is later built; don't promise AI judgment in "
        "the spec unless this list is nonempty. When the user or the BUILD INSTRUCTIONS "
        "name which agent to use, follow that; otherwise pick the most appropriate "
        "entries yourself) ===\n"
        f"{_grants_yaml(grants.get('agents', []))}",
        "=== AVAILABLE SECRETS (yaml: name, description — same rule: a secret named by "
        "the user or the BUILD INSTRUCTIONS wins; otherwise pick by judgment) ===\n"
        f"{_grants_yaml(grants.get('secrets', []))}",
    ]
    if (current or {}).get("instructions"):
        parts.append("=== BUILD INSTRUCTIONS (the user's standing rules — follow them; "
                     "never return this file) ===\n" + current["instructions"].strip())
    # §8: a resumed create draft can hold notes from an earlier steps call — a
    # blocker-driven re-create shouldn't rediscover what that round learned.
    if notes := _notes_section(current, " — context only, never returned here"):
        parts.append(notes)
    if user_text:
        parts.append("=== USER REQUEST ===\n" + user_text.strip())
    parts.append(SPEC_TASK)
    return "\n\n".join(parts)


def _step_head(s: dict) -> str:
    """CURRENT-step section header — carries the step's §4.1 time limit and
    retry budget so a sync rewrite can preserve a deliberately long/unlimited
    or retrying step."""
    extra = (", no timeout" if s.get("no_timeout")
             else f", timeout: {s['timeout']}s" if s.get("timeout") else "")
    extra += (", infinite retries" if s.get("infinite_retries")
              else f", retries: {s['retries']}" if s.get("retries") else "")
    return f"{s.get('file')} ({s.get('name')}{extra})"


def _conversation_lines(chat: list | None) -> str:
    """§8 chat-call CONVERSATION section: the most recent §11 thread entries as
    context — user, answer, and error text (clipped), one-line summaries for
    rewrite/blockers/system entries (a blocker keeps its clipped details, so a
    build-diagnosis failure's specifics reach later chats). Transient progress
    entries never travel."""
    lines: list[str] = []
    for e in (chat or [])[-20:]:
        if not isinstance(e, dict):
            continue
        kind = e.get("kind")
        text = str(e.get("text") or "").strip()
        if kind == "user":
            lines.append("user: " + clip_response(text, 2000, 500))
        elif kind == "answer":
            lines.append("assistant: " + clip_response(text, 2000, 500))
        elif kind == "rewrite":
            lines.append("[spec updated] " + text)
        elif kind == "blockers":
            bl = "; ".join(
                f"{b.get('reason', '')} — {b.get('fix', '')}"
                + (f" ({clip_response(str(b['details']).strip(), 400, 0)})"
                   if b.get("details") else "")
                for b in (e.get("blockers") or []) if isinstance(b, dict))
            lines.append("[blockers] " + (bl or text))
        elif kind == "system":
            lines.append("[status] " + text)
        elif kind == "error":
            lines.append("[error] " + clip_response(text, 2000, 500))
    return "\n".join(lines)


def _notes_section(current: dict | None, hint: str) -> str | None:
    """§8 NOTES — the §4.1 agent-owned working-knowledge doc, sent on every
    call that has one so later work doesn't retry disproved approaches."""
    notes = ((current or {}).get("notes") or "").strip()
    if not notes:
        return None
    return ("=== NOTES (notes.md — your own working knowledge from earlier sessions, "
            "dead ends included; trust it before rediscovering" + hint + ") ===\n" + notes)


def build_chat_prompt(user_text: str | None, current: dict | None,
                      grants: dict, chat: list | None = None,
                      runs: str | None = None,
                      pkg_state: list[dict] | None = None) -> str:
    """§8 chat call — the ordinary context stack (framework + grants + build
    instructions) plus the agent's NOTES, the recent CONVERSATION, the RECENT
    RUNS (assembled by the API layer — test/draft/version output with log
    tails), the declared-package state, the AUTOMATION identity (name + description,
    editable only via actions.yaml), the in-editor spec, the CURRENT parameters
    (the names test_values keys must use), and every current step, closed by
    the USER REQUEST and the shape-deciding TASK."""
    parts = [_FRAMEWORK_SECTION, *_common_context(current, grants)]
    if notes := _notes_section(current, " — you may return an updated notes.md"):
        parts.append(notes)
    convo = _conversation_lines(chat)
    if convo:
        parts.append("=== CONVERSATION (recent messages in this editing session — "
                     "context only, never returned) ===\n" + convo)
    if runs:
        parts.append("=== RECENT RUNS (newest first — test/draft/version executions of this "
                     "automation with their output; a run marked 'ran older steps' predates "
                     "the current draft) ===\n" + runs)
    if pkg_state:
        parts.append("=== PACKAGES (declared §6.2 packages and their install state) ===\n"
                     + yaml.safe_dump(pkg_state, sort_keys=False, allow_unicode=True).strip())
    # §8 AUTOMATION — the §4.1 user-owned identity, so a rename/redescribe
    # action edits what is really there (never returned as a file; actions only).
    name = str((current or {}).get("name") or "").strip()
    desc = str((current or {}).get("description") or "").strip()
    if name or desc:
        parts.append("=== AUTOMATION (current name and description — change them only "
                     "via actions.yaml `name` / `description`) ===\n"
                     + yaml.safe_dump({"name": name, "description": desc},
                                      sort_keys=False, allow_unicode=True).strip())
    parts.append("=== SPEC (spec.md) ===\n" + spec_as_md(current))
    # §8 CURRENT parameters — definitions + in-editor values; the only names
    # actions.yaml `test_values` keys may use.
    if params := (current or {}).get("params"):
        parts.append("=== CURRENT parameters (definitions and values — actions.yaml "
                     "test_values keys must be these names) ===\n"
                     + yaml.safe_dump(params, sort_keys=False, allow_unicode=True).strip())
    # §8 CURRENT triggers — context only, so chat can answer "when does this
    # run?"; triggers change through a sync or the automation page, never chat.
    trigs = (current or {}).get("triggers")
    if trigs is not None:
        parts.append(
            "=== CURRENT triggers (context only — the schedule and message triggers "
            "as they exist today, `off` and one-shot `time` entries marked; triggers "
            "change through a sync or the automation page, never through chat files) ===\n"
            + (yaml.safe_dump([_trigger_ref(t) for t in trigs],
                              sort_keys=False, allow_unicode=True).strip()
               if trigs else "none"))
    for s in (current or {}).get("steps", []):
        parts.append(f"=== CURRENT step {_step_head(s)} ===\n{s.get('code', '')}")
    parts.append("=== USER REQUEST ===\n" + (user_text or "").strip())
    parts.append(CHAT_TASK)
    return "\n\n".join(parts)


def _trigger_ref(t: dict) -> dict:
    """Stored §4.3 trigger → the §8 rule-9 drafted dialect, for the sync
    reference. `time` renders as { time: at } and `off` is marked — both are
    context only, never part of what the agent may draft."""
    k = t.get("kind")
    if k == "cron":
        d = {"cron": t.get("expression"), **({"timezone": t["timezone"]} if t.get("timezone") else {})}
    elif k == "imessage":
        d = {"imessage": t.get("from"),
             **({"pattern": t["pattern"]} if t.get("pattern") else {})}
    elif k == "discord":
        d = {"discord": t.get("channel"), "secret": t.get("secret"),
             **({"pattern": t["pattern"]} if t.get("pattern") else {}),
             **({"mention": True} if t.get("mention") else {}),
             **({"author": t["author"]} if t.get("author") else {})}
    elif k == "app_start":
        d = {"app_start": True}
    else:
        d = {"time": t.get("at")}
    if not t.get("enabled", True):
        d["off"] = True
    return d


def build_steps_prompt(mode: str, spec_md: str, current: dict | None,
                       grants: dict) -> str:
    """§8 call 2 — framework + build instructions + spec → manifest + step files."""
    parts = [_FRAMEWORK_SECTION, STEPS_TASK, *_common_context(current, grants)]
    if notes := _notes_section(
            current, " — context; you may return an updated notes.md beside the manifest"):
        parts.append(notes)
    if mode == "create":
        parts.append("=== MODE ===\ncreate — include a suggested `name` in manifest.yaml.")
    else:
        parts.append(f"=== MODE ===\n{mode} — the CURRENT files below are today's implementation; "
                     "rewrite them to match the SPEC, changing no more than the spec demands.")
        if current:
            parts.append("=== CURRENT param definitions ===\n"
                         + yaml.safe_dump(current.get("params", []), sort_keys=False))
            trigs = current.get("triggers")
            if trigs is not None:
                # §8: reference only — the §4.3 merge keeps user-added entries;
                # the agent drafts against this to see what already exists.
                parts.append(
                    "=== CURRENT triggers (reference — user-owned; your drafted crons "
                    "replace the cron entries below, message/app-start entries only add "
                    "when not already present; `time` and `off` entries are context, "
                    "never drafted) ===\n"
                    + (yaml.safe_dump([_trigger_ref(t) for t in trigs],
                                      sort_keys=False, allow_unicode=True).strip()
                       if trigs else "none"))
            for s in current.get("steps", []):
                parts.append(f"=== CURRENT step {_step_head(s)} ===\n{s.get('code', '')}")
    parts.append("=== SPEC (spec.md — implement this exactly) ===\n" + (spec_md or "").strip())
    parts.append(STEPS_REMINDER)
    return "\n\n".join(parts)


DIAGNOSE_TASK = """=== TASK ===
Your previous response failed validation twice — the VALIDATION ERRORS above are what the backend rejected. Diagnose why this automation could not be built as specified and respond with exactly one blocker envelope — no file blocks. For each blocker, `reason` names what went wrong in plain words and `fix` is the spec change or clarification that would let the build succeed:

===BLOCKED===
blockers:
  - reason: One sentence naming the problem.
    fix: The suggested resolution, in plain words.
    details: Optional longer explanation.
===END===
"""


def clip_response(text: str, head: int = 60_000, tail: int = 20_000) -> str:
    """§8: repair/diagnosis prompts embed the previous raw response clipped —
    a huge bad response must not blow the model's context on the retry. The
    §5 app-log framing always logs it whole."""
    if len(text) <= head + tail:
        return text
    omitted = len(text) - head - tail
    return text[:head] + f"\n… [{omitted} chars omitted] …\n" + text[-tail:]


# ---------- envelope + validation ----------

def _strip_fence(content: str) -> str:
    """§8: a block whose whole content sits inside one markdown code fence loses
    the fence lines — models love wrapping step code in ```python."""
    lines = content.splitlines()
    body = [i for i, l in enumerate(lines) if l.strip()]
    if len(body) < 2:
        return content
    first, last = body[0], body[-1]
    if FENCE_OPEN_RE.fullmatch(lines[first].strip()) and lines[last].strip() == "```":
        return "\n".join(lines[first + 1:last]).strip("\n")
    return content


def parse_envelope(text: str) -> dict[str, str]:
    """Blocks by filename. Prose before the first marker is ignored. A block runs to
    the next ===FILE: marker or a line-anchored ===END===, whichever comes first —
    the canonical envelope closes once at the very end, but per-block ===END===
    terminators (and prose between blocks) parse identically (§8). No ===END=== at
    or after the last block → truncated."""
    if not END_MARK_RE.search(text):
        raise ValueError("response is truncated — no ===END=== marker")
    marks = list(FILE_MARK_RE.finditer(text))
    if not marks:
        raise ValueError("no ===FILE: blocks in the response")
    if not END_MARK_RE.search(text, marks[-1].end()):
        raise ValueError("response is truncated — no ===END=== marker")
    files: dict[str, str] = {}
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        endm = END_MARK_RE.search(text, m.end(), end)
        if endm:
            end = endm.start()
        content = _strip_fence(text[m.end():end].strip("\n"))
        files[m.group(1).strip()] = content + "\n"
    return files


def parse_blockers(text: str) -> list[dict] | None:
    """§8 blocker envelope. None when the response isn't one; the parsed nonempty
    blocker list when it is; ValueError when it is one but malformed (which sends
    it through the normal repair round like any invalid response)."""
    m = BLOCKED_MARK_RE.search(text)
    if not m:
        return None
    endm = END_MARK_RE.search(text, m.end())
    if not endm:
        raise ValueError("blocker response is truncated — no ===END=== marker")
    if FILE_MARK_RE.search(text):
        raise ValueError("a blocker envelope must not carry file blocks — return one or the other")
    try:
        data = yaml.safe_load(text[m.end(): endm.start()])
    except yaml.YAMLError as e:
        raise ValueError(f"blocker envelope doesn't parse as yaml: {e}")
    blockers = data.get("blockers") if isinstance(data, dict) else None
    if not isinstance(blockers, list) or not blockers:
        raise ValueError("the blocker envelope needs a nonempty `blockers` list")
    out = []
    for b in blockers:
        if not isinstance(b, dict) or not str(b.get("reason") or "").strip() \
                or not str(b.get("fix") or "").strip():
            raise ValueError("every blocker needs a nonempty reason and fix")
        out.append({"reason": str(b["reason"]).strip(), "fix": str(b["fix"]).strip(),
                    "details": str(b.get("details") or "").strip()})
    return out


def validate_spec(files: dict[str, str]) -> tuple[dict, list[str]]:
    """§8 call-1 validation. Returns ({md, blocks}, errors)."""
    errors: list[str] = []
    if "spec.md" not in files:
        errors.append("spec.md is missing")
    extras = sorted(f for f in files if f != "spec.md")
    if extras:
        errors.append(f"the spec call must return spec.md and nothing else (got {extras})")
    if errors:
        return {}, errors
    md = files["spec.md"]
    blocks = md_to_blocks(md)
    if not blocks or blocks[0].get("kind") != "h1" or not blocks[0].get("text", "").strip():
        errors.append("spec.md must start with a # title")
    if not any(b.get("kind") in ("p", "li") for b in blocks):
        errors.append("spec.md has no body — describe the automation")
    if errors:
        return {}, errors
    return {"md": md, "blocks": blocks}, []


CHAT_FILES = ("spec.md", "instructions.md", "notes.md", "actions.yaml")


def validate_actions(text: str, param_names: list[str] | None = None) -> tuple[dict, list[str]]:
    """§8 actions.yaml — the chat call's follow-up actions. Returns the
    validated mapping in the §4.1 camelCase serialization, or errors. Grants
    and save/create are never actions (§8 hard boundaries) — an unknown key is
    a validation error, not a silent drop. `param_names` (when given) are the
    only keys `test_values` may use — a misremembered name is a validation
    error that feeds the repair round, never a test that silently runs with
    defaults."""
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        return {}, [f"actions.yaml doesn't parse as yaml: {e}"]
    if not isinstance(data, dict):
        return {}, ["actions.yaml must be a yaml mapping"]
    errors: list[str] = []
    out: dict = {}
    for k in data:
        if k not in ("sync", "test", "test_values", "name", "description", "undo"):
            errors.append(f"actions.yaml: unknown key {k!r}")
    # §8: undo is exclusive — undoing and acting/rewriting in one response is
    # contradictory (the rewrite-block half is enforced in validate_chat)
    if "undo" in data and len(data) > 1:
        errors.append("actions.yaml: undo must be the only key — it cannot be "
                      "combined with other actions")
    for k in ("sync", "test", "undo"):
        if k in data:
            if data[k] is not True:
                errors.append(f"actions.yaml: {k} must be true when present")
            else:
                out[k] = True
    if "test_values" in data:
        if not isinstance(data["test_values"], dict):
            errors.append("actions.yaml: test_values must be a mapping of param name → value")
        else:
            # A response that also requests a sync may name params the rebuild
            # will create — only a test against today's steps is checkable.
            if param_names is not None and data.get("sync") is not True:
                bad = sorted(str(k) for k in data["test_values"] if k not in param_names)
                if bad:
                    errors.append(
                        f"actions.yaml: test_values names unknown params {bad} — "
                        f"the automation's params are {sorted(param_names) or 'none'}")
            out["testValues"] = data["test_values"]
    for k in ("name", "description"):
        if k in data:
            if not isinstance(data[k], str) or not data[k].strip():
                errors.append(f"actions.yaml: {k} must be a nonempty string")
            else:
                out[k] = data[k].strip()
    if not errors and not out:
        errors.append("actions.yaml carries no actions — omit the block instead")
    return ({}, errors) if errors else (out, [])


def validate_chat(raw: str, files: dict[str, str],
                  param_names: list[str] | None = None) -> tuple[dict, list[str]]:
    """§8 chat-call response with file blocks → terminal payload
    { answer?, spec?, instructions?, notes?, actions? }. Prose before the first
    marker is the accompanying chat message; only the four CHAT_FILES names
    are allowed. `param_names` gates actions.yaml test_values keys."""
    errors: list[str] = []
    extras = sorted(f for f in files if f not in CHAT_FILES)
    if extras:
        errors.append("a chat response may only return spec.md, instructions.md, "
                      f"notes.md, and actions.yaml — never step files (got {extras})")
    payload: dict = {}
    if "spec.md" in files:
        spec, errs = validate_spec({"spec.md": files["spec.md"]})
        errors += errs
        if not errs:
            payload["spec"] = spec["blocks"]
    if "instructions.md" in files:
        payload["instructions"] = files["instructions.md"].strip()
    if "notes.md" in files:
        payload["notes"] = files["notes.md"].strip()
    if "actions.yaml" in files:
        # A spec rewrite means the params will be re-derived — test_values
        # keys are only checkable when today's params stay authoritative.
        actions, errs = validate_actions(files["actions.yaml"],
                                         None if "spec.md" in files else param_names)
        errors += errs
        # §8: undo is exclusive of rewrites too — restoring the draft and
        # rewriting it in one response is contradictory.
        if actions.get("undo") and any(f in files for f in ("spec.md", "instructions.md", "notes.md")):
            errors.append("actions.yaml: undo cannot be combined with spec.md, "
                          "instructions.md, or notes.md rewrites")
        if not errs:
            payload["actions"] = actions
    if errors:
        return {}, errors
    m = FILE_MARK_RE.search(raw)
    answer = raw[:m.start()].strip() if m else ""
    if answer:
        payload["answer"] = answer
    return payload, []


def validate_steps(files: dict[str, str], grants: dict | None = None) -> tuple[dict, list[str]]:
    """§8 call-2 validation. Returns (draft dict sans spec, errors). `grants`
    holds the call's agent/secret grant entries — per-step `agents`/`secrets`
    lists must name entries from them."""
    errors: list[str] = []
    if "manifest.yaml" not in files:
        errors.append("manifest.yaml is missing")
    if "spec.md" in files:
        errors.append("the steps call must not return spec.md — the spec is already settled")
    if errors:
        return {}, errors
    try:
        manifest = yaml.safe_load(files["manifest.yaml"]) or {}
    except yaml.YAMLError as e:
        return {}, [f"manifest.yaml doesn't parse: {e}"]
    if not isinstance(manifest, dict):
        return {}, ["manifest.yaml must be a mapping"]

    params = manifest.get("params") or []
    for p in params:
        if not isinstance(p, dict) or "name" not in p or "kind" not in p:
            errors.append(f"param entry malformed: {p!r}")
            continue
        if p["kind"] not in PARAM_KINDS:
            errors.append(f"param {p['name']}: unknown kind {p['kind']}")
        if "default" not in p:
            errors.append(f"param {p['name']}: missing default")
        if p["kind"] == "number" and "min" not in p:
            p["min"] = 0

    # §6.2/§8: declared packages — {pip, import}, bare distribution name,
    # beyond stdlib/curated only. Their import names extend the step allowlist below.
    raw_pkgs = manifest.get("packages") or []
    norm_pkgs: list[dict] = []
    if not isinstance(raw_pkgs, list):
        errors.append("packages must be a list of { pip, import } entries")
        raw_pkgs = []
    for e in raw_pkgs:
        if not isinstance(e, dict) or not e.get("pip") or not e.get("import"):
            errors.append(f"packages entry malformed: {e!r} — need {{ pip: name, import: module }}")
            continue
        name, imp = str(e["pip"]).strip(), str(e["import"]).strip()
        if not pkglib.PIP_NAME_RE.match(name):
            errors.append(f"packages: {name!r} must be a bare distribution name — no version specifier")
        if not imp.isidentifier():
            errors.append(f"packages: import {imp!r} isn't a valid module name")
        elif imp in ALLOWED_IMPORTS:
            errors.append(f"packages: {imp} is already available — don't declare it")
        norm_pkgs.append({"pip": name, "import": imp})
    pkg_imports = [p["import"] for p in norm_pkgs]

    steps = manifest.get("steps") or []
    if not steps:
        errors.append("steps must be nonempty")
    listed = [s.get("file", "") for s in steps if isinstance(s, dict)]
    # §8: call 2 may return an optional notes.md beside the manifest — the
    # agent's updated working-knowledge doc, excluded from step-file matching.
    blocks = [f for f in files if f not in ("manifest.yaml", "notes.md")]
    if sorted(listed) != sorted(blocks):
        errors.append(f"steps[].file and file blocks don't match 1:1 (manifest: {listed}, blocks: {blocks})")
    for i, fname in enumerate(listed, 1):
        m = STEP_FILE_RE.match(fname or "")
        if not m:
            errors.append(f"step file {fname!r} doesn't follow NN-name.py")
        elif int(m.group(1)) != i:
            errors.append(f"step file {fname!r} out of order — expected {i:02d}-…")
    # §8 rule 7/6: per-step agents/secrets must name granted entries — the
    # grants yaml is what the agent chose from, so anything else is a typo.
    granted_agents = {g.get("name") for g in (grants or {}).get("agents", [])}
    granted_secrets = {g.get("name") for g in (grants or {}).get("secrets", [])}
    for s in steps:
        if not isinstance(s, dict):
            continue
        if s.get("agent") and not (s.get("why") or "").strip():
            errors.append(f"step {s.get('name')}: agent: true requires a why")
        ags = s.get("agents")
        if ags is not None:
            if not s.get("agent"):
                errors.append(f"step {s.get('name')}: agents is only valid on agent: true steps")
            elif not isinstance(ags, list) or not all(isinstance(x, str) for x in ags):
                errors.append(f"step {s.get('name')}: agents must be a list of granted agent names")
            else:
                for x in ags:
                    if x not in granted_agents:
                        errors.append(f"step {s.get('name')}: agent {x!r} isn't among the granted agents")
        # §8 rule 8: short explicit timeout, or the explicit no-limit marker —
        # never both, never a sentinel value.
        t = s.get("timeout")
        if t is not None and (isinstance(t, bool) or not isinstance(t, int) or t <= 0):
            errors.append(f"step {s.get('name')}: timeout must be a positive integer of seconds")
        nt = s.get("no_timeout")
        if nt is not None and not isinstance(nt, bool):
            errors.append(f"step {s.get('name')}: no_timeout must be true")
        if t is not None and nt:
            errors.append(f"step {s.get('name')}: timeout and no_timeout can't be combined")
        # §8 rule 8: the retry pair mirrors the timeout pair — a capped positive
        # count, or the explicit never-stop marker, never both.
        r = s.get("retries")
        if r is not None and (isinstance(r, bool) or not isinstance(r, int)
                              or r <= 0 or r > 10):
            errors.append(f"step {s.get('name')}: retries must be an integer from 1 to 10")
        ir = s.get("infinite_retries")
        if ir is not None and not isinstance(ir, bool):
            errors.append(f"step {s.get('name')}: infinite_retries must be true")
        if r is not None and ir:
            errors.append(f"step {s.get('name')}: retries and infinite_retries can't be combined")
        secs = s.get("secrets")
        if secs is not None:
            if not isinstance(secs, list) or not all(isinstance(x, str) for x in secs):
                errors.append(f"step {s.get('name')}: secrets must be a list of allowed secret names")
            else:
                for x in secs:
                    if x not in granted_secrets:
                        errors.append(f"step {s.get('name')}: secret {x!r} isn't among the allowed secrets")

    norm_steps = []
    for s in steps:
        if not isinstance(s, dict):
            continue
        code = files.get(s.get("file", ""), "")
        try:
            ast.parse(code)
            for mod in disallowed_imports(code, pkg_imports):
                errors.append(f"{s.get('file')}: import {mod} isn't allowed")
        except SyntaxError as e:
            errors.append(f"{s.get('file')}: syntax error — {e.msg} (line {e.lineno})")
        t = s.get("timeout")
        r = s.get("retries")
        norm_steps.append({
            "file": s.get("file"), "name": s.get("name", ""), "description": s.get("description", ""),
            "agent": bool(s.get("agent")), "why": s.get("why", ""),
            "agents": list(s.get("agents") or []) if s.get("agent") else [],
            "secrets": list(s.get("secrets") or []),
            **({"timeout": t} if isinstance(t, int) and not isinstance(t, bool) and t > 0 else {}),
            **({"no_timeout": True} if s.get("no_timeout") is True else {}),
            **({"retries": r} if isinstance(r, int) and not isinstance(r, bool)
               and 0 < r <= 10 else {}),
            **({"infinite_retries": True} if s.get("infinite_retries") is True else {}),
            "code": code,
        })
    trigs = manifest.get("triggers") or []
    norm_trigs: list[dict] = []
    if not isinstance(trigs, list):
        errors.append("triggers must be a list of trigger entries (see the Triggers section)")
    else:
        for t in trigs:
            # §8 rule 9 dialect: cron / imessage / discord / app_start —
            # one-shot `time` triggers are never drafted.
            if not isinstance(t, dict):
                errors.append(f"triggers entry {t!r} must be an object")
                continue
            keys = set(t)
            if keys == {"cron"} or keys == {"cron", "timezone"}:
                entry = {"kind": "cron", "expression": str(t["cron"]).strip(), "enabled": True}
                if "timezone" in t:
                    entry["timezone"] = str(t["timezone"])
                    if err := schedule.tz_error(entry["timezone"]):
                        errors.append(f"triggers: {err}")
                        continue
                try:
                    schedule.parse_cron(entry["expression"])
                    norm_trigs.append(entry)
                except schedule.CronError as e:
                    errors.append(f"triggers: {e}")
            elif "imessage" in keys and keys <= {"imessage", "pattern"}:
                entry = {"kind": "imessage",
                         "from": schedule.normalize_handle(str(t["imessage"])), "enabled": True,
                         **({"pattern": str(t["pattern"]).strip()} if t.get("pattern") else {})}
                if err := schedule.validate_trigger(entry):
                    errors.append(f"triggers: {err}")
                else:
                    norm_trigs.append(entry)
            elif "discord" in keys and keys <= {"discord", "secret", "pattern", "mention", "author"}:
                # author: scalar accepted as shorthand for a one-element list (§8)
                au = t.get("author")
                au = au if isinstance(au, list) else [au] if au else []
                entry = {"kind": "discord", "channel": str(t["discord"]).strip(),
                         "secret": str(t.get("secret", "")).strip(), "enabled": True,
                         **({"pattern": str(t["pattern"]).strip()} if t.get("pattern") else {}),
                         **({"mention": True} if t.get("mention") is True else {}),
                         **({"author": schedule.normalize_authors(au)} if au else {})}
                if err := schedule.validate_trigger(entry):
                    errors.append(f"triggers: {err}")
                else:
                    norm_trigs.append(entry)
            elif t == {"app_start": True}:
                if any(x["kind"] == "app_start" for x in norm_trigs):
                    errors.append("triggers: only one app_start entry")
                else:
                    norm_trigs.append({"kind": "app_start", "enabled": True})
            else:
                errors.append(
                    f"triggers entry {t!r} must be {{ cron: expression[, timezone] }}, "
                    f"{{ imessage: handle[, pattern] }}, "
                    f"{{ discord: channel-id, secret: NAME[, pattern, mention, author] }}, "
                    f"or app_start: true")
    if errors:
        return {}, errors
    # No triggers key -> no triggers (manual / menu bar only).
    draft = {
        "triggers": norm_trigs,
        "name": manifest.get("name"),
        "description": manifest.get("description", ""),
        "note": manifest.get("note", ""),
        "params": params,
        "packages": norm_pkgs,
        "steps": norm_steps,
        "secretReferences": sorted({m for st in norm_steps for m in SECRET_REF_RE.findall(st["code"])}),
    }
    if (files.get("notes.md") or "").strip():
        draft["notes"] = files["notes.md"].strip()
    return draft, []


# ---------- background jobs ----------

class DraftJobs:
    """§19 POST /drafts — the two-call pipeline as a background job, one
    automatic repair round per call (§8)."""

    def __init__(self) -> None:
        self.jobs: dict[str, dict] = {}
        self._lock = threading.Lock()

    def start(self, mode: str, agent: dict, user_text: str | None,
              current: dict | None, grants: dict,
              chat_history: list | None = None, runs: str | None = None,
              pkg_state: list[dict] | None = None) -> str:
        job_id = str(uuid.uuid4())
        stage = ("Working on the request" if mode == "chat"
                 else "Writing the spec" if mode == "create"
                 else "Generating the steps")
        job = {"id": job_id, "status": "building", "stage": stage, "detail": None,
               "events": [], "error": None, "draft": None, "mode": mode,
               "_cancel": False, "_proc": {}}
        with self._lock:
            # Terminal jobs hold full draft payloads (all step code) — keep only
            # a recent tail so the process doesn't grow for its whole lifetime.
            terminal = [k for k, v in self.jobs.items() if v["status"] != "building"]
            for k in terminal[:-20]:
                del self.jobs[k]
            self.jobs[job_id] = job
        t = threading.Thread(target=self._run,
                             args=(job, mode, agent, user_text, current, grants,
                                   chat_history, runs, pkg_state),
                             daemon=True)
        t.start()
        return job_id

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            j = self.jobs.get(job_id)
        if not j:
            return None
        out = {k: v for k, v in j.items() if not k.startswith("_")}
        # The job thread appends to `events` while this serializes — copy.
        out["events"] = list(j["events"])
        return out

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            j = self.jobs.get(job_id)
            # A cancel racing completion must not clobber a terminal
            # done/blocked/failed job — the Review page would lose the result.
            if not j or j["status"] != "building":
                return False
            j["_cancel"] = True
            j["status"] = "cancelled"
        proc = j["_proc"].get("proc")
        if proc and proc.poll() is None:
            # The whole session group (§8 "cancelling the job kills the harness
            # process") — CLIs spawn helpers that terminate alone won't reach.
            harness.kill_group(proc, signal.SIGTERM)
        return True

    def _settle(self, job: dict, status: str, **fields) -> bool:
        """The only terminal transition — building → done/blocked/failed under
        the lock, so a cancel that already won can never be overwritten (and
        vice versa)."""
        with self._lock:
            if job["status"] != "building":
                return False
            job["status"] = status
            job.update(fields)
            return True

    def _run(self, job: dict, mode: str, agent: dict, user_text: str | None,
             current: dict | None, grants: dict, chat_history: list | None,
             runs: str | None = None, pkg_state: list[dict] | None = None) -> None:
        try:
            cancelled = self._pipeline(job, mode, agent, user_text, current, grants,
                                       chat_history, runs, pkg_state)
            if cancelled:
                return
        except harness.HarnessError as e:
            self._settle(job, "failed", error=str(e))
        except Exception as e:  # noqa: BLE001
            # Anything else must still end the job — a thread dying here would
            # leave it "building" forever and the UI spinning.
            log.exception("drafting job %s crashed", job["id"])
            self._settle(job, "failed", error=f"drafting failed unexpectedly: {e}")

    def _pipeline(self, job: dict, mode: str, agent: dict, user_text: str | None,
                  current: dict | None, grants: dict,
                  chat_history: list | None = None, runs: str | None = None,
                  pkg_state: list[dict] | None = None) -> bool:
        """Makes the mode's calls; sets job status. Returns True when cancelled mid-flight."""
        if mode == "chat":
            return self._chat_call(job, agent, user_text, current, grants, chat_history,
                                   runs, pkg_state)

        spec_blocks = None
        if mode == "create":
            # ---- call 1: the spec ----
            spec, _errors, blockers, diagnosed = self._call_with_repair(
                job, agent, build_spec_prompt(user_text, current, grants),
                validate_spec, "spec")
            if job["_cancel"]:
                return True
            if blockers:
                return self._block(job, "spec", blockers, None, diagnosed=diagnosed)
            spec_md, spec_blocks = spec["md"], spec["blocks"]
            # §11 drafting-on-Review: the validated spec rides the job
            # payload the moment call 1 lands, so the spec card can render
            # it while the steps call is still working (§19).
            job["draft"] = {"spec": spec_blocks}
        else:
            # sync: the provided spec IS the input — no spec call
            spec_md = spec_as_md(current)

        # ---- call 2: steps, params, schedule ----
        self._stage(job, "Generating the steps")
        draft, _errors, blockers, diagnosed = self._call_with_repair(
            job, agent, build_steps_prompt(mode, spec_md, current, grants),
            lambda files: validate_steps(files, grants), "steps")
        if job["_cancel"]:
            return True
        if blockers:
            # Hand call 1's spec along (create) so the §11 Blocker panel can
            # amend it and rebuild — on sync the caller already holds the spec.
            return self._block(job, "steps",
                               blockers, {"spec": spec_blocks} if spec_blocks else None,
                               diagnosed=diagnosed)

        if draft.get("packages") and not job["_cancel"]:
            # §8: ensure the declared packages right after the steps land — the
            # user learns about an install failure on the edit page, not when a
            # trigger fires. A failure never fails the job (§6.2): the statuses
            # ride the draft payload and render in the §11 Packages card.
            self._stage(job, "Installing the packages")
            draft["packages"] = pkglib.ensure(
                draft["packages"],
                on_progress=lambda spec: self._event(job, f"Installing {spec}…"))
            if job["_cancel"]:
                return True

        draft["spec"] = spec_blocks  # None on sync — the spec never changes there
        if mode == "create":
            # Hand the (seeded or user-given) instructions back so the
            # Review card arrives pre-filled — agents never return them.
            draft["instructions"] = (current or {}).get("instructions") or ""
        self._settle(job, "done", draft=draft)
        return False

    def _chat_call(self, job: dict, agent: dict, user_text: str | None,
                   current: dict | None, grants: dict,
                   chat_history: list | None, runs: str | None = None,
                   pkg_state: list[dict] | None = None) -> bool:
        """§8 chat call: one call whose response shape decides the outcome —
        plain prose is an answer, file blocks are rewrites/actions
        (spec.md / instructions.md / notes.md / actions.yaml — validated, one
        repair round, then diagnosis), a blocker envelope blocks
        (blockedAt: chat). Returns True when cancelled mid-flight."""
        prompt = build_chat_prompt(user_text, current, grants, chat_history,
                                   runs=runs, pkg_state=pkg_state)
        # §8: actions.yaml test_values keys must name the draft's params
        pnames = [str(p.get("name")) for p in (current or {}).get("params") or []
                  if p.get("name")]
        raw = self._invoke(job, agent, prompt, on_chunk=self._chat_cb(job))
        if job["_cancel"]:
            return True
        outcome, payload = self._chat_shape(raw, pnames)
        if outcome == "invalid" and not job["_cancel"]:
            round1 = {"errors": payload, "response": raw}
            repair = (prompt + "\n\n=== YOUR PREVIOUS RESPONSE ===\n" + clip_response(raw)
                      + "\n\n=== VALIDATION ERRORS — fix these and resend ===\n- "
                      + "\n- ".join(payload))
            self._event(job, "The response didn't validate — asking for a corrected one…")
            raw2 = self._invoke(job, agent, repair,
                                on_chunk=self._chat_cb(job, prefix="Second try — "))
            if job["_cancel"]:
                return True
            outcome, payload = self._chat_shape(raw2, pnames)
            if outcome == "invalid" and not job["_cancel"]:
                diag = self._diagnose(job, agent, prompt, raw2, payload)
                self._record_failure(job, agent, "chat", "diagnosed", prompt,
                                     [round1, {"errors": payload, "response": raw2}], diag)
                return self._block(job, "chat", diag, None, diagnosed=True)
            if not job["_cancel"]:
                self._record_failure(job, agent, "chat",
                                     "blocked" if outcome == "blocked" else "repaired",
                                     prompt, [round1], None)
        if job["_cancel"]:
            return True
        if outcome == "blocked":
            return self._block(job, "chat", payload, None)
        if not payload:
            return self._fail(job, "The agent returned an empty answer.", [])
        self._settle(job, "done", draft=payload)
        return False

    @staticmethod
    def _chat_shape(raw: str, param_names: list[str] | None = None):
        """Classify a chat-call response (§8): ("blocked", blockers) |
        ("done", payload) | ("invalid", errors) — payload is the terminal
        { answer?, spec?, instructions?, notes?, actions? } dict (empty for an empty
        response). Only envelope-shaped responses can be invalid — prose is
        always an answer."""
        try:
            blockers = parse_blockers(raw)
            if blockers is not None:
                return "blocked", blockers
        except ValueError as e:
            return "invalid", [str(e)]
        if not FILE_MARK_RE.search(raw):
            text = raw.strip()
            return "done", ({"answer": text} if text else {})
        try:
            files = parse_envelope(raw)
        except ValueError as e:
            return "invalid", [str(e)]
        payload, errors = validate_chat(raw, files, param_names)
        if errors:
            return "invalid", errors
        return "done", payload

    def _invoke(self, job: dict, agent: dict, prompt: str, on_chunk=None) -> str:
        """harness.invoke with the job's proc/cancel wiring and the §8 one-retry
        policy: a transient failure (timeout, nonzero exit) is retried once
        after a short pause; a second failure — or a non-retryable one (CLI not
        installed, unknown harness) — propagates. Drafting calls run
        web-enabled (§6 web-read tools); runtime agent.ask calls never do."""
        try:
            return harness.invoke(agent, prompt, proc_holder=job["_proc"],
                                  on_chunk=on_chunk, on_tool=self._tool_cb(job),
                                  should_abort=lambda: job["_cancel"],
                                  web=True)
        except harness.HarnessError as e:
            if not getattr(e, "retryable", False) or job["_cancel"]:
                raise
            log.warning("agent call failed (%s) — retrying once", e)
            self._event(job, "The agent call failed — retrying once…")
            time.sleep(2)
            if job["_cancel"]:
                raise
            return harness.invoke(agent, prompt, proc_holder=job["_proc"],
                                  on_chunk=on_chunk, on_tool=self._tool_cb(job),
                                  should_abort=lambda: job["_cancel"],
                                  web=True)

    def _call_with_repair(self, job: dict, agent: dict, prompt: str,
                          validator, call: str) -> tuple[dict, list[str], list[dict] | None, bool]:
        """One harness call + one automatic repair round against `validator`,
        then — when the repair is still invalid — one §8 build-diagnosis call
        that turns the failure into blockers (returned with diagnosed=True), so
        a validation double-failure never fails the job. A valid §8 blocker
        envelope is terminal — returned as-is, no repair. `_cancel` is checked
        before every invoke: a cancel between calls must never let a fresh
        full-timeout harness call start (nothing would kill it). `call` names
        the pipeline call ("spec"/"steps") for the §5 build-failure record."""
        if job["_cancel"]:
            return {}, [], None, False
        raw = self._invoke(job, agent, prompt, on_chunk=self._progress_cb(job))
        if job["_cancel"]:
            return {}, [], None, False
        result, errors, blockers = self._parse_validate(raw, validator)
        if errors and not job["_cancel"]:
            round1 = {"errors": errors, "response": raw}
            repair = (prompt + "\n\n=== YOUR PREVIOUS RESPONSE ===\n" + clip_response(raw)
                      + "\n\n=== VALIDATION ERRORS — fix these and resend the full envelope ===\n- "
                      + "\n- ".join(errors))
            self._event(job, "The response didn't validate — asking for a corrected one…")
            raw2 = self._invoke(job, agent, repair,
                                on_chunk=self._progress_cb(job, prefix="Second try — "))
            if job["_cancel"]:
                return {}, [], None, False
            result, errors, blockers = self._parse_validate(raw2, validator)
            if errors and not job["_cancel"]:
                diag = self._diagnose(job, agent, prompt, raw2, errors)
                self._record_failure(job, agent, call, "diagnosed", prompt,
                                     [round1, {"errors": errors, "response": raw2}], diag)
                return {}, [], diag, True
            if not job["_cancel"]:
                # The repair round settled the call — a fixed envelope or a
                # blocker envelope — but round 1 still failed validation:
                # exactly the near-miss the record exists for (§5).
                self._record_failure(job, agent, call,
                                     "blocked" if blockers else "repaired",
                                     prompt, [round1], None)
        return result, errors, blockers, False

    @staticmethod
    def _record_failure(job: dict, agent: dict, call: str, outcome: str, prompt: str,
                        rounds: list[dict], blockers: list[dict] | None) -> None:
        """§5 build-failure record (developerMode-gated, best-effort): one file per
        drafting call whose response failed validation — material for improving
        the §8 agent instructions later."""
        reqlog.write_build_failure(
            reqlog.stamp(), job["mode"], call, agent.get("harness") or "?",
            agent.get("model") or "configured default", outcome, prompt, rounds, blockers)

    def _diagnose(self, job: dict, agent: dict, prompt: str, raw: str,
                  errors: list[str]) -> list[dict]:
        """§8 build diagnosis: one blocker-envelope-only call explaining why the
        build failed validation twice; on any failure of the diagnosis itself,
        a deterministic fallback blocker built from the validation errors."""
        self._event(job, "The response didn't validate twice — analyzing what went wrong…")
        diagnose = (prompt + "\n\n=== YOUR PREVIOUS RESPONSE ===\n" + clip_response(raw)
                    + "\n\n=== VALIDATION ERRORS ===\n- " + "\n- ".join(errors)
                    + "\n\n" + DIAGNOSE_TASK)
        blockers = None
        try:
            raw3 = self._invoke(job, agent, diagnose)
            if not job["_cancel"]:
                blockers = parse_blockers(raw3)
        except (harness.HarnessError, ValueError) as e:
            log.warning("build-diagnosis call failed: %s", e)
        if not blockers:
            blockers = [{
                "reason": "The draft didn't build — the agent's response failed validation twice.",
                "fix": "Simplify or clarify the spec, or try a different drafting agent, then rebuild.",
                "details": "\n".join(errors[:8]),
            }]
        return blockers

    def _progress_cb(self, job: dict, prefix: str = ""):
        """§8 live progress: accumulate the streamed response and derive the
        job's `detail` line from its ===FILE: markers. Marker changes update
        immediately and append a count-less `events` milestone (`Thinking…`
        never does); line-count growth throttles to one update per second,
        detail-only."""
        state = {"text": "", "shape": None, "last": 0.0, "total": None}

        def cb(chunk: str) -> None:
            if job["_cancel"] or job["status"] != "building":
                return
            state["text"] += chunk
            text = state["text"]
            marks = list(FILE_MARK_RE.finditer(text))
            if not marks:
                shape = label = detail = "Thinking…"
            else:
                m = marks[-1]
                fname = m.group(1).strip()
                shape = fname
                if fname == "manifest.yaml":
                    label = detail = "Writing the manifest — name, triggers, parameters, step list"
                else:
                    lines = len(text[m.end():].strip("\n").splitlines())
                    if fname == "spec.md":
                        name = "the spec"
                    else:
                        total = self._steps_total(state, text, marks)
                        sm = STEP_FILE_RE.match(fname)
                        name = (f"step {int(sm.group(1))} of {total} — {fname}"
                                if sm and total else fname)
                    count = f" · {lines} line{'s' if lines != 1 else ''}" if lines else ""
                    label = f"Writing {name}"
                    detail = label + count
            if prefix:
                label = prefix + label[0].lower() + label[1:]
                detail = prefix + detail[0].lower() + detail[1:]
            now = time.monotonic()
            if shape != state["shape"]:
                state["shape"] = shape
                state["last"] = now
                if shape != "Thinking…":
                    self._append_event(job, label)
                self._detail(job, detail)
            elif now - state["last"] >= 1.0:
                state["last"] = now
                self._detail(job, detail)

        return cb

    # §8 chat-call streamed-marker labels — one per allowed block name.
    _CHAT_LABELS = {"spec.md": "Writing the spec",
                    "instructions.md": "Writing the build instructions",
                    "notes.md": "Updating the notes",
                    "actions.yaml": "Choosing next actions"}

    def _chat_cb(self, job: dict, prefix: str = ""):
        """§8 chat-call live progress: `Thinking…` until text arrives, then a
        per-marker label (`Writing the spec · N lines`, `Updating the notes ·
        N lines`, …) once a ===FILE: marker has streamed, else `Writing the
        answer · N lines` — shape changes update immediately and append a
        count-less `events` milestone (`Thinking…` never does), line-count
        growth throttles to one update per second, detail-only."""
        state = {"text": "", "shape": None, "last": 0.0}

        def cb(chunk: str) -> None:
            if job["_cancel"] or job["status"] != "building":
                return
            state["text"] += chunk
            text = state["text"]
            marks = list(FILE_MARK_RE.finditer(text))
            if marks:
                fname = marks[-1].group(1).strip()
                shape = fname
                label = self._CHAT_LABELS.get(fname, f"Writing {fname}")
                if fname == "actions.yaml":
                    detail = label
                else:
                    lines = len(text[marks[-1].end():].strip("\n").splitlines())
                    detail = f"{label} · {lines} line{'s' if lines != 1 else ''}"
            elif text.strip():
                shape = "answer"
                label = "Writing the answer"
                lines = len(text.strip().splitlines())
                detail = f"{label} · {lines} line{'s' if lines != 1 else ''}"
            else:
                shape = label = detail = "Thinking…"
            if prefix:
                label = prefix + label[0].lower() + label[1:]
                detail = prefix + detail[0].lower() + detail[1:]
            now = time.monotonic()
            if shape != state["shape"]:
                state["shape"] = shape
                state["last"] = now
                if shape != "Thinking…":
                    self._append_event(job, label)
                self._detail(job, detail)
            elif now - state["last"] >= 1.0:
                state["last"] = now
                self._detail(job, detail)

        return cb

    @staticmethod
    def _steps_total(state: dict, text: str, marks: list) -> int | None:
        """Step count from the streamed manifest block, once a later marker
        proves the block is complete. Parsed once, cached; None until then."""
        if state["total"] is None:
            for i, m in enumerate(marks[:-1]):  # only closed blocks
                if m.group(1).strip() == "manifest.yaml":
                    try:
                        manifest = yaml.safe_load(text[m.end():marks[i + 1].start()])
                        steps = manifest.get("steps") if isinstance(manifest, dict) else None
                        state["total"] = len(steps) if isinstance(steps, list) and steps else None
                    except yaml.YAMLError:
                        pass
                    break
        return state["total"]

    def _stage(self, job: dict, label: str) -> None:
        job["stage"] = label
        job["detail"] = None

    def _detail(self, job: dict, text: str) -> None:
        job["detail"] = text

    def _event(self, job: dict, text: str) -> None:
        """§8 activity feed: append a milestone and make it the live detail."""
        self._append_event(job, text)
        job["detail"] = text

    @staticmethod
    def _append_event(job: dict, text: str) -> None:
        ev = job["events"]
        ev.append({"time": time.time(), "text": text})
        # §8: capped at the newest 200 — a chatty stream must not grow the
        # job (and every poll response) for the call's whole lifetime.
        if len(ev) > 200:
            del ev[: len(ev) - 200]

    def _tool_cb(self, job: dict):
        """§8 activity feed: one event per streamed {name, input} tool use —
        `Reading <url>…` / `Searching the web for “<query>”…` / `Using <name>…`."""
        def cb(tool: dict) -> None:
            if job["_cancel"] or job["status"] != "building":
                return
            name = tool.get("name") or ""
            inp = tool.get("input") if isinstance(tool.get("input"), dict) else {}
            url = str(inp.get("url") or "")[:120]
            query = str(inp.get("query") or "")[:120]
            if name == "WebFetch" and url:
                text = f"Reading {url}…"
            elif name == "WebSearch" and query:
                text = f"Searching the web for “{query}”…"
            else:
                text = f"Using {name}…" if name else "Using a tool…"
            self._event(job, text)

        return cb

    def _fail(self, job: dict, msg: str, errors: list[str]) -> bool:
        self._settle(job, "failed", error=msg, errorDetail=errors[:8])
        return False

    def _block(self, job: dict, at: str, blockers: list[dict], draft: dict | None,
               diagnosed: bool = False) -> bool:
        # §8: a valid blocker envelope is its own terminal outcome, not a
        # failure. `diagnosed` marks build-diagnosis blockers (§19) so the UI
        # words the panel as a build failure, not an agent refusal.
        self._settle(job, "blocked", blockedAt=at, blockers=blockers, draft=draft,
                     diagnosed=diagnosed)
        return False

    @staticmethod
    def _parse_validate(raw: str, validator) -> tuple[dict, list[str], list[dict] | None]:
        try:
            blockers = parse_blockers(raw)
            if blockers is not None:
                return {}, [], blockers
            files = parse_envelope(raw)
        except ValueError as e:
            return {}, [str(e)], None
        result, errors = validator(files)
        return result, errors, None


draft_jobs = DraftJobs()
