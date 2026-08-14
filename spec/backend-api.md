# Autowright SPEC — Backend API

Part of the Autowright spec. Index and § map: [SPEC.md](../SPEC.md). § numbers are global across spec files.

## 19. Backend API (decided)

Localhost JSON over HTTP + one WebSocket, both authenticated with the bearer token from
`backend.json` (§3). Entity JSON uses the §4 field names verbatim (`automations`-shaped automations,
`executions`-shaped executions) so UI state mirrors the model. UI and CLI use only this API (§3 parity).

The server binds `127.0.0.1` only. Token comparisons (HTTP bearer and the WebSocket `token`
query param) use `secrets.compare_digest`. The interactive docs surfaces FastAPI would mount by
default (`/docs`, `/redoc`, `/openapi.json`) are **disabled** — `GET /health` is the only
unauthenticated route, and a browser on any website can reach localhost, so the app must not
publish its schema to one. For the same reason CORS does not allow arbitrary origins: the only
origins accepted are `null` (the packaged `file://` renderer) and `http://localhost|127.0.0.1`
with any port (the §15 renderer-URL dev server), credentials off. One rule in both modes — the
§15 knob changes where the renderer is served from, never the policy.

**Request validation:** every mutating endpoint's request body is validated by a pydantic
request model (`backend/autowright/models.py`) — a malformed body (missing or mistyped
fields, wrong shapes: `stepAgents`/`allowedSecrets` must be lists of strings, the settings
booleans must be booleans with `days` an int) answers 422 before any handler logic runs.
The store-state cross-field checks live in the handlers, answering the same 422:
`paramValues` entries are checked against the automation's param definitions (names **and**
kinds) and `agentId`/`stepAgents` entries must reference configured agents
(`_check_param_values` / `_check_agent_refs` in `api.py` — they need store state the models
never see). Pydantic shapes **requests only** — response bodies
remain plain dicts (§2).

- `GET /health` → `{ version, app }` (unauthenticated; used for discovery/liveness)
- `GET /state` → boot snapshot: automations (full), execution headers, agents, secret names +
  usedBy, settings, app version, `pendingDraft` (`{ name, updatedAt } | null` — the §4.4
  slot's identity summary; backs the §9.1 Resume draft button)
- `GET /instructions` → `{ framework, defaultBuild }` — the two §8 instruction files verbatim
  (backs the §11 Framework-instructions and Build-instructions cards)
- `GET /automations` · `GET /automations/{id}` · `DELETE /automations/{id}` — delete cancels
  every live execution and queued firing, then **waits for the cancelled engine threads to
  finish** (bounded by the §7 SIGTERM→SIGKILL grace plus margin) before removing the
  automation directory — a step still dying during the grace window must not re-create
  `memory/` after the rmtree (a half-recreated directory with no `versions/` would be
  invisible to the UI forever). If a thread somehow survives the wait, the directory is
  removed anyway (the step group is already hard-killed by then)
- `PATCH /automations/{id}` — user-owned fields only: name (a blank or missing name is
  ignored — a rename can never clear the name), description (blank clears it — the description is
  optional, §4.1), triggers (the §4.3 list, replaced
  whole; entries keep their `id`, new entries get one assigned;
  cron/time/app_start/discord/imessage
  kinds — a reserved kind (pubsub), an invalid cron expression, an unknown `timezone`, a
  past `time`, a `time` whose `at` carries a UTC offset (the zone belongs in `timezone`; naive
  local ISO only), a second `app_start`, or a discord/imessage entry failing the §4.3 field
  rules
  answers 422 and nothing is stored; serialized discord and imessage triggers carry the
  derived §4.3
  `connection` state), param
  values, agentId, stepAgents, allowedSecrets, snapshotSettings (the §6.3 automatic-snapshot
  toggles — partial object, sent keys merged over the stored ones), maxParallel (int ≥ 1) and
  maxQueued (int ≥ 0) — the §6 concurrency settings; a non-integer or out-of-range value
  answers 422 and nothing is stored. Lowering `maxParallel` never kills a running execution:
  the automation simply admits nothing new until it is back under the limit. Lowering
  `maxQueued` below the number already waiting keeps those entries — the cap governs admission,
  not eviction (§6).
- `POST /triggers/preview` `{ triggers: [trigger, …] }` → `{ triggers: [{ valid, error?,
  label, short, nextAt, nextLabel? }, …] }` — a **pure function endpoint**: no state read or
  written. Validates and labels a list of §4.3-shaped trigger dicts (kind plus its stored
  fields, `timezone` where relevant) with the same `triggers.py` code that gates the PATCH,
  answering one result per request entry in order. `valid` says whether the entry would
  store; `error` is the plain-word reason otherwise ("Not a valid cron expression", the
  §4.3 field rules) — an invalid entry is a `valid: false` result, never a 422 (the editors
  preview half-typed state); only a body that isn't a list of trigger dicts gets the
  ordinary 422. `label`/`short` are the §4.3 display strings; `nextAt` the next-occurrence
  epoch ms (null when the kind has no computable next — app_start and message triggers —
  or the entry is invalid or elapsed) and `nextLabel` its "Jul 20, 3:00 PM"-style moment
  label. The renderer keeps **no local trigger-math mirror**: the §9.2 Add-trigger editor's
  live preview line, the §11 draft-trigger chips, and every "next trigger" label read from
  this endpoint — trigger math exists once, in `triggers.py`.
- `POST /automations/{id}/execute` `{ version?: "vN" | "draft" (case-insensitive),
  trigger?: "manual" | "menubar" (§4.5 kind, default "manual"; anything else answers 422) }` →
  `{ executionId }` (409 when every §6 `maxParallel` slot is taken — a manual start is refused, never
  queued; a version label that doesn't resolve answers 404)
- `POST /automations/{id}/queue/clear` → `{ cancelled }` — cancels every §6 firing-queue entry
  waiting on this automation (each finishes `skipped`, §4.6, and its sender is told). Running
  executions are untouched; use `POST /executions/{id}/cancel` for those. Answers `{cancelled: 0}`
  when the queue is empty rather than 404 — clearing an empty queue is not an error.
- `POST /app-started` `{ launchId }` → `{ fired }` — the §6 app-start firing path, called by the
  Electron main process once per app launch: starts an execution for every automation holding an
  enabled `app_start` trigger (one mid-execution gets a skipped record instead, §6); `fired`
  counts the executions started. **Idempotent per launch:** `launchId` is a uuid minted once per
  app process, and a repeat call carrying a `launchId` already served fires nothing and returns
  `fired: 0`. The caller retries while the backend is still coming up, and a response lost after
  the server already fired (socket reset, backend restarting mid-request) would otherwise execute
  every app-start automation a second time. One automation failing to start is logged and skipped
  rather than failing the batch — a 500 halfway through would leave the rest unfired and provoke
  exactly that retry.
- `GET /imessage/permissions` → `{ fullDisk: bool, automation: "granted" | "denied" |
  "unknown" }` — the §9 permission checklist's status source. `fullDisk` probes by opening
  the §6 chat.db read-only right now (false on permission error **or** missing file);
  never prompts. `automation` is the backend's remembered result of its most recent Apple
  Events send to Messages (probe, `reply()`, or busy notice) — macOS offers no
  prompt-free way to read it, so it is `"unknown"` until the backend has sent one this
  install (the remembered value persists in settings storage, §5)
- `POST /imessage/permissions/automation-probe` → `{ automation: "granted" | "denied" }` —
  fires a benign Apple Event at Messages.app (`osascript`: count chats), which makes macOS
  show the Automation consent prompt if the user has never answered it (and may launch
  Messages.app); the result updates the remembered `automation` state above. Called by the §9
  checklist's Grant button; blocks until the user answers the prompt
- `POST /automations` `{ draft, name?, agentId?, stepAgents?, allowedSecrets? }` → the new
  automation's bare §4 automation JSON — create v1 from the sent draft (the §11 Create
  button). The draft must hold steps (422 otherwise); its `triggers` list is validated and
  normalized exactly like the PATCH (422 aborts, nothing written), and the §8 step validators
  run server-side (rule below). `name` falls back to the draft's name, then "New automation";
  `stepAgents`/`allowedSecrets` land as the automation's grants exactly as sent (§20 grant
  model — no all-on seed), with one narrow default: when `stepAgents` is **omitted
  entirely**, the store seeds it with the drafting agent (`[agentId]`, empty without one) —
  an explicit empty list lands empty. Success consumes the §4.4
  pending create-mode slot (`<root>/draft/` is deleted on success)
- `POST /automations/{id}/versions` `{ draft, name?, agentId?, stepAgents?, allowedSecrets? }`
  — save edit as vN+1; the optional identity/grant fields, when sent, are applied to the
  automation as a patch after the version lands — the §20 push grant model rides this
  (the CLI sends the draft plus its computed `stepAgents`/`allowedSecrets` in the one call).
  The draft's `triggers`
  list (when the key is sent) replaces the automation's trigger list whole, validated and
  normalized like the PATCH (422 aborts the save; entries keep their `id`, new ones get one)
- **Server-side step validation** — `POST /automations` and `POST /automations/{id}/versions`
  run the §8 step validators (`ast.parse`, the §6.2 import allowlist, manifest schema and
  step-file ordering, the timeout/retry rules) on the sent draft and answer 422 with the
  validation errors when it fails — an invalid draft can never land as a version, whatever
  client sent it. The §20 CLI keeps its own pre-save copy of the same validators only for
  friendlier errors (one per line, nothing sent); the server check is the enforcement
- `GET/PUT/DELETE /draft/{owner}` · `POST /draft/{owner}/open` — the one draft-container
  surface (§4.4): `owner` is an automation id (that automation's `draft/` container) or the
  literal **`pending`** (the create-mode slot `<root>/draft/`). One container shape and one
  shared draft serializer for both owners — only the on-disk location differs (§5,
  unchanged). An automation `owner` that doesn't resolve answers 404. `PUT`
  `{ draft, agentId? }` stores the §4.4 snapshot: the payload's
  stepAgents/allowedSecrets/triggers/outOfSync are stored as draft-only keys and echoed back on the
  automation's `draft` object (or on `GET /draft/pending`), and its `chat` list (the §11
  thread) is stored as the container's `chat.jsonl` (§5) and echoed back the same way; for
  the `pending` owner the payload additionally carries the identity fields no automation
  record exists to hold (name and triggers ride the payload; `agentId` beside it). `GET` →
  `{ draft: payload | null, agentId }` (`draft: null` when the container is empty or
  absent). `POST /draft/{owner}/open` makes the container (`draft/` with an empty
  `memory/`) exist, never touching contents already there — the create flow calls it on
  open so the pending slot exists before any drafting or test. For an automation owner, PUT
  and DELETE answer 409 while a Draft-version execution is running (rewriting/pruning the
  draft's step scripts mid-run would break the per-step sha record). The §8 drafting-job
  endpoints (`POST /drafts`, below) are a different thing — jobs, not containers — and are
  unrelated to this surface
- `POST /automations/{id}/restore` `{ version }` — restore vX as vN+1, written through the
  §5 version-folder writer (manifest last as the commit point — never a tree copy)
- `GET /automations/{id}/export?values=0|1` — the §5.1 transfer archive as `application/zip`
  (`Content-Disposition` filename `<name>.autowright`, name sanitized for the filesystem);
  `values=0` omits `param_values` from the manifest (default `1`)
- `POST /automations/import` — the §5.1 archive as the raw request body
  (`application/octet-stream`, no multipart) → `{ automation, summary }` where `summary` is
  `{ secretsCreated, secretsExisting, agentsCreated, agentsReused, packages }` —
  `agentsCreated` is `[{ name, ready }]`, `ready` computed at import time by the one §19
  check-ready rule (`/agents/{id}/check`) for the created agent's harness/mode/model — it
  backs the §9.1 summary modal's Needs setup badge (created agents can share a name with a
  pre-existing local agent, §5.1, so the renderer can't look readiness up by name); the
  other three are name lists and `packages` the §6.2 declarations. Validates the whole
  archive first; any failure answers
  422 with the reason and writes nothing. Size caps (untrusted input): the upload itself is
  capped at 64 MB (413), one member at 32 MB decompressed and the whole archive at 256 MB
  decompressed (422) — a crafted archive can't balloon into memory
- `POST /automations/import/preview` — raw archive body exactly like `/automations/import`
  (same caps) → `{ token, preview }`: validates fully, writes nothing, parks the bytes under
  the one-time `token` (§5.2 — 15-minute expiry; at most 4 archives are parked at once, and
  a 5th preview evicts the oldest — a confirm against an evicted token answers 404 exactly
  like an expired one). `preview` is `{ name, description, steps: [{name,
  description, agent}], params: [{name, kind}], triggers, packages, agents: [{name, harness, mode,
  model, reused}], secrets: [{name, description, exists}] }` — `reused`/`exists` are the §5.1 match
  rules run dry
- `POST /automations/import/url` `{ url }` → same `{ token, preview }` shape plus
  `preview.sourceUrl` (as given) and `preview.resolvedUrl` (after §5.2 GitHub resolution;
  equal for direct links). Any §5.2 URL-rule failure — non-HTTPS, unresolvable page, download
  error, oversized or non-archive download — answers 422 with the reason
- `POST /automations/import/confirm` `{ token }` → `{ automation, summary }` exactly like
  `/automations/import`; the token is one-time — spent, expired, or unknown answers 404
- `GET /automations/{id}/memory/files` — read-only list of the §4.1 memory directory's
  files: `{ files: [{ name, size, updated }] }` — `name` the memory-relative posix path
  (recursive), `size` in bytes, `updated` the §4.1 display label; sorted by name; empty or
  missing memory → `[]`. No live-execution 409 and no lock: reads rely on the §6 atomic
  commit, so a whole file is always seen. Backs §20 `automation memory show`
- `GET /automations/{id}/memory/files/{name}` — one memory file's content:
  `{ name, size, text }` (`name` may contain `/` — the route takes the rest of the path).
  422 when `name` escapes the memory directory (absolute, `..`, or otherwise resolving
  outside it) or the file is not UTF-8 text (the message says the file is binary and names
  the memory path on disk); 404 when no such file. Same lock-free read rule as the list
- `POST /automations/{id}/memory/clear` — 409 while **any** execution of the automation is
  live, the same guard (and the same lock span) as manual snapshot and restore — a
  mid-execution clear could delete files a step is reading; then §6.3 pre-clear snapshot,
  then empty the §4.1 memory directory (backs §9.2 "Clear memory")
- `POST /automations/{id}/memory/snapshots` `{ name? }` — §6.3 manual snapshot (409 while
  live, 422 when memory is empty) · `PATCH /automations/{id}/memory/snapshots/{sid}`
  `{ name }` — rename; null/"" clears · `POST /automations/{id}/memory/snapshots/{sid}/restore`
  — §6.3 restore (409 while live) · `DELETE /automations/{id}/memory/snapshots/{sid}` —
  delete the snapshot; unknown `sid` answers 404
- `POST /tests` `{ automationId?, draft, enabledAgents?, allowedSecrets?, paramValues?, triggerMock? }`
  → `{ executionId }` — the §11 Test: starts a §4.5 **test execution record** of the sent draft's
  steps (§4.5 kind `test`, trigger kind `test` — serialized as `test: true`, `ver: "Test"`,
  `trigger: "Test"`; a stale `automationId` answers 404; 409
  while a test for the same draft container is executing; starting a test deletes the
  container's previous test record). Scratch memory is copied to a temp dir — when `automationId`
  is given, from its `draft/memory/` if present else its memory dir, else from the pending
  slot's `memory/` if present else empty — and discarded at test end. Grant arrays as in
  `/drafts`; param resolution uses the automation's stored values when `automationId` is given
  (else the draft's defaults), with `paramValues` (name → value, §5 matching rules) overriding
  on top for this test only — never stored; the resolved values are snapshotted on the
  record. `triggerMock` is the §11 mocked trigger message:
  `{ kind: discord | imessage, text, sender, channel?, secret? }` — 422 unless `text` and
  `sender` are nonempty strings, and for discord `channel` is a nonempty ASCII-digit string
  and `secret` a valid §4.8 secret name (the §4.3 trigger rules; iMessage takes no extra
  fields — `sender` is the handle). The backend builds the §4.5 payload from it (fields it
  can't truthfully supply are null — discord `channelName`/`guildName`/`guildId`/`messageId`,
  iMessage `chat`/`messageId`; `at` is the test start) and stores it on the record: the
  trigger kind stays `test` (`ver`/`trigger` still serialize "Test"), but `triggerSender`
  and every payload surface fill like a real message execution, and §6.1 `reply()` becomes
  callable (§6.1 mocked-payload rules). Progress, logs, and the result flow over the ordinary `execution.*` events and
  `/executions/*` endpoints; cancel and skip-step are `POST /executions/{id}/cancel` and
  `/skip-step` like any execution (retry answers 409 — the draft may have changed). A
  failed execution is **not** analyzed automatically — and there is no analysis endpoint:
  failure analysis is an ordinary `chat` drafting job whose §8 RECENT RUNS context carries
  the run's error and log tails (the §11 canned analyze messages; Fix-with-AI names the
  execution via the `/drafts` `runId` field). A finished test writes the §11 last-test summary
  (`test.yaml`, §5) into the draft container; it rides the draft payload as `test`
  ({ status: succeeded | failed, when, executionId }) on the automation's `draft` object and on
  `GET /draft/pending`.
- `POST /packages/check` `{ packages: [{ pip, import }] }` → `{ packages: [{ pip, import,
  status: installed | missing, version? }] }` — the fast §6.2 installed-check, never runs
  pip; `version` is the real installed version, present when installed (backs the §11
  Packages card's page-load check) · `POST /packages/install` (same body) →
  `{ packages: [{ pip, import, status: installed | failed, version?, error? }] }` — the §6.2
  ensure, blocking; installs only what's missing, one pip run at a time process-wide (backs
  the §11 Install/Retry button) · `POST /packages/outdated` (same body) → `{ packages:
  [{ pip, import, latest? }] }` — read-only PyPI query (§6.2: newest stable non-yanked
  version with a compatible wheel); `latest` present only when newer than the **installed**
  version, absent when not installed or on any lookup failure (backs the §11 page-load update
  check) · `POST /packages/update` `{ packages: [{ pip, import }] }` → `{ packages: [{ pip,
  import, status: installed | failed, version?, error? }] }` — `pip install --upgrade` for
  each named distribution in the shared directory (§6.2: wheels only, serialized); no
  manifest writes; a malformed name → 422
- `POST /drafts` `{ mode: create|chat|sync, automationId?, text?, spec?, current?, chat?, runId?,
  agentId?, enabledAgents?, allowedSecrets? }` → `{ jobId }` — `chat` requires a nonempty
  `text` (422 otherwise), takes the in-editor draft as `current` (name + description + spec +
  params + steps + instructions + notes; in chat mode with an `automationId`, absent `name`/`description`
  fall back to the stored automation's for the §8 AUTOMATION section) plus
  `chat` (the recent §11 thread entries for the §8 CONVERSATION section); the backend
  assembles the §8 RECENT RUNS and PACKAGES context itself (`runId`, optional, names an
  execution to include in full detail — the §11 Fix-with-AI entry; unknown ids are
  ignored), and the terminal
  payload is `draft: { answer?, spec?, instructions?, notes?, actions? }` — the §8 chat call's
  response shape decides which keys are present; an `automationId` that doesn't resolve
  answers 404 (like the stale-`automationId` 404 on `/tests`) — never a silent fall-back to
  the create-mode grant defaults below; the job's agent is the explicit `agentId` when sent,
  else the default agent — 404 when neither resolves to a configured agent (including the
  zero-agents case); the grant arrays, when present, override
  the stored automation's for the §8 grants context; when `enabledAgents` / `allowedSecrets`
  is absent and no stored automation exists (create mode — no `automationId` sent), the
  agents grant defaults to **all**
  configured agents and the secrets grant to **all** stored secrets — matching the all-on
  seeds the Review page starts from; clients track progress by polling
  `GET /drafts/{jobId}` → state (`status`, `stage`, live §8 `detail` line, the §8 `events`
  activity feed) + validated §8 draft payload — on a create job the payload
  carries call 1's validated spec as soon as the spec call completes (the §11 spec card renders
  it while the steps call is still working); a `blocked` job's state is
  `blocked` and it carries the §8 `blockers` list — each entry `{ reason, fix, details?,
  kind? }`, `kind` only ever `user-action` (§8) — plus `blockedAt: spec | steps | chat` (a create job
  blocked at the steps call keeps call 1's spec in its payload, so the §11 blockers entry can
  amend and rebuild it); a `blocked` job whose blockers came from the §8 build-diagnosis call
  (or its deterministic fallback) additionally carries `diagnosed: true`, and `failed` is
  reserved for harness errors and crashes — a validation double-failure always ends `blocked`
  (§8 failure policy); `DELETE /drafts/{jobId}` cancels
  (kills the harness process)
- `GET /executions?auto=&status=` (headers only — no steps; rows carry the §4.5
  `triggerSender`) · `GET /executions/{id}` (steps
  with attempts + params + error + result + `triggerPayload` (§4.5) — logs are lazy, never
  inline) ·
  `GET /executions/{id}/logs?step=&attempt=` → `{ lines: [{time, kind, sequence, text}] }` — both params
  select that step attempt's file, neither selects `logs/execution.ndjson`, a missing file
  answers empty lines ·
  `GET /executions/{id}/result/{name}` (raw result-dir file for the §7 file views; plain
  filenames only — no path traversal) ·
  `POST /executions/{id}/cancel` (a running execution is killed per §7; a §6 `queued` one leaves
  the queue and finishes `skipped`, with its sender told — the same endpoint covers both, and
  the queue check and the live check share one lock so an entry promoted between the click and
  the call can never be cancelled twice or missed by both) ·
  `POST /executions/{id}/retry` (§7 in-place retry; 409 unless failed and not live) ·
  `POST /executions/{id}/skip-step` `{ index }` (§7 skip; 409 unless that step is executing)
- `GET/POST /agents` · `PATCH/DELETE /agents/{id}` · `POST /agents/{id}/check` (health/badge)
  and `POST /agents/check-harness` `{ harness, mode?, model? }` (the same check before an agent
  record exists — onboarding's found-card auto-check) — one shared readiness check
  (`harness.check_ready`) decides ready vs. needs-setup everywhere: the harness binary must
  resolve (rule below). A custom-model agent (mode `custom`, §4.7) checks exactly like a
  default-mode one — the typed model string is never validated by the check (§4.7); a wrong
  name surfaces at invoke time. A local-model agent (mode `ollama` — Claude Code, Codex, or
  OpenCode, §4.7; the check answers needs-setup for Gemini CLI) additionally
  needs Ollama's server answering **and the agent's model installed** (the model appears in
  `/api/tags`; a bare name without a tag matches its `:latest` variant) — and needs **no**
  sign-in: a local model needs no account. A Claude Code local-model check additionally
  requires **Ollama ≥ 0.14.0** (the `version` from `/ollama/status` below) — the
  Anthropic-compatible `/v1/messages` endpoint Claude Code talks to (§6) shipped in 0.14.0,
  so an older Ollama reads needs-setup rather than failing at invoke time. An OpenCode
  local-model check additionally runs the opencode.json provider sync below (an unwritable
  config is a needs-setup condition, never a 500). Every default-mode check instead requires
  the harness to be signed in, by the per-harness rule below.
- **Sign-in state, per harness** (shared by `check_ready`, detection, and the signin poll):
  Claude Code — `claude auth status` exits 0 · Codex — `codex login status` exits 0 ·
  Gemini CLI — `~/.gemini/oauth_creds.json` parses as JSON carrying a refresh token (or
  `GEMINI_API_KEY` is set in the backend's environment — an API key counts as signed in) ·
  OpenCode — `~/.local/share/opencode/auth.json` parses as a JSON dict holding at least one
  known provider entry with a non-empty credential. File existence alone never counts: an
  empty, unparseable, or credential-less file reads signed-out — a stale artifact must not
  fake a working sign-in. Ollama is not a sign-in provider (no account; `POST /agents/login`
  answers 409 for it).
- `GET /agents/detect` (§10 detection) → one entry per harness, **all four always present**:
  `{ id, name, installed, signedIn, detail }` — `signedIn` is `true`/`false` by the rule
  above; `detail` is the real version/sign-in line rendered on §10 cards
  (never a fabricated "signed in" claim). Ollama state is not part of detection — the §10
  Free local AI card reads it from `GET /ollama/status`.
- **Install** — `POST /agents/install` `{ id }` starts a background install of that provider
  (409 while one is already running for the same id) and streams `harness.install` WS events
  `{ id, line, percent?, done, ok?, error? }` (determinate UI bar only when `percent` is present).
  One install renders as **one** continuous bar: `percent` never decreases across the install's
  phases, and download events carry the bare step label in `line` ("Downloading Codex") with the
  number riding only `percent` — post-download steps ("Unpacking…", "Starting the Ollama
  server…") keep the bar where it is while the step label explains the wait;
  `GET /agents/install/{id}` → `{ state: idle | running | done | failed, percent?, line?, error? }`
  lets a remounted UI reattach. A 15-minute wall-clock cap applies to each install phase
  (installer subprocess run and download): on expiry the job fails with a timeout message —
  it can never sit `running` forever and block retries. Channels, per provider — each
  vendor's own suggested install method, never sudo, never Homebrew (a vendor script adding
  its bin dir to the shell profile is vendor behavior we accept):
  Claude Code — the official installer script (`curl -fsSL https://claude.ai/install.sh |
  bash`), lands in `~/.local/bin/claude`, indeterminate ·
  Codex — the official installer script (`curl -fsSL https://chatgpt.com/codex/install.sh |
  sh`) with `CODEX_NON_INTERACTIVE=1` (the backend has no TTY to answer its "Start Codex
  now?" prompt); versioned payloads live under `~/.codex/packages/standalone` with a `codex`
  symlink in `~/.local/bin`, indeterminate ·
  Gemini CLI — `npm install -g --prefix ~/.local @google/gemini-cli` (npm is Google's only
  official channel; the `--prefix` is ours, keeping the install sudo-free — bin lands in
  `~/.local/bin`); without `npm` on this Mac the install fails fast with "Gemini CLI needs
  Node.js — install it from nodejs.org first, then try again."; npm runs with the augmented
  PATH below so its `#!/usr/bin/env node` shebang resolves; indeterminate ·
  OpenCode — the official installer script (`curl -fsSL https://opencode.ai/install | bash`),
  lands in the script's own default `~/.opencode/bin` (already on the fallback bin-dir list
  below; the live script ignores its documented `OPENCODE_INSTALL_DIR`, so no env is passed),
  indeterminate ·
  Ollama — the official Mac app: `Ollama-darwin.zip` from `https://ollama.com/download`
  (the exact payload the vendor's own install.sh ships), unpacked with `ditto` and moved to
  `/Applications` (or `~/Applications` when /Applications isn't writable); vendor-script
  parity: a running Ollama app is quit and an existing `Ollama.app` replaced first. A
  user-writable `~/.local/bin/ollama` symlink to the app's `Contents/Resources/ollama`
  stands in for the vendor script's sudo'd `/usr/local/bin` symlink. The app is then
  launched hidden (`open <app> --args hidden`) — its menu-bar agent owns the server and
  auto-updates — and the install waits up to 30 s for the server to answer; determinate
  (Content-Length). Ollama installs only as a piece of the local-model setup (§10 Free local
  AI card, §12 local-model mode) — it is never a harness.
- **Sign-in help** — `POST /agents/login` `{ id }` → `{ ok, method: browser | terminal }`,
  only for harnesses that need an account and aren't signed in (409 otherwise): Codex — the
  backend spawns `codex login` detached (the CLI opens the browser and completes on its OAuth
  callback), method `browser` · Claude Code / Gemini CLI / OpenCode — their login flows are
  interactive TUIs, so the backend opens Terminal.app via `osascript` running the harness's
  login command (`claude /login` / `gemini` / `opencode auth login`), method `terminal`.
  The Terminal command `cd`s into the provider's empty `harness/<provider-id>/workspace/`
  dir (§6) first — Terminal shells
  otherwise start in `~`, and the CLI's startup scan must not walk the home folder.
  `GET /agents/signin/{id}` → `{ installed, signedIn }` is the cheap poll (§10 waits on it
  every 2 s) — it runs only that provider's sign-in rule, never version lookups. For an
  ollama-mode agent `signedIn` is `null` — local models have no sign-in concept.
- Ollama: `GET /ollama/status` → `{ ready, installed,
  models, version }` (`version` from Ollama's `/api/version` when the server answers, else
  null — the §19 Claude Code local-model check gates on it), `POST /ollama/pull` — streams
  `ollama.pull` WS events `{ model, line, percent?, done, ok? }`. `line` is the raw
  `ollama pull` output line; `percent` is computed in the backend as **one overall pull
  progress**: byte-weighted across every layer seen so far in the stream (the
  `… 2.3 GB/5.2 GB` byte counts), falling back to the line's bare `N%` when no byte counts
  parse, clamped monotonic (never decreases within one pull), and 100 on the ok terminal
  event. Raw `ollama pull` restarts its own bar per layer (one multi-GB blob plus small
  metadata layers, then `verifying sha256 digest`/`writing manifest`) — those per-layer
  resets must never reach the UI as a bar reset, so clients render `percent` and never parse
  percents out of `line`. All CLI lookups (detection and harness invocation alike)
  resolve the binary via PATH plus the usual macOS install locations (`~/.local/bin`,
  `~/.opencode/bin`, `/opt/homebrew/bin`, `/usr/local/bin`; Ollama additionally `Ollama.app`),
  because a GUI-launched backend gets a minimal PATH — e.g. `claude` installs to `~/.local/bin`
  by default. Invocation uses the resolved absolute path, and every provider child the backend
  spawns (harness invocations, installs, version/status probes, login helpers, `ollama` pulls)
  runs with PATH prepended with those same install locations plus the resolved binary's own
  directory — otherwise `#!/usr/bin/env node` launchers (`npm`, `gemini`) fail with
  `env: node: No such file or directory` under the GUI minimal PATH even when Node is
  installed. If Ollama is installed but its server isn't
  answering (and `AUTOWRIGHT_OLLAMA_URL` is local), `/ollama/status` starts `ollama serve`
  once per backend process and waits briefly for it to come up — so an installed Ollama
  reads as ready instead of prompting a fresh download. Before every OpenCode local-model
  use (readiness checks and invocations alike), the backend syncs the Ollama provider entry
  into `~/.config/opencode/opencode.json` (merge, never overwrite: provider `ollama` via npm
  `@ai-sdk/openai-compatible`, `baseURL` = `AUTOWRIGHT_OLLAMA_URL` + `/v1`, the agent's model
  listed under `models`) so `opencode run --model ollama/<model>` resolves.
- `GET /secrets` (names + `description` + `set` + usedBy — a list of automation names — never
  values) · `PUT /secrets/{name}` `{ value, description? }` — `description` is
  presence-sensitive (`exclude_unset`): absent leaves the stored description untouched, sent
  (even blank) sets it. A blank
  value on a new name creates a §4.8 placeholder (`set: false`); on an existing name a blank
  value edits only the description — the presence rule is what makes that read; answers 503
  when the Keychain refuses the write · `DELETE /secrets/{name}` —
  values go straight to the Keychain, never
  into responses or files
- `GET /settings` · `PATCH /settings` (validates before storing: `days` must be an int —
  strict, no coercion, 422 otherwise — and is
  clamped ≥ 1, `notifications` must be `attention | all` — 422 otherwise, so a bad value can never
  persist and silently break the retention sweep; flipping `keepAwake` starts/stops the §3
  permanent power assertion immediately) · `POST /settings/data-path` `{ path }` (sets the
  execution-data location; creates the dir, reloads from it, moves nothing; answers 409 while
  an execution is in progress — it still writes into the old location — **or while a §6
  firing-queue entry is waiting**: the in-memory queue would not survive the reload, so the
  entry would neither execute nor finish `skipped`, and its sender would never be told)
- `WS /ws?token=` — events, each `{ event, ... }`: `execution.started` (also re-published when a
  failed execution retries in place — same execution id, updated record), `execution.queued`
  (a §6 firing was admitted to the queue — carries the new `queued` record, so it reaches the
  §7 executions list and the §9.2 "N waiting" line without a poll; promotion needs no second
  event, it publishes the ordinary `execution.started` for the same id), `execution.step`
  (status change; carries the full step incl. its attempts), `execution.log` (one NDJSON line with
  `stepIndex`/`attempt` — null for execution-level lines — and the per-file `sequence` for
  fetch-vs-stream dedupe), `execution.finished`, `automation.changed`, `agents.changed`,
  `secrets.changed`, `settings.changed`, `draft.changed` (the §4.4 pending slot was kept
  or discarded — clients re-`GET /state`; §11 test executions stream over the
  ordinary `execution.*` events),
  `harness.install` (provider install progress — the payload shape lives on the Install
  bullet above), `ollama.pull` (model-pull progress). Entity payloads ride the events under camelCase
  keys matching the REST shapes: `execution.started`/`queued`/`finished` carry `execution`
  (the record header, §19 executions-list shape) plus `automation` — the owning automation in
  list shape, or `null` when there is no row to patch (§11 test executions; an automation
  deleted before `finished`) — so clients patch the row (`lastStatus`, `live`, `nextAt`)
  without a poll; the merge rule below applies. A non-test `execution.finished` additionally
  makes a client holding that automation's **full** record re-`GET /automations/{id}`: the
  full-only fields (`latest`/`memory`/`snapshots`/`versions`) never ride events, and this
  refetch is what moves the §9.2 LATEST RESULT card (and the memory/snapshot lists) to the
  finished run. `automation.changed` carries `automationId` plus
  `automation` — the changed automation in list shape, or `null` when it was deleted —
  whenever exactly one automation changed; clients patch that one row in place by **merging**
  it over the stored record, never replacing it. The list shape lacks the full-record fields
  (`params`/`steps`/`latest`/`memory`/`snapshots`/`spec`/`packages`/`versions`/`draft`), so a replace
  would blank those fields on an open detail page — its sections unmount and remount around
  the follow-up full fetch, which reads as a page-refresh flicker, drops input focus
  mid-edit, and collapses the page height so the scroll position jumps to the top. A bare
  `automation.changed` (no `automationId`) means "many may have changed" (data-path switch,
  startup repair): clients fall back to re-`GET /state`, applying its list rows with the
  same merge. Clients also re-`GET /state` on reconnect. The handler streams from a hub queue while concurrently watching the socket for
  the client's disconnect, so a dropped client ends the handler immediately — an idle open
  socket never leaves uvicorn's graceful shutdown waiting.
