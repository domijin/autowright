# Autowright SPEC — Engine contract & framework policies

Part of the Autowright spec. Index and § map: [SPEC.md](../SPEC.md). § numbers are global across spec files.

## 6. Engine contract & framework policies (shown as reference in Review)

- **Scheduling & triggers** — an automation runs at most `maxParallel` executions at once
  (§4.1, default 1; the API answers 409 when a manual start finds every slot taken, and the
  toast copy is client UI). Enabled triggers fire independently; occurrences due at the same
  moment coalesce into one execution. A firing that finds every slot taken is **queued** when it
  came from a message trigger and `maxQueued` (§4.1) allows it, and **skipped** otherwise — see
  *Firing queue* below (a one-shot `time` trigger is still consumed by that skip, §4.3).
  **There is no automatic execution-level retry:** a failed execution stays failed until the
  user retries it (§7) or the next occurrence fires — transient failures are handled inside
  the execution by §7 step retry (the §4.1 `retries`/`infiniteRetries` step fields), which
  keeps the execution `executing` while a step burns attempts instead of flip-flopping a
  terminal record. **App-start firing:** the Electron main process calls §19
  `POST /app-started` once per app launch (on ready; while the backend isn't answering it
  re-reads `backend.json` and retries every 2 s for up to 60 s, then the occurrence lapses —
  no queue). The backend then starts one execution per automation holding an enabled
  `app_start` trigger; the mid-execution skip applies as above.
  Reopening a window from the tray is not an app start. **Message-trigger firing (Discord,
  iMessage):**
  the backend runs a **listener manager** (`listeners.py`) beside the scheduler. A reconcile
  loop (period `AUTOWRIGHT_LISTEN_TICK_S`, §15) compares the enabled message triggers across
  all automations against the open listeners: for `discord` it maintains **one Discord
  gateway WebSocket
  per distinct bot-token secret name** — shared by every trigger referencing that secret;
  connections open, close, and re-resolve their token as triggers are added, removed, toggled,
  or re-pointed. A dropped connection reconnects with exponential backoff (1 s doubling to a
  60 s cap); an authentication failure (bad token) or a missing/valueless secret parks the
  connection in the `connection` error state (§4.3) and re-tries at the backoff cap, so fixing the
  secret heals it without a restart; `automation.changed` fires for affected automations on every
  state change. Each connection learns the bot's user id from `READY` and the bot's
  managed-role ids from `GUILD_CREATE` payloads (roles whose `tags.bot_id` is the bot's user
  id), so the §4.3 mention rule matches role mentions too. `GUILD_CREATE` also fills a
  per-connection **name cache** — the guild's name and the names of its channels and
  threads — which stamps the §4.5 payload's `channelName`/`guildName` at firing time
  (best-effort: a channel the cache doesn't know — a DM, or one created after connect —
  yields null, never a blocked lookup; the gateway read loop does no REST calls). A gateway message matching a
  trigger (§4.3 rules) starts an execution with
  trigger label "Discord" and the §4.5 `triggerPayload`; mid-execution it gets a skipped
  record like any trigger.
  **iMessage watcher** (`imessage.py`, driven by the same reconcile loop): while at least one
  enabled `imessage` trigger exists anywhere, the manager keeps **one watcher total** on the
  Messages database — `~/Library/Messages/chat.db` (`AUTOWRIGHT_CHAT_DB` overrides, §15),
  opened read-only via SQLite **without** `immutable=1` (the db is WAL — an immutable open
  would miss live updates). No permission is touched before that first enabled trigger, and
  the watcher closes when the last one goes — adding an iMessage trigger is what first asks
  the system for anything (§9 permission checklist). The watcher polls on the reconcile tick
  with a **ROWID cursor** starting at the db's current `MAX(ROWID)` when it opens: only
  messages that arrive while it is watching fire — never history, and (per the
  missed-executions rule below) never a catch-up backlog: a cursor-passed row whose message
  timestamp is older than `AUTOWRIGHT_IMSG_MAX_AGE_S` (§15, default 120) when observed is
  ignored, so a sleep/restart backlog cannot fire a burst. **Data minimization:** each tick
  reads only rows the enabled triggers could fire on — the SQL itself filters to the
  configured senders' handles (case-insensitive), incoming only (never `is_from_me`), and
  plain messages only (no tapbacks/reactions — `associated_message_type` 0 — and no
  group-event rows — `item_type` 0); conversations no trigger watches are never read or
  decoded, and the cursor still advances past everything each tick, so skipped rows are
  never re-scanned. Message text is the row's `text`
  column when present, else decoded from the `attributedBody` typedstream blob (the
  documented heuristic scan, ported from OpenClaw's MIT `imsg`: segments open with
  `0x01 0x2b`, lengths are BER-style — a byte < 0x80, or `0x81` + one byte, or `0x82` + two
  little-endian bytes — candidates decode as UTF-16 LE on a BOM else UTF-8, and the longest
  candidate wins); an undecodable body means the message
  cannot fire (§4.3). A row passing the §4.3 rules starts at most one execution per automation —
  the first matching enabled trigger wins, exactly as for Discord (the §6 coalesce rule above) —
  with label "iMessage" and the §4.5 payload. Failure handling mirrors Discord: a db that
  cannot be opened — no Full Disk Access, or no `chat.db` at all (Messages never signed in) —
  parks the watcher in the `connection` error state shared by every `imessage` trigger (§4.3),
  re-probed each tick, so granting the permission heals it without a restart;
  `automation.changed` fires on every state change. **A dropped message
  firing answers its sender** — a dropped message would otherwise leave a person waiting on a
  bot that silently ignored them, so the engine posts a short busy notice ("I'm working on
  something else right now and couldn't take this message — please send it again in a
  moment.") back to the triggering message. One notice per dropped message, no rate limit or
  coalescing: the notice tells the sender to retry, so a retry that is itself dropped must be
  answered too, never silently swallowed. Discord notices carry a `message_reference` to the
  dropped message's `messageId` (§4.5 payload, `fail_if_not_exists` false so a since-deleted
  message still gets a plain channel post), so a burst reads as one threaded receipt per
  message; iMessage has no reply references, so its notices are plain texts to the chat. Only
  message firings do this; a skipped cron or app-start firing has nobody to answer. A failed
  send is logged and otherwise ignored, exactly as for
  §6.1 `reply()`. Apart from this notice the listeners send nothing outbound on their own —
  outbound messages happen only through a step's explicit §6.1 `reply()`.
- **Firing queue** — a message firing that finds every `maxParallel` slot taken waits instead of
  vanishing, up to `maxQueued` entries (§4.1). Two kinds of entry queue: message firings, and
  **manual starts the user chose to queue** (§19 `queue: true` — the §9.2 capacity popup's
  Queue action; trigger label Manual). A cron, one-shot, or
  app-start occurrence that arrives late is worse than one that never ran, so those keep the
  skip. A queued firing is a **real execution record** with status `queued` (§4.6) carrying its
  §4.5 `triggerPayload` (a manual entry carries none) — it appears in Executions immediately
  (admission publishes the §19
  `execution.queued` event, so the §7 Waiting section and the §9.2 "N waiting" line update live),
  is addressable by
  `POST /executions/{id}/cancel` (§19), and is removed by retention like any other record.
  `queued` records never count as the automation's latest execution (§4.1 `lastStatus`
  excludes them, exactly as for `skipped`) — a waiting firing must not shadow what actually ran.
  Queue rules, in the order they apply:
  - **One entry per firing** — every admitted firing is its own queue entry, its own execution
    record, and is answered on its own; messages from the same sender never coalesce, so three
    messages from one person occupy three slots and produce three executions.
  - **Depth cap** — past `maxQueued` entries the firing is refused, not admitted: the newest is
    dropped (a `skipped` record noted "the queue was full (N waiting)", N being the cap that
    turned it away, plus the §6 busy notice), never an entry already admitted and
    answered. Setting `maxQueued: 0` restores pure skip-on-busy, and its refusals keep the
    plain "previous execution still in progress" note — nothing was queued, so nothing was
    full. Same note for every firing that cannot queue at all (cron, one-shot, app-start).
    A **manual** queue request past the cap is refused with a 409 ("the queue is full
    (N waiting)") and **no record** — the user is present to decide, unlike a message sender
    (the §9.2 popup normally prevents the call; the 409 covers the race).
  - **Staleness** — an entry that reaches the head having waited longer than
    `AUTOWRIGHT_QUEUE_TTL_S` (§15, default 120) does not execute: its record finishes `skipped`
    with the note "waited too long in the queue" and its sender is told. Answering a stale
    question is noise. **Message firings only** — a manual entry has no TTL and waits until
    promoted or cancelled: the user chose to wait, and evaporating that choice two minutes
    later would be a silent no-op.
  - **Manual admission** — a `queue: true` start with a free slot simply starts (queueing
    beside a free slot would promote on the next drain anyway); at capacity it is admitted
    pinned to the resolved version (§4.5 kind `version` — a Draft is never queued: the draft
    could change under the entry, so the request answers 409 and the user executes it fresh
    when a slot frees). Promotion, cancel, and the queued-execution page behave exactly as
    for a message entry — there is simply no sender to notify.
  Draining is FIFO by queue-entry time and happens whenever a slot frees — an execution
  finishing, being cancelled, or `maxParallel` being raised. Promotion reuses the queued record:
  the same record's steps are filled in and its status flips `queued` → `executing`, so a
  firing produces exactly one execution record from admission to finish. Cancelling a queued
  entry (individually, or via the §19 queue-clear endpoint) finishes it `skipped` — it never ran,
  and §4.6 reserves `skipped` for exactly that — with the note "cancelled before it ran", and
  tells its sender; cancelling a *running* execution does not drain the queue — it frees a slot,
  which is the point of having one. Turning the trigger off, turning the automation off, or deleting it
  cancels every waiting entry: after any change to the trigger list (PATCH, or a version save
  adopting the editor's list), a waiting entry whose payload no longer matches an enabled
  message trigger — same `secret` and `channel` for `discord`, sender matching `from`
  (case-insensitive) for `imessage` — is cancelled exactly like a user cancel
  ("cancelled before it ran", sender told); it could never be re-admitted, and promoting it
  would execute a firing the user just switched off. Trigger edits never touch a **manual**
  entry — it was not admitted by any trigger, so only a user cancel, automation deletion, or
  a restart ends it early. Queued records do not survive a restart: §3's stale-record repair
  finishes any leftover `queued` record as `skipped` ("backend restarted before this ran"), since
  the in-memory queue and the sender's patience are both gone.
- **Missed executions** — execute when possible: if a trigger's moment passes while the Mac is
  asleep (backend alive but suspended), the execution fires on wake. If the backend itself wasn't
  running when the moment passed, that occurrence is skipped entirely — no catch-up queue at
  startup; the next occurrence proceeds normally. At most one catch-up execution fires per wake
  regardless of how many occurrences — across all triggers — were slept through.
- **Reading web pages** — 10 s timeout; ≥ 2 s between requests to the same site; retry twice;
  respect robots.txt; user agent "Autowright/1.0".
- **Workspace per execution** — every step executes with its cwd set to the execution's `workspace/`
  directory; scripts are executed in place from their version folder (or `draft/automation/`), never
  copied. All steps of an execution share the one workspace; it is disposable scratch space,
  not guaranteed to exist after the retention window.
- **Per-step timeout** — every step runs under a watchdog: the step's own `timeout` (seconds,
  §4.1) when set, else the 900 s default (`AUTOWRIGHT_STEP_TIMEOUT` overrides the **default**
  only, §15 — a step's own value always wins). The watchdog is **armed before the §6.1
  context handoff to the executor child** — the deadline runs from process spawn, so a child
  that wedges before reading its stdin context (an interpreter that hangs on startup, a pipe
  that never drains) still hits its limit; no step can sit outside the watchdog for any part
  of its life. `no_timeout: true` disables the watchdog: the
  step may run until it finishes or the user cancels/skips it — holding one of the automation's
  `maxParallel` slots the whole time (a firing that finds every slot taken meanwhile is queued
  when it came from a message trigger and `maxQueued` allows it, and skipped otherwise, per
  scheduling and the firing queue above). On expiry the step's whole process group is killed (§7 kill semantics)
  and the step fails with the §7 timeout reason ("The step hit its N s time limit."). The
  §6.1 agent-call cap (120 s per `agent.ask`) applies on top, unchanged.
- **Memory between executions** — one private `memory/` directory per automation, reachable from
  scripts via an injected path; scripts may store any files in any format there. Persists
  across executions and versions. Draft executions get `draft/memory/` instead (§4.4) — the
  live directory is never read (past the one-time seed copy) or written by a draft. Durable writes go to `memory/` (deliberate) or `result/`
  (output files via `result.path`) — the workspace is for everything else.
  **Under `maxParallel > 1` this directory is the only state two executions of one automation
  share** (`workspace/`, `result/`, and `logs/` are per-execution, §5), so it is where a
  concurrency bug would land. The guarantee is **atomic commit**: `memory.save(name, obj)`
  writes a temp file in the same directory and renames it over the target (the same discipline
  §5 uses for `execution.yaml`), so `memory.load` always sees a whole file — never a partial
  one — and a crash mid-write leaves the previous version rather than a truncated one. It is a
  per-write guarantee, not a lock: steps run in their own subprocesses, so the engine cannot
  hold a lock across one. What that leaves is a **lost update** — two executions doing
  `save(k, load(k) + 1)` still race and one increment is dropped. Unavoidable at this layer (the
  engine can't serialize a read-modify-write it can't see), and the reason raising `maxParallel`
  on an automation whose steps write memory carries the §9.2 caution. Steps that write the
  `memory/` path directly, rather than through `memory.save`, get no guarantee at all.
- **Notifications & results** — exactly one result per execution; at most one notification, at the end;
  notify only on changes (per the notifications setting). **Sender (decided):** the backend posts
  macOS notifications itself via `osascript -e 'display notification …'` — works headless with no
  UI process; the Electron app never posts.
- **Secrets & Keychain** — scripts reference secrets by name; values injected at runtime — each
  step receives only the secrets it declares in the manifest (`secrets`) plus those its own code
  references — and redacted from logs; a missing secret stops the execution before any step.
- **Agent steps are query-only.** A step's runtime agent call is a pure question → text-answer
  function; only step scripts make changes. A step may name several enabled agents (`agents`,
  §8 grant names) and address each per call (`agent.ask(…, agent="Name")`); the engine resolves
  the names against the automation's enabled agents at execution time. The first-enabled-agent
  fallback applies **only when the step names no agents at all**: a step whose named agents
  all fail to resolve (revoked grants, renamed agents) fails exactly like an agent step with
  no enabled agent — the §7 engine-level failure ("Step N needs an agent, but none is
  enabled…"), never a silent hand-off to an agent the step didn't name. The engine invokes the harness one-shot and
  non-interactive with the strongest tool-disabling flags each harness supports: Claude Code
  `claude -p --tools "" --strict-mcp-config --no-session-persistence`, Codex
  `codex exec --sandbox read-only --skip-git-repo-check`; Gemini CLI and OpenCode expose no
  tool-disable flag for one-shot invocations and are
  invoked bare (documented limitation; a custom-model agent — mode `custom`, §4.7 — adds
  `--model <model>` to the harness command, the same flag on all four CLIs). A local-model
  agent (mode `ollama`, §4.7) rides each harness's own supported local mechanism, all against
  the same Ollama server (`AUTOWRIGHT_OLLAMA_URL`, default `http://localhost:11434`):
  Claude Code — the invocation env gets `ANTHROPIC_BASE_URL=<ollama url>` and
  `ANTHROPIC_AUTH_TOKEN=ollama` (bearer auth; Ollama's Anthropic-compatible `/v1/messages`
  does not reliably accept `x-api-key`, so never `ANTHROPIC_API_KEY`) plus a bare
  `--model <model>` — behind a custom base URL the CLI passes any model name through
  unvalidated and skips its sign-in check; Codex — the top-level flags
  `--oss --local-provider ollama` before the `exec` subcommand (like `--search`, `exec`
  itself rejects them) plus `--model <model>` after it — no login needed; OpenCode —
  `--model ollama/<model>` after the §19 opencode.json provider sync. Gemini CLI has no
  local-model mechanism (§4.7). Every harness CLI child
  (drafting and runtime alike)
  runs with its cwd set to its provider's own `harness/<provider-id>/workspace/` directory
  under Application Support (§5) — created on demand, kept empty by the app: CLI
  startup project scans stay inside that empty folder and never enter TCC-protected locations
  (Photos, Music, Desktop, …), so macOS shows no permission prompts attributed to the backend.
  Secret values never enter a prompt: the engine
  redaction-scans the assembled prompt and fails the step (before sending) if any secret value
  appears. The reply is returned to the script as untrusted text/JSON — never executed or
  evaluated. Per-step timeout plus prompt- and output-size caps (200k chars each) apply; the full
  redacted prompt and response (up to those caps) are written to the step's attempt log
  file (§5) for audit.
  Worst-case prompt injection from fetched content is therefore a wrong answer in a result, never
  an action.
- **Drafting calls read the web.** Unlike runtime agent steps, the §8 drafting invocations
  (spec, steps/sync, chat, repair rounds, build diagnosis) run **web-enabled**: each harness's
  web-read tools are turned on so the agent can fetch the pages the request names and write
  selectors and parse logic from the real DOM instead of guessing. Per harness: Claude Code
  swaps `--tools ""` for `--tools "WebFetch,WebSearch"` (everything else — `--strict-mcp-config`,
  `--no-session-persistence`, the streaming flags — unchanged); Codex adds `--search` before
  the subcommand — `codex --search exec` (its native `web_search` tool; the read-only sandbox
  stays; `exec` itself rejects the flag); Gemini CLI and OpenCode are already
  invoked bare and need no flag. Web-read is the only added capability — still no shell, no
  file writes, no MCP. Draft-time fetches ride the harness's own HTTP client, so the web
  policies above (robots.txt, UA, per-site spacing) do not apply to them, and fetched page
  content lives inside the harness loop rather than the logged prompt — both deliberate,
  accepted trade-offs. The escalation is real and bounded: page text read at drafting time can
  steer *authored code*, not just an answer — contained by the §8 envelope validation (the
  backend writes files only after it passes), the user-visible spec/step review, grants staying
  app-owned (the agent can never enable an agent or secret), and the runtime lock above staying
  absolute: `agent.ask` calls never get web tools, so the runtime worst case remains a wrong
  answer, never an action.

### 6.1 The `autowright` step SDK (decided)

Each step executes in its own subprocess (the bundled interpreter, cwd = the execution `workspace/`).
The executor registers an `autowright` module holding the SDK surface; **a step must import every
SDK name it uses** — `from autowright import params, log, result` (or `import autowright` and
`autowright.log(…)`). Nothing is injected into the script's globals: an unimported SDK name raises
`NameError` like any other undefined name. The names on that module:

- `params` — dict-like, values by param name (definitions merged with §5 value-resolution rules).
- `secrets` — attribute access by name (`secrets.SMTP_PASSWORD`); reading a missing/un-allowed
  secret raises and fails the execution (the missing-secret pre-check in §6 catches known references
  before step 1). Values never repr/print unredacted — the engine scans all log lines.
  Only the step's own declared/referenced secrets are exposed on `secrets`. The full
  automation-wide value map the outbound scans need (`agent.ask`, `reply`) is taken off the
  step context before the SDK is built and passed to those two call sites explicitly, so an
  ordinary step cannot read another step's secret off `agent`. It is passed, never defaulted:
  a scan that silently degrades to "no secrets" on a wiring mistake would fail open. This is
  scoping hygiene, not a sandbox — a step is arbitrary in-process Python, and §6.2 is explicit
  that the engine is not a sandbox.
- `memory` — path-like handle on the automation's memory dir: `memory.path` is the
  `pathlib.Path`, and the handle supports `__fspath__` and `/`-join, so `open(memory)` and
  `memory / "x"` work — but it is not a full `Path` (contrast `workspace`, which is one); plus
  `memory.load(name, default)` / `memory.save(name, obj)` YAML helpers. `name` is a plain file name confined to the memory dir:
  a name that is absolute, contains a path separator, or contains a `..` segment raises
  `ValueError` — snapshots and "Clear memory" (§4.4) operate on that dir, so a key must never
  address a file outside it.
- `workspace` — `pathlib.Path` of the execution workspace (already the step's cwd, so relative
  paths reach it without importing this).
- `execution` — read-only execution metadata: `execution.automation_id`, `execution.automation_name`,
  `execution.id`, `execution.step_index` (1-based), `execution.step_name`, `execution.trigger` (the execution's trigger label,
  e.g. `Manual` / `Cron`, §4.5), `execution.trigger_payload` (the §4.5 message-trigger context
  as a dict, `None` on non-message executions). Assigning to any field raises.
- `reply(text)` — message-trigger executions only: sends `text` back to the triggering
  message's origin. The send happens **engine-side** (a `reply` control op routed through the
  listener module) — the bot token never enters the step process: Discord replies POST to the
  payload's channel via the REST API with the token from the payload's `secret`; iMessage
  replies send via Messages.app AppleScript (`osascript`, resolved through PATH) to the
  payload's `chat` guid — macOS may show the Automation permission prompt on the first send
  if the §9 checklist was skipped, and a denial (Apple Events error −1743) surfaces as the
  failed-send err line. Text longer
  than the medium's limit is truncated — 2000 chars for Discord, 4000 for iMessage.
  Fire-and-forget: a failed send logs an
  err line ("reply failed — …") but never fails the step; a successful send logs a sys line
  naming the medium it actually went to (Discord channel or iMessage chat).
  Calling `reply` in an execution not started by a message trigger raises — a §11 test
  whose request carried a mocked payload (§19 `triggerMock`) counts as message-started:
  a Discord reply sends **for real** (the mock carries the trigger's real `channel` and
  `secret`); an iMessage mock has `chat: null`, so the send fails with the ordinary err
  line ("reply failed — the triggering message has no chat to reply to") and the step
  continues.
  **Secret scan** — reply text is an outbound message to a third party, so it gets the same
  scan `agent.ask` prompts get (§6, against ALL of the automation's secret values, multi-line
  values line by line): a hit raises in the step and nothing is sent. This is a hard refusal,
  not a redaction — silently posting `•••` to a channel would hide that the automation tried
  to leak a Keychain value.
- `log` — `log(text)` / `log.warn(text)` / `log.error(text)` → `out`/`wrn`/`err` NDJSON lines
  (`log.info` is an alias of `log`).
- `result` — builder used by the last step (any step may add): `result.chip(text)` (optional —
  an automation may not use a chip at all), `result.status('changes'|'ok'|'attention')` — at
  execution end the engine stores chip + status on the execution record (§4.5). Everything else
  is files: `result.path` — `pathlib.Path` of the execution's result dir for direct file
  output (result.md, result.html, images, CSVs, …); any file dropped there is part of the
  result (§4.5), so there is no attach call, and tables are markdown tables in result.md.
  The chip is stored on the execution record, so it is **redacted exactly like a log line**
  before it is persisted or published (§5: secret values never appear in any file).
- `notify(text)` — requests the end-of-execution notification (engine still applies the §4.9 setting
  and the one-notification rule). The notification title is the automation name, overridable by a
  param literally named `notification_title`. The body is **redacted like a log line** before it
  reaches the OS: a notification leaves the app's own storage (the `osascript` argv is visible
  to any local process, and the text persists in Notification Center's database).
- `agent.ask(prompt, data=None, agent=None) -> str` — the §6 query-only runtime call, only in
  steps marked `agent: true`; executor invokes one of the step's agents one-shot,
  redaction-scans the prompt first. `agent` picks among the step's `agents` by grant name (§8);
  omitted, the first is used; naming an agent the step doesn't carry raises. Convenience
  aliases `agent.read(data, prompt, agent=None)` / `agent.write(data, prompt, agent=None)` wrap
  it. Agent-step calls use a 120 s window (drafting calls use the §8 5-minute one); both are
  §8 idle windows under the same §8 hard cap.
- `fetch_page(url) -> str` — HTTP GET honoring the §6 web policies (timeout, per-site spacing,
  retries, robots.txt, UA).

Executor↔engine protocol: stdout/stderr are captured line-by-line as `out`/`err`; structured calls
(log/result/notify/reply) emit `@@AD@@{json}` control lines on stdout. Context (param values, secret
values, paths, agent config, execution metadata) arrives as JSON on stdin — never argv, never the
environment. The executor does export the non-secret pieces back out as env vars so child
processes a step spawns can self-identify: `AUTOWRIGHT_AUTOMATION_ID`, `AUTOWRIGHT_AUTOMATION_NAME`,
`AUTOWRIGHT_EXECUTION_ID`, `AUTOWRIGHT_STEP_INDEX`, `AUTOWRIGHT_STEP_NAME`, `AUTOWRIGHT_TRIGGER`,
`AUTOWRIGHT_TRIGGER_PAYLOAD` (the §4.5 payload as JSON, only on message-trigger executions),
`AUTOWRIGHT_WORKSPACE`, `AUTOWRIGHT_MEMORY_DIR`, `AUTOWRIGHT_RESULT_DIR`. Param values, secret values,
and agent config never enter the environment; the executor never reads env as input.
`sys.exit()` in a step follows the CPython convention: no code / `0` is an ordinary early exit
(the step succeeds), an integer fails the step with that exit code, and `sys.exit("message")`
fails it with the author's message preserved as the error (`SystemExit: message`).

### 6.2 Curated & declared packages (decided)

Step scripts may import: Python stdlib, `autowright`, and the curated packages: `requests`, `httpx`,
`beautifulsoup4` (`bs4`), `lxml`, `feedparser`, `python-dateutil` (`dateutil`), `PyYAML` (`yaml`).
The curated list ships with the app (installed in the bundled interpreter) and is included
verbatim in the §8 contract preamble.

**Declared packages.** When a task genuinely needs a library beyond the curated list (the
task-solving ladder still prefers stdlib + curated first), the drafting agent declares it in
`manifest.yaml` (§8): `packages: [{ pip: pandas, import: pandas, why: "…" }]` — one entry per
distribution: the bare distribution name (PEP 503 name only — **no version specifier**; the
installed distribution is the single source of truth for the version, see the install model
below), the top-level module it provides, and a **required** `why` — the one-line purpose §8
validation rejects an entry without, shown on the §11 Packages card. Python transitive dependencies are pip's job and
are never declared; what
must be declared is every **runtime companion** the task's usage needs beyond that — optional
extras and binary-bundling wheels (e.g. yt-dlp merging streams needs ffmpeg → declare
`imageio-ffmpeg` alongside it and wire its path in the step). The §8 contract instructs the
drafting agent to declare the complete set a task needs, so an execution never discovers a
missing companion at runtime. Declared packages extend the import allowlist for that version's steps only:
§8 validation and the executor's runtime re-check both accept stdlib + curated + `autowright` +
the version's declared imports (shared module `imports_check.py`, which takes the declared
names as an extra allowlist) and fail the step on anything else — the allowlist holds even for
hand-edited step files that never went through drafting. Both checks are static analysis of
the script's `import` statements; a dynamic load (`importlib.import_module`) is out of scope —
not a sandbox (stdlib already includes `subprocess`), just drift protection so a step can't
silently depend on a package another automation happened to install.

**Install model — the user never runs pip.** Declared packages install into one shared,
user-writable directory, `<app-support>/site-packages` (§5), via the bundled interpreter's
`python -m pip install --target`, wheels only (`--only-binary :all:` — a source-only
distribution fails fast with pip's "no matching distribution" rather than hitting a compiler
users don't have). The bundle inside the .app is never written to (read-only,
replaced whole on update). The executor prepends this directory to `sys.path` for every step,
so deleting it (or an app update) is always recoverable. Installing is one idempotent "ensure"
operation shared by every call site: a fast installed-check first (distribution present in the
directory, **any** version — the installed version is never compared against the manifest,
which carries no version), pip runs only for missing distributions (installing the newest
compatible wheel at that moment), and one process-wide lock serializes pip runs. An installed
distribution is never touched by ensure — upgrades happen only through the explicit §11 Update
button — so an unattended automation never changes behavior because a library released
overnight. Pip alone doesn't honor that with `--target` (it resolves against its own env and
would happily replace shared dependencies already in the directory), so ensure passes a
constraints file pinning every already-installed distribution to its exact version; a new
package whose requirements genuinely conflict with those pins fails the install with pip's
resolution error instead of silently upgrading a neighbor. Ensure happens at two moments through the same code path:

- right after a §8 steps call validates (job stage "Installing the packages"; per-package
  statuses ride the draft payload and render in the §11 Packages card) — the user learns about
  an install failure while still on the edit page, not when a trigger fires;
- before an execution's first step (§7) — self-healing after an app update, a cleared
  directory, or a save that skipped a failed install.

An install failure never blocks saving (§11); at execution time it fails the execution before
step 1 with the §7 category. The shared directory holds one version of each distribution,
shared by every automation declaring it (accepted: single-user app; if a real conflict ever
shows up the fix is per-automation target dirs, not user-facing knobs). Because manifests are
version-free, restoring an older automation version never changes any installed package, and
a wiped directory self-heals to the newest compatible wheels rather than an exact snapshot.

**Updating packages — the app checks, the user decides.** The installed version only changes
through the explicit per-row **Update** button (§11). On load the edit page's Packages card
asks PyPI for updates (§19 `POST /packages/outdated`, read-only: per package, the newest
stable non-yanked version that has a wheel compatible with the bundled interpreter — the
wheels-only rule applies to the check too; a network failure just leaves the badges off),
comparing against the **installed** version. An update runs `pip install --upgrade <name>`
into the shared directory (§19 `POST /packages/update`) — no manifest is touched, because
manifests carry no version; every automation declaring the distribution picks up the new
version at its next execution automatically.

**Native tools (deliberately deferred).** System binaries (ffmpeg, tesseract, …) are not
installable — pip is the only channel. That never justifies a contorted workaround: the
drafting agent goes straightforward-first (§8 `framework-instructions.md`). When a pip
package bundles a genuinely equivalent static binary (e.g. `imageio-ffmpeg` — binary ships
inside the wheel; the step passes its path to the tool), it wins — a bundled equal beats
asking the user to install anything. Otherwise the steps target the **canonical tool for
the job** (Transmission for torrents, the Discord desktop app, …) with a deterministic
**pre-flight** that fails in plain words when the tool is absent — `shutil.which` for a
CLI, a quick connect for a local daemon — raising an error that names the tool, says it
isn't installed or running, and includes the download URL, so the failure reads as user
instructions and reaches later §8 chat calls verbatim via RECENT EXECUTIONS. A dependency the
agent already **knows** is missing (the user said so; a run proved it) yields a §8
`kind: user-action` blocker instead of steps that will fail.
Future escalation, to build only when a real automation is blocked on a binary with no wheel:
a `tools:` manifest channel backed by a bundled micromamba installing exactly-pinned
conda-forge packages into `<app-support>/env/`, with the same ensure semantics (§8 install
stage, §7 pre-execution self-heal, §11 card rows) and `env/bin` prepended to step `PATH`.
Homebrew is never bundled (custom prefixes forfeit bottles → source builds on user machines).

### 6.3 Memory snapshots (decided)

Point-in-time copies of an automation's `memory/` directory, restorable from the §9.2 MEMORY
card. Memory is the app's only mutable state with no version history; snapshots make its
destructive moments recoverable.

- **Layout** — `memory-snapshots/<uuid4>/` beside `memory/` (§5 tree): `snapshot.yaml`
  (`id` = the dir name, `name` = user label | null, `reason`, `created_at` the §5 canonical
  UTC ISO-8601 timestamp (offset, microsecond resolution) — snapshots can be taken within the same second, and "newest first"
  (and therefore which unnamed snapshots the prune keeps) must stay deterministic,
  `version` = "vN" label, `size` = total bytes, `files` = file count) plus `memory/`, the
  recursive copy. Each snapshot is self-describing; there is deliberately no index file. The
  list is read from disk on demand, newest `created_at` first — nothing cached, per the §5
  rebuild-from-disk model.
- **Reasons** — `manual` (MEMORY-card button, optional name); `pre-clear` (automatic, taken
  before §9.2 "Clear memory" empties the dir); `pre-version` (automatic, taken by the engine
  right before the first execution of a version with no recorded execution yet — real "vN"
  versions only, never Draft — a Draft execution runs on `draft/memory/` (§4.4) and can't
  touch the live dir; `version` in the meta is the version about to execute — this snapshot
  is also the safety net for the §8 memory-migration duty: when a new version's steps
  mishandle the old memory shape, restoring it undoes the damage);
  `pre-restore` (automatic, current memory saved right before a restore replaces it).
- **Automatic-snapshot toggles** — every automatic reason has a per-automation on/off setting,
  edited on the §9.2 MEMORY card and stored top-level as
  `memory_snapshots: {pre_version, pre_clear, pre_restore}` (§5 — user-operational state,
  never versioned; absent keys default **on**). A reason toggled off skips its snapshot
  silently — the action itself (execution, clear, restore) still proceeds, it just leaves no
  snapshot behind, and the §9.2 confirm copy warns the step is then not undoable. Manual
  snapshots have no toggle — the button is the consent.
- **Empty memory is never snapshotted** — automatic reasons silently skip; a manual snapshot
  of empty memory answers 422.
- **Write order** — the `memory/` copy first, `snapshot.yaml` last. A dir without
  `snapshot.yaml` is a crash orphan: listing skips it, the next snapshot creation deletes it.
- **Restore** — 409 while **any** execution of the automation is live (under `maxParallel > 1`
  that means all of them, not just the newest). Takes a `pre-restore` snapshot of current
  memory (when non-empty and the toggle is on), then replaces `memory/` with the snapshot's
  copy. The replacement never has a window with no surviving copy: the snapshot is staged to
  `.ad-tmp-memory` first, the current `memory/` is renamed aside to `.ad-old-memory` (never
  rmtree'd in place), the staged copy renamed in, and only then the aside deleted. A restore
  finding `memory/` missing with `.ad-old-memory` present (crash inside a previous swap)
  renames the aside back before doing anything else; leftover stage/aside dirs are otherwise
  cleaned at the next restore. The restored snapshot itself stays — restore is repeatable
  and, via `pre-restore`, undoable.
- **Manual snapshot** — 409 while any execution is live (a mid-execution copy could catch a
  half-written file). Automatic reasons never race an execution: `pre-clear` rides the clear
  request, which is itself 409-gated the same way. `pre-version` runs before step 1 — and
  because two parallel first-executions of a new version would otherwise both see "no recorded
  execution yet", the check and the snapshot happen **in the same lock span that admits the
  execution**, so exactly one is taken and it is taken before either execution can touch memory.
- **Retention** — at each creation, unnamed snapshots beyond the newest 5 are pruned. Named
  snapshots are never auto-deleted — naming pins one until the user deletes it (or the
  automation is deleted). Renaming to empty returns a snapshot to the unnamed pool.
- **Lifecycle** — snapshots live inside `automations/<uuid>/`, so deleting the automation
  removes them (the §9.2 delete copy — memory goes with it — already covers this). "Clear
  memory" empties `memory/` only; snapshots survive it by design.

