# Autowright SPEC — Execution lifecycle

Part of the Autowright spec. Index and § map: [SPEC.md](../SPEC.md). § numbers are global across spec files.

## 7. Execution lifecycle

- At most `maxParallel` executions at a time per automation (§4.1, default 1). Starting with every
  slot taken: toast "Already executing — one execution at a time. A trigger firing now would be
  skipped." at the default (`maxParallel` 1, no queue). When `maxParallel > 1` or
  `maxQueued > 0` the toast says what actually happens next: "The slot is busy" (`maxParallel`
  1) or "All N slots are busy" (`maxParallel` > 1), followed by "A trigger firing now would be
  queued." when `maxQueued > 0`, else "A trigger firing now would be skipped." The §6 firing queue applies to message triggers only —
  a manual start is never queued, it is refused (409) so the user can decide what to do.
- Start: execution record created with all steps queued; automation gets live id, lastStatus
  executing, lastExecutionLabel "executing…"; the execution appears at top of Executions; sidebar counts
  and menu-bar rows update live.
- Before step 1 the engine ensures the version's declared packages (§6.2): the fast
  installed-check costs milliseconds when everything is present; anything missing installs with
  a sys log line ("installing packages: `pandas`…"). An install failure fails the
  execution before any step with the package category below.
- Streaming: each step queued → executing → terminal status with duration. Executing a step
  appends an **attempt** (`n = attempts+1`) to that step; the step's status always equals its
  latest attempt's status. Each attempt streams into its own log file (§5) — the sys opener
  "▸ Step N — `<name>`", the step's own output, and its timeout/cancel/skip lines all land
  there; execution-level lines (package installs, secret failures, retry markers, the final
  failure line) go to `logs/execution.ndjson`. Then the execution gets its final status,
  duration, result object; automation gets latest/resultChip/lastExecutionLabel "Today"; toast
  summarizes. An execution whose steps include `skipped` ones but no failures finishes
  `succeeded`.
- Cancel: kills timers/processes; execution cancelled, the executing attempt and its step
  cancelled, queued steps cancelled, sys log "execution cancelled by you — nothing else will
  happen". At finalize the cancel flag marks the execution `cancelled` **only when at least
  one step was actually cancelled or left non-terminal** — a cancel that lands after the
  last step already succeeded changes nothing and the record finishes `succeeded`: the
  status reports what happened to the steps, not that a button was pressed too late.
- **Kill semantics:** each step's executor runs in its own process group
  (`start_new_session`), and timeout/cancel/skip signal the whole group — a step's children
  (Playwright browsers, subprocesses) die with it, are never orphaned, and can never hold the
  engine's log pipe open past the kill (which would strand the automation "executing").
- **Skip step:** while a step is executing, the user can skip it (§19
  `POST /executions/{id}/skip-step` with the step index — 409 unless that exact step is the
  one currently executing, closing the finished-while-clicking race). The engine kills the
  step's subprocess, marks the attempt and step `skipped` (no error recorded), writes the sys
  line "step skipped by you — continuing with the next step" to the attempt log, and
  continues with the next step. If the process exited successfully before the kill landed,
  the step stays `succeeded` (sys line "skip arrived after the step finished"). A cancel
  arriving with a pending skip wins. Skipped steps are terminal — a later retry never
  re-executes them.
- **Step retry (automatic):** a failed step attempt whose step carries a §4.1 retry budget
  (`retries: N`, or `infiniteRetries: true`) is re-executed **immediately** — the engine
  appends the next attempt and re-runs the same script; the execution and the automation stay
  `executing` throughout (the step reads `failed` only for the instant between attempts, per
  the latest-attempt rule §4.5), so nothing terminal flickers and no repeat toasts fire. The
  failed attempt keeps its error and log file; a sys line in the new attempt's log says
  "attempt N failed — retrying (M of K)" ("retrying (attempt N+1)" under `infiniteRetries`).
  The budget counts **per execution pass**: `retries: N` allows N automatic re-attempts of
  that step per pass, and a manual in-place retry (below) starts a fresh pass with a fresh
  budget — automatic and manual attempts never share a counter. `infiniteRetries` retries
  until the attempt succeeds or the user cancels/skips; its consecutive attempts are spaced
  ≥ 1 s apart (`AUTOWRIGHT_STEP_RETRY_PAUSE_S`, §15 — a deterministically-crashing script
  must not hot-loop process spawns), while finite retries run back-to-back. Cancel and Skip
  step win over a pending retry exactly as they win over a running attempt — skip marks the
  step `skipped` and moves on, spending nothing further. Only step failures retry: the
  pre-step gates (missing secret, package install) and engine-level failures are not attempts
  and never retry. Attempts beyond the newest 20 are pruned with their log files (§4.5/§5).
- **Failure diagnostics:** when a step fails, the executor reports the exception as a structured
  control event (exception type + message) alongside the traceback err lines; the engine stores
  §4.5 `error` on the record — the failing step's name, the message ("`ExcType: message`",
  redacted like any log line), and a plain-word **possible reason** when the failure matches a
  known category, null otherwise. Categories (deterministic, from exit code / exception type /
  message — never an agent call): step timed out ("The step hit its `N` s time limit.") ·
  disallowed import ("The step imports a package outside the allowed list.") · package install
  failed ("A required package couldn't be installed — check your connection, then execute
  again or retry from the edit page.") · missing secret
  ("The script references a secret that doesn't exist.") · undeclared secret — the step read
  a secret the automation allows but the step never declared or referenced, so it wasn't
  injected (§6 step scoping; the executor's message says so: "secret `NAME` wasn't injected
  into this step — steps only receive the secrets they reference in code or declare in the
  step's `secrets` list"; reason "The step reads a secret it doesn't declare — add it to the
  step's `secrets` list.") · agent call failed ("The step's agent
  call failed — the agent may be unreachable or misconfigured.") · network failure —
  connection, DNS, timeout ("A network request failed — the site may be down, blocking, or
  unreachable."; the §6 `fetch_page` refusal messages — "couldn't fetch `<url>`: …",
  "robots.txt disallows fetching `<url>`" — classify here too) · HTTP error status ("The site answered with
  an error (HTTP `nnn`)."; when no 3-digit code can be extracted from the message, the
  codeless fallback "The site answered with an error.") ·
  unexpected data shape — KeyError/IndexError/AttributeError ("The data didn't have the
  expected shape — a page or file layout may have changed."). Engine-level failures (missing
  script file, agent step with no agent) set `error` the same way. Shown on the automation
  detail page (§9.2) and the execution page.
- **Retry (in place):** a failed execution can be retried — the same execution record
  re-executes from the failed step; no new execution is created. The failed step's status
  flips back to `queued` (its attempt history stays), the execution goes `status: executing`
  with `finished_at`/`error`/chip cleared, and the engine re-enters the step loop, which
  executes exactly the steps still `queued` — succeeded and skipped steps are never
  re-executed and keep their attempts. Each executed step appends the next attempt. Same
  workspace (earlier steps' outputs are already there — nothing is copied), same result dir
  (a failed pass's stale result files may remain until steps overwrite them), accumulated
  duration (`duration_ms` sums the passes; `started_at` never changes). `execution.finished` fires
  again per pass, so the end-of-execution toast repeats — intended. Retry is allowed only on
  terminal `failed` executions and answers 409 while the automation is live, when the
  version no longer resolves, or — for a Draft execution — when the draft's steps changed
  since the record (a re-saved draft would pair old step statuses with new scripts; execute
  it fresh instead). Manual retries are uncapped and are the **only** execution-level retry —
  nothing retries a terminal execution automatically (§6); each manual pass grants the steps
  a fresh automatic step-retry budget (above).
- **Header actions** on the execution page: while executing, **Skip step** (quiet bordered,
  tooltip "Skip this step — kills it and continues with the next one"; skips the currently
  executing step) beside **Cancel**. A failed execution
  gets a quiet bordered "Execute again" (tooltip "Executes the automation again from the
  start" — a plain fresh execution) and, rightmost per the §9 header-action order, a primary
  accent **Retry** (tooltip "Retries this execution from the failed step. Steps that already
  succeeded keep their results.").
  Succeeded / cancelled / interrupted executions get only the quiet "Execute again".
- Trigger labels (derived at serialization from the stored §4.5 kinds): Manual, Menu bar,
  Cron, Once, App start, Discord, iMessage. `interrupted` covers e.g. "Mac went to sleep" — applied
  by startup recovery when a restarted backend finds stale `executing` executions; recovery
  first SIGKILLs the record's persisted step process group (`pgid`, §4.5) when that group
  still exists, so an orphaned step can't keep executing beside the record it lost. A sleep the
  backend process survives simply resumes the execution. `skipped`/`cancelled` executions may carry a
  note ("previous execution still in progress", "the queue was full (N waiting)", "waited too
  long in the queue", "cancelled before it ran", "backend restarted before this ran",
  "version vN no longer exists" — a queued entry whose admitted version is gone by its turn). The
  first two are different problems and must not share a note: "still in progress" is the
  configured skip-on-busy behaviour, while a full queue is a capacity limit the user fixes by
  raising `maxQueued` (§4.1) — the note names the cap so the row says which knob to turn. A `queued` execution (§6 firing queue) has no steps and no
  duration until it is promoted; its page shows the waiting state, its `triggerPayload`, and a
  Cancel action (see *Queued execution page* below), and promotion turns it into an ordinary
  executing record in place.
- **Queued execution page** — a `queued` record is addressable by id like any other execution
  and its page is the waiting state, not an empty version of the normal one. The header keeps
  the title row and the Queued badge, and its only action is **Cancel** (quiet danger,
  §19 `POST /executions/{id}/cancel` — the same endpoint as a running execution; the entry
  leaves the queue and finishes `skipped`). The mono metadata line drops duration and reads
  full id (copyable) · trigger · version · queued `<time>` · waiting `<elapsed>`, the elapsed
  value ticking every second while the page is open. In place of the RESULT card and the
  steps/logs card the body is one **waiting card**: the headline "Waiting for a free slot",
  its queue position among that automation's `queued` records ("2nd of 3 waiting", oldest
  first — the drain order), and the line "Every slot is busy. This runs as soon as one frees
  up." Below it, when the record carries a §4.5 `triggerPayload`, the **TRIGGER MESSAGE**
  block (shared with the ordinary execution page — see its full shape there). Promotion replaces
  the whole body with the ordinary execution page in place — no navigation, the record and the
  URL never change, and the trigger message stays visible (the ordinary page renders the same
  block), so the input that fired the run doesn't vanish the moment it starts.

**Execution page:** back link, title row with status badge and the header actions above — the
row never wraps: the automation name is a single line that shrinks with ellipsis (full name in
its tooltip), so the actions always sit on the title line at the same height as every other
page's header buttons (same rule as the §11 Review title);
below the title a mono metadata line: full execution id (copyable) · trigger · version ·
started · duration. A §4.5 `test` execution additionally shows a **"Draft test"** chip in the
title row, never shows the "(deleted)" marker (a create-mode test has no automation by
design), and hides Retry and Execute again — iteration on a draft happens from the editor's
Build & test panel; Cancel and Skip step still work while it is live. Body stacks top to bottom: the
failure notice (failed executions only), a full-width **RESULT card**, then — on executions
carrying a §4.5 `triggerPayload` — the **TRIGGER MESSAGE** block (the same block the queued
page shows), one card:
- **header line** — sender, then for Discord the origin: `in #channelName · guildName` when
  the §4.5 names are present, falling back to the raw channel id when `channelName` is null
  (the `· guildName` part is simply omitted when null — never a literal "null"/"undefined");
  an iMessage payload shows the sender alone (it has no channel). The payload's `secret` is
  never displayed.
- right-aligned on the header line, Discord only: an **"Open in Discord"** external link
  styled as a button — the same bordered ghost treatment (`.ad-btn-ghost`) as the page's other
  actions (Retry / Execute again), never plain link text or the link underline — opening
  `https://discord.com/channels/<guildId>/<channel>/<messageId>` (`@me` in place of the guild
  id when `guildId` is null — the DM form), so the raw ids earn their keep as a deep link
  instead of being printed. Omitted entirely when `messageId` is null — a §4.5 mocked-test
  payload has no real message to open.
- below, the **message time** (mono, faint), then the **message text** (mono, wrapped).

The message is the
run's input — steps read it via §6.1 — so the page keeps it visible below the outcome and above
the machinery, then a single
**execution card** that joins the **STEPS rail** (left) and the **LOGS pane** (right) with an
internal divider — one card, since the rail's selection drives the pane. Beneath the steps the
rail holds the **PARAMETERS block** — per param: label, its help description, and the §4.2
one-line summary value ("Values as used by this execution."). At the rail's bottom sits a quiet
**workspace link** — a small ghost button, "Show workspace in Finder" — opening the execution's
§5 `workspace/` dir (the scratch dir the steps ran in — for inspecting what a run left behind)
per the §4.9 Show-in-Finder rule; deliberately low-key so it never competes with the RESULT
card's Show in Finder, which is the user-facing output. The STEPS rail's rows are **selectable**: each row shows the status dot (pulsing
while executing), name, a right-aligned attempt-count chip ("×2", mono, faint — only when the
step has more than one attempt; the count is the latest attempt's `number`, which survives the
§4.5 prune) and the latest attempt's duration — rows carry no actions;
skipping lives in the header's Skip-step button. Above step 1 sits a **"Setup log"**
pseudo-row (terminal icon in place of a status dot) selecting the execution-scoped log.
Selecting any row changes which log the LOGS pane shows. While the
execution is live the selection auto-follows the executing step until the user selects a row
themselves (reset when navigating to another execution); when a failed execution loads, the
failed step's latest attempt is auto-selected. On a failed
execution a **failure notice** sits above the RESULT card: red-tinted card, "Failed at step
“`<name>`”" (the step name in curly quotes; "Execution failed" when `error.step` is null —
a pre-step failure), the §4.5 possible reason as plain text when present, and the error
message in mono.
On a failed non-test execution whose automation still exists, the notice also carries a
quiet **"Fix with AI"** button: it opens the automation's §11 editor, seeds the chat thread
with a system entry naming the failure ("Execution failed at step `<name>` — `<message>`"),
and sends the §11 canned analyze chat message as a §8 chat job carrying this execution's id
as the §19 `runId` — the RECENT RUNS context includes the run's error and log tails, and
the agent's answer, rewrites, and follow-up actions land in the thread (§11).
Test executions never show it — draft iteration already lives in the editor.
The LOGS pane shows the selected step's log (header: step name, or "Setup log" for the
pseudo-row, plus the redaction note "secrets redacted: `<name>`"); when the selected step has
more than one attempt, a segmented **attempt control** sits in the header — one status-tinted
pill per retained attempt ("Attempt 2 · Failed · 3s", pills labeled by attempt `number` — after the
§4.5 prune the earliest pills are simply gone), latest selected by default. The pane is the
color-coded log view (kinds sys/out/wrn/err); logs load lazily per selected step/attempt
(§19) and live lines stream in over WS (deduped by `sequence`), with live auto-scroll and the
blinking cursor on the live attempt. Empty states: "No logs — this execution never
started." when the execution has no steps; an empty Setup log shows "No setup events —
installs, retries, and failures would appear here."; an empty step attempt shows "No log
lines here." The RESULT card, when the execution has no result, is a dashed placeholder ("No result") with a
status-specific reason (still executing / failed before a result was built / cancelled / no
result produced); with a result it is a collapsible **Results section** holding a stack of individually
collapsible **result views**, each with a chevron + title header and right-aligned mono meta
("4.1 KB") — every view expanded by default on this page (§9.2's LATEST RESULT card trims the
same stack down), collapse state per-session only (never persisted). The section header row carries the result chip when the execution set one — tinted
by its chip status (changes = accent, ok = green, attention = orange); an execution that set no chip
gets no chip here — plus metadata chips; the execution's
own status badge stays in the page title row, never here. View order: one **file view** per renderable
file in alphabetical order (`.md` markdown, `.html` sandboxed iframe, images inline; titled
by filename), then a collapsible **FILES footer** ("FILES · N" header, open by default here):
the result-dir path in mono, every file as a row, and a "Show in Finder" button opening the dir
in Finder. Rows are name + size, and a **previewable** file's row is itself expandable — chevron
at the left, the file's content rendering inline below it when opened. Previewable covers the
three renderable kinds plus **text** (`csv json txt yaml yml log tsv xml`), shown as mono plain
text, horizontally scrollable, capped at 200 KB / 2000 lines with a trailing "Truncated — use
Show in Finder for the full file." note. Anything else (zip, pdf, xlsx, …) gets no chevron and a
faint `no preview` tag. Every row body starts **collapsed** regardless of the surface, and its
bytes are fetched lazily on first open — expanding the footer itself costs no requests.
Files present but none renderable → the section is just the footer.
No files at all → the whole view stack (footer included) is replaced by a dashed
placeholder card: "The latest execution didn't produce any result files."
Deleted-automation handling: historical name, marked deleted.

**Executions list:** all executions across automations, §4.5 `test` executions included — a
Build & test run lands here like any other (the §11 panel's View-run button stays as a
shortcut). A test row reads like any row: `automationName` is the §11 shadow record's name (the
automation's; in create mode the draft's name, "New automation" fallback), never marked
"(deleted)" (a create-mode test has no automation by design), and its trigger column prints
"Test" **once** — the §4.5 trigger and ver labels are both "Test", and the row never prints
the redundant pair (a mocked sender still appears between: "Test · Dave"). Test rows share
the record's draft-scoped lifetime (§11 keep-latest): starting the next test replaces the
previous row, and a settling draft removes its rows. Three sections, top to bottom —
active work, then what it is holding up, then history: **Running** (`executing` rows, newest
start first), **Waiting** (§6 firing-queue `queued` rows, oldest wait first — the drain order,
so the next one to run reads top), **Finished** (most recently ended first, by §4.5 `endedMs`;
start time stands in for records that never got an end, e.g. interrupted rows — end-time sort
is what lets a finishing execution slide from the top section to the top of the finished one).
Running and Waiting each render only when they hold rows, and a promoted firing moves itself
from Waiting to Running with no refetch. Queued rows get their own section rather than sitting
in Running because their columns differ and because "waiting on a slot" is a different question
from "running now" — but not their own tab: the state is transient (`AUTOWRIGHT_QUEUE_TTL_S`,
§15, caps a wait at 120s by default), usually empty, and a tab would hide it behind a click
while competing with the filter control for the same header slot. With nothing live or waiting
the page stays a single unlabeled table; as soon as either section exists, every rendered
section gets a small mono label (RUNNING / WAITING / FINISHED) and an empty Finished section
shows the filter's empty-state card. That card's title: "No `<filter>` executions" ("No
succeeded executions" / "No failed executions") under a filter; on All, "No finished
executions yet" when sections are labelled, else "No executions yet". Body: "Executions
matching this filter will appear here." under a filter; on All, "Finished executions will
appear here." when labelled, else "Execute an automation — every execution will appear
right here." The All / Succeeded / Failed filter applies to finished
rows only — running and waiting rows stay visible under every filter. The Waiting table swaps
the last two columns for **WAITING FOR** (elapsed since §4.5 `queuedMs`, ticking every second)
and **QUEUED AT**; a queued row has no duration and has not started, so showing either would be
a lie. Each row shows the automation name with
the short execution id (mono, first 8 characters — the same short form the detail page's
RECENT EXECUTIONS rows use; the full id lives on the execution page's metadata line) on a
second line beneath it, status badge, a trigger column combining trigger and version
("Manual · v3"; a message-triggered row puts the §4.5 `triggerSender` between them —
"Discord · Dave · v3"), timestamps, durations. Rows carry no note
text — skipped/cancelled notes appear on the detail page's RECENT EXECUTIONS rows and on the
execution page.

