# Autowright SPEC — Storage

Part of the Autowright spec. Index and § map: [SPEC.md](../SPEC.md). § numbers are global across spec files.

## 5. Storage (decided)

**File-first everywhere: YAML/markdown files are the persistence. Each execution's full record
lives in `execution.yaml` inside its execution directory — the directory is fully
self-contained (record + logs + workspace + result). A SQLite database
(`<dataPath>/executions/executions.db`) exists only as a list/filter index over the execution
headers; the yaml is authoritative. All derived state lives in memory and is rebuilt from disk
at every startup.**

**Timestamps:** every stored timestamp — automation `created_at`/`updated_at`, version `when`,
execution `started_at`/`finished_at`/`queued_at`, step attempts, snapshot `created_at`,
log-line `timestamp`, draft `test.yaml` — is UTC ISO-8601 **with offset and microsecond precision**
(`2026-08-01T15:04:05.123456+00:00`). UTC with a fixed offset keeps lexicographic order equal
to chronological order, DST folds can't make times ambiguous or non-monotonic, and
microseconds make same-second starts (`maxParallel` > 1, queue promotions) order
deterministically. Conversion to the Mac's local time happens only when display labels are
serialized (§4.1 shared time labels).

On-disk layout under `~/Library/Application Support/Autowright/`:

```
settings.yaml
agents.yaml                    # agents list + default_agent (§4.7 single default-id pointer)
secrets.yaml                   # ids + names + metadata only; values live in the macOS Keychain.
                               # Every entry carries its §4.8 uuid; load self-heals an entry
                               # missing one (mints + persists it, like the default_agent
                               # pointer heal)
backend.json                   # port+token discovery handshake (§3), rewritten each backend start
electron/                      # Electron's Chromium profile (Cache, Cookies, Local Storage, …) —
                               # main.cjs redirects userData here so the root stays app data only
site-packages/                 # §6.2 declared packages, installed by the app via
                               # `pip install --target` — user-writable, survives app updates,
                               # safe to delete (re-ensured before the next execution)
harness/                       # per-provider workspaces for provider CLI children (§6)
  <provider-id>/               #   §19 provider id: claude · codex · gemini · opencode · ollama
    workspace/                 #   cwd for that provider's children (invocations, installs,
                               #   probes, login helpers) — created on demand, kept empty by
                               #   the app; keeps startup scans out of TCC-protected folders
draft/                         # THE pending create-mode draft (§4.4) — a single slot: created
                               # (with an empty memory/) the moment the create flow opens.
                               # Settling deletes the draft contents but never chat.jsonl —
                               # Create migrates the thread into the new automation's
                               # container; Start over / the §9.1 New-automation confirm
                               # leave it in the slot behind a §4.4 boundary marker; same
                               # container shape as automations/<uuid>/draft/ below — both
                               # are read and written by ONE shared draft serializer behind
                               # the §19 /draft/{owner} surface (owner `pending` here, the
                               # automation id there) — plus
                               # create-only identity keys in its automation/automation.yaml
                               # (name, description, agent_id, triggers, created_at, updated_at —
                               # no automation record exists yet to hold them); the grant
                               # selections ride the same draft-only step_agents /
                               # allowed_secrets / param_values / concurrency keys (and the
                               # §4.4 out_of_sync flag) as the
                               # edit-mode container below —
                               # there is no enabled_agents key anywhere in the slot:
  automation/                  #   the working copy (version-folder shape)
  memory/                      #   scratch memory copied by §11 tests; starts empty
  test.yaml                    #   §11 last-test summary — same shape as the edit-mode one
  chat.jsonl                   #   §11 chat thread — same shape as the edit-mode one; lives
                               #   at the slot root and OUTLIVES the draft (§4.4 thread
                               #   lifetime): written via §19 PUT /chat/pending, kept when
                               #   the slot settles, moved into the new automation's
                               #   container by Create; the §9.1 discard-and-start-new
                               #   confirm clears it (PUT of []) right after the discard
automations/<uuid>/
  chat.jsonl                   # §11 chat thread — one JSON object per line, the §4.4 entry
                               # shape ({id, kind, text?, title?, icon?, outcome?, boundary?,
                               # blockers?, source?, diagnosed?, dismissed?, resolved?, at});
                               # rewritten whole by §19 PUT /chat/{id}. Lives at the
                               # container root, NOT in draft/ — the thread outlives the
                               # draft (§4.4): settling (discard, save) keeps it and appends
                               # the §4.4 boundary marker; it is deleted only by §11 Clear
                               # chat (empty list unlinks the file) or with the automation.
                               # Transient entries (progress spinners) are never persisted.
  automation.yaml              # unversioned, mutable — user/operational state: id, name,
                               # description (§4.1: seeded from the create manifest, user-owned
                               # thereafter),
                               # current_version (pointer: current = versions/v<N>/),
                               # triggers [{id, kind, enabled, expression | at | channel+secret…}]
                               # (§4.3 stored fields per kind; never the derived
                               # label/short/connection), agent_id,
                               # enabled_agents (§4.7 agent uuids), allowed_secrets
                               # (§4.8 secret uuids),
                               # memory_snapshots {pre_version, pre_clear, pre_restore} —
                               # §6.3 automatic-snapshot toggles (absent keys default true),
                               # param_values {name: value} (user data, never pruned),
                               # max_parallel / max_queued — §6 concurrency settings
                               # (absent keys default 1 and 0),
                               # created_at, updated_at
  memory/                      # memory directory carried between executions (engine contract, §6) — scripts
                               # store whatever files and formats they need; shared across
                               # versions. Concurrent executions of one automation share this
                               # dir (§6): memory.save commits atomically (temp file in the same
                               # dir, then rename), so no reader ever sees a partial file
  memory-snapshots/<uuid>/     # §6.3 point-in-time memory copies, each self-describing:
                               # snapshot.yaml (id, name, reason, created_at, version, size,
                               # files) + memory/ (the recursive copy); no index file — the
                               # list is read from disk on demand; a dir without snapshot.yaml
                               # is a crash orphan (skipped, swept at the next creation)
  .ad-tmp-memory/              # §6.3 restore staging, transient: the snapshot's memory copy
                               # is staged here, then swapped into memory/ by rename;
  .ad-old-memory/              # holds the displaced memory/ during that swap. Both are
                               # deleted at the end of a restore, but a crash mid-swap can
                               # leave them on disk — the next restore recovers
                               # .ad-old-memory back to memory/ when memory/ is missing
                               # (the aside dir is then the sole surviving copy), then
                               # deletes both before staging again
  draft/                       # unsaved edit state — a container, not a version folder:
    automation/                # the working copy, same shape as a version folder; replaced
                               # whole on every draft save by a staged-dir swap (written
                               # beside as .ad-new-automation, old renamed to
                               # .ad-old-automation, new renamed in, aside deleted — a crash
                               # at any point leaves the old or the new copy complete, never
                               # a mix; loads and saves repair a half-finished swap first);
                               # its automation.yaml also holds
                               # draft-only step_agents / allowed_secrets / triggers /
                               # param_values / concurrency / out_of_sync keys (§4.4 — the
                               # editor's grant
                               # selections, trigger list, §4.2 chat-staged value map, §8
                               # chat-staged concurrency object, and
                               # §11 dirty-gate state;
                               # never written for real versions)
    memory/                    # the draft's own working memory: created on the first Draft
                               # execution as a copy of memory/, reused by every later Draft
                               # execution and draft re-save, deleted with the draft — Draft
                               # executions never touch the live memory/ dir
    test.yaml                  # §11 last-test summary: status (succeeded | failed),
                               # when (finished-at ISO timestamp), and execution_id —
                               # written when a test ends, wiped at each test start, deleted
                               # with the draft; lets a resumed draft's Build & test panel show the
                               # last outcome and link to the test's execution page. The
                               # test's workspace/result/logs live on its execution record
                               # (§4.5 test executions), not in this container.
  versions/vN/                 # one folder per version — immutable once written
    automation.yaml            # when, note, param definitions (§4.2: name, kind,
                               # label, help, default, …) + ordered steps manifest:
                               # steps: [{file, name, description, agent?, why?, agents?, secrets?,
                               #          packages?, timeout?, no_timeout?, retries?, infinite_retries?}]
                               #          (§4.1 per-step time limits and retry pair — both
                               #          also travel in §5.1 archives; agents entries are
                               #          {id, why?} — §4.7 agent uuids — and secrets entries
                               #          {id, why} — §4.8 secret uuids; the whys are the
                               #          §4.1 per-agent role notes and per-use secret notes)
                               # + declared packages (§6.2, absent when none):
                               # packages: [{pip: pandas, import: pandas, why: one-line purpose}]
    spec.md                    # the version's spec as plain markdown (h1/h2/li/p blocks)
    instructions.md            # user's free-text instructions to the agent (§4.1 instructions),
                               # plain markdown; absent when none were given
    notes.md                   # the §4.1 agent-owned notes document, plain markdown;
                               # absent when empty
    NN-name.py                 # step scripts as real files, beside the manifest —
                               # agent- and human-editable
```

**Logs live outside the data dir**, at `~/Library/Logs/Autowright/` (macOS convention;
Console.app picks them up): `app.log` (backend application log), `backend.out.log` /
`backend.err.log` (launchd stdout/stderr), and dev.sh's `vite.log`. With `AUTOWRIGHT_HOME` set
(§15) logs go to `<home>/logs/` instead, keeping dev/test sessions fully isolated.

**Log size cap:** each backend log (`app.log`, `backend.out.log`, `backend.err.log`) is
capped at 100 MB. At backend startup, before anything logs, any file over the cap is trimmed
in place to its newest 50 MB (half the cap, so a saturated log is not rewritten on every
boot) — oldest lines are deleted first, cutting at the next line boundary. Trimming is
in place (read the tail, rewrite from offset 0, truncate) because launchd holds
`backend.out.log`/`backend.err.log` open in append mode — rename-based rotation would leave
the live fd writing to the renamed file. `vite.log` is exempt: dev-only, and every `dev.sh`
run already truncates it.

**Agent-request framing in `app.log`:** every agent request (each `harness.invoke()` call —
drafting calls, repair rounds, and runtime agent steps alike) is written to `app.log` as one
framed block: a header line `>>>>> BEGIN YYYY-MM-DD HH:MM:SS TZ UUID <<<<<` when the request
is sent, then the request info (harness, model, prompt size) and the full prompt, then the
raw response (or the error, on failure/timeout), closed by a footer line
`>>>>> END YYYY-MM-DD HH:MM:SS TZ UUID <<<<<` when the request ends. `UUID` is one random
UUID (v4) per request, identical in a request's header and footer, so the pair can be matched
when concurrent requests interleave. Timestamps are US Pacific time (`America/Los_Angeles`,
so `PST`/`PDT` per season). The framing lives in `harness.invoke()` itself so no call site
can miss it.

**Request logging (behind the §4.9 `developerMode` setting):** while Developer mode is on, the
backend logs to its console every HTTP request it serves (uvicorn access log at `info` level —
stdout, so `backend.out.log` under launchd) and every agent request — one `autowright.harness`
INFO line per `harness.invoke()` with the harness, the model (agent's, else the literal
"configured default"), and the full prompt (stderr, so `backend.err.log`). Implemented as a logging filter that reads the live setting on
every record, so flipping the toggle applies immediately with no backend restart; while off,
only WARNING+ prints. The same filter scrubs the auth token from every logged request line
(`token=…` query values become `token=***` — the WS handshake carries the token in the query
string, and the access log would otherwise copy the sole credential into `backend.out.log`,
which is not 0600 like `backend.json`). The filter rides in on uvicorn's `log_config` handlers (uvicorn's own
dictConfig would wipe a filter attached to its loggers beforehand) and on the root handler for
`autowright.*` logs.

**Request-log files (behind the same `developerMode` setting):** while Developer mode is on, the
backend also writes **one file per request** under `<logs dir>/requests/` — both HTTP requests
served by the API and agent requests (`harness.invoke()`), interleaved in one directory. File
name: `<YYYYMMDD-HHMMSS-mmm>_<TAG>_<detail>.log` — Pacific-time stamp (millisecond precision;
lexicographic order ≙ chronological order), then the tag and detail:

- **HTTP requests** (a pure-ASGI middleware wrapped around the FastAPI app; skips the `/ws`
  WebSocket): tag = the HTTP method, detail = the URL path (leading `/` stripped, runs of
  characters outside `[A-Za-z0-9._-]` collapsed to one `-`; bare `/` → `root`). Content: the
  request line (method + path + query, `token=…` scrubbed to `token=***`), the request headers
  (`Authorization` value redacted), the request body, then the response status, duration in ms,
  and the response body. Bodies are captured up to 256 KiB each (a truncation note replaces the
  excess); non-UTF-8 bodies log a `<binary, N bytes>` note. Any request whose path starts with
  `/secrets` has both bodies replaced with a redaction note — secret values never touch disk.
  The request body is whatever the handler consumed (an unread body logs empty).
- **Agent requests**: tag = `AGENT`, detail = the harness name. Written by `harness.invoke()`
  itself (beside the always-on `app.log` framing above, which is unchanged) when the request
  ends: harness, model, prompt size, the full prompt, then the full raw response — or the
  error, on failure/timeout — and the duration. Never truncated, mirroring the framing.
  Agent requests get their own files (rather than riding inside an HTTP request's file)
  because no agent call happens inside an HTTP handler — drafting runs in background job
  threads and runtime steps in the engine; chronological interleaving in the directory is the
  association.

The file name stem is capped at 96 characters (long URLs truncate); a name collision appends
`_2`, `_3`, …. The directory keeps the **newest 500 files** — each write prunes older ones —
so polling endpoints can't grow it without bound. Writes are best-effort (an `OSError` never
fails the request) and the whole feature is inert while `developerMode` is off. The gate reads
`developerMode` straight from `settings.yaml` (cached 1 s) rather than from the in-memory store:
`harness.invoke()` also runs inside the executor subprocess, whose store is never loaded — the
file is the truth both processes see, and the toggle stays live without a restart. The §9.3
developer log overlay's Requests tab lists and renders these files.

**Build-failure records (behind the same `developerMode` setting):** while Developer mode is on,
every §8 drafting call (spec or steps) whose response fails validation writes **one file per
call**, when the call settles, under `<logs dir>/build-failures/` — the raw material for later
improving the §8 agent instructions. File name: `<stamp>_<mode>-<call>_<outcome>.log` (same
Pacific millisecond stamp; `mode` the §8 job mode, `call` `spec` or `steps`), `outcome` one of
`repaired` (a repair round produced a valid envelope), `blocked` (a repair round returned
a valid blocker envelope), or `diagnosed` (every §8 repair round failed — the §8 build-diagnosis
blockers, agent-written or the deterministic fallback, land in the record). Content: a header
line (mode, call, harness, model, outcome), then each invalid round's **full** validation
error list and **full** raw response (never truncated, never clipped), the diagnosis blockers
when present, and finally the call's original prompt — self-contained, no cross-referencing
the request-log files. The directory keeps the **newest 200 files**; writes are best-effort
with the same live `developerMode` gate as the request-log files above. A validation failure the
user never sees (a repair round fixed it) still records — near-misses are exactly the
instruction-tuning signal.

A version folder holds **what the agent wrote** (spec, instructions, steps + scripts, param
definitions); the top-level `automation.yaml` holds **what the user owns and operates**
(identity — name and description, triggers, param values, agent choice, permission grants). Two consequences:

- **Permissions are never versioned.** `enabled_agents` and `allowed_secrets` are grants; they
  live only in the top-level file. Restoring or executing an old version must never silently
  re-grant a revoked secret or agent — a vX step needing a now-disabled agent/secret fails with
  the existing warnings (§11).
- **Params split into definitions (versioned) and values (top-level).** At execution/restore time
  they're matched by name and kind: match → current value; param since removed → last stored
  value (values are never pruned), else the definition's default; kind mismatch → default plus
  a `wrn` log line, never silent coercion. Every definition carries a default (§4.2).

There is no top-level copy of the "current" spec or steps: the current version is simply
`versions/v<current_version>/`, resolved through the `current_version` pointer in
`automation.yaml`. Saving an edit writes a fresh `versions/vN+1/` folder, then atomically
rewrites `automation.yaml` to flip the pointer (and apply any agent/secret/param changes) —
versions are append-only and never edited in place; only `automation.yaml` and `draft/` are
mutable. The version-folder writer has one commit discipline: step scripts, spec, and the
markdown documents land first, the folder's `automation.yaml` (the manifest) is written
**last** as the commit point — a folder without it is never adopted by the startup walk.
"Restore vX as vN+1" (§4.4) writes the new folder through that same writer from vX's loaded
content — never a direct tree copy — so a crash mid-restore leaves no adoptable folder,
just an incomplete directory the next save overwrites.

Executions live under `<dataPath>/executions/` — unless the configured directory is itself
named `executions`, in which case it is used directly rather than nested again (the §4.9
default `…/Autowright/executions` already ends in it; a consequence is that any user-chosen
folder named `executions` becomes the executions dir itself). Movable via Settings → Change
data location; automations stay put:

```
executions/
  executions.db                # SQLite (WAL) — a pure list/filter INDEX over execution
                               # headers; `execution.yaml` is authoritative, the engine
                               # writes both together (yaml first). One table:
                               #   executions: id (uuid PK), automation_id (NULL on
                               #     create-mode tests, §4.5), automation_name
                               #     (snapshot at execution time — display fallback only),
                               #     kind (version|draft|test) + version (int, NULL unless
                               #     kind is version — §4.5; labels are derived, never
                               #     stored), status, trigger (§4.5 machine kind),
                               #     trigger_sender (§4.5 — NULL unless message-triggered),
                               #     queued_at, started_at /
                               #     finished_at (UTC ISO-8601 microsecond TEXT — the §5
                               #     timestamp form, so lexicographic order = chronological
                               #     and the §5 same-second ordering promise survives a
                               #     restart; finished_at NULL while executing. The schema
                               #     version is bumped for this shape; a version mismatch
                               #     drops and rebuilds the index from the yamls — no
                               #     migration code),
                               #     duration_ms, note, chip / chip_status (§4.5 — NULL when the
                               #     execution set no chip), error_step / error_message /
                               #     error_reason (§4.5 — NULL unless failed; denormalized
                               #     mirrors so list surfaces render without a yaml read)
                               #   indexes: (started_at DESC, id),
                               #     (automation_id, started_at DESC),
                               #     (status, started_at DESC)
  <execution-uuid>/
    execution.yaml             # the full execution record (§4.5): header fields (kind,
                               # version, trigger kind) plus params (snapshot),
                               # redacted_secrets, error,
                               # note, and steps[] with per-step attempts[] ({number, status,
                               # started_at, duration_ms, error? on failed attempts}); rewritten
                               # atomically (temp+rename) on every transition
    steps/                     # §11 test executions only: the sent draft's step scripts as
                               # executed — a real version folder serves that role for
                               # ordinary executions
    logs/
      execution.ndjson         # execution-scoped log lines: package installs, secret
                               # failures, the manual in-place retry marker, the final
                               # failure line (automatic step-retry markers land in the
                               # new attempt's file below, §7)
      <stem>.a<n>.ndjson       # one log file per (step, attempt) — <stem> is the step's
                               # script file stem ("01-fetch-pages"), n the attempt number;
                               # line shape {timestamp, kind: sys|out|wrn|err, sequence, text} —
                               # timestamp the §5 UTC form. Serialization derives a local clock
                               # label `time` (never stored): the storage read adds it beside
                               # `timestamp`; the §19 wire shape replaces the UTC field —
                               # lines travel as {time, kind, sequence, text}. sequence is
                               # a per-file monotonic counter (renderer dedupe, §19); the
                               # file for (step, attempt) is derived by convention from
                               # execution.yaml — no index anywhere. §4.5 attempt prune:
                               # when a step's attempts[] exceeds 20 the oldest entry is
                               # dropped and its .a<n> file deleted with it (§7 step retry
                               # would otherwise grow this dir without bound)
    workspace/                 # cwd for every step of this execution — disposable per-execution
                               # scratch space, shared across steps (step 1 writes a file,
                               # step 2 reads it) and across retry passes (§7); deleted with
                               # the execution by retention
    result/
      <files>                  # any files the execution writes via result.path (result.md,
                               # result.html, images, CSVs, …) — no manifest, the dir
                               # listing is the file list
```

**Load model:** automations are **fully loaded at startup** — the backend walks `automations/`,
parses every top-level `automation.yaml` plus each `versions/vN/` folder (its `automation.yaml`
+ `spec.md` + `instructions.md` + `notes.md` + step scripts), and serves all automation reads (lists,
detail, scheduler, menu bar) from memory. There is no automations table: the YAML files plus the
startup walk are the whole story. The id → path map and `nextAt` are derived in memory
during/after the walk, and the walk loads any stored draft straight onto the record;
execution-derived display state (`last_status`, `last_execution_at`, and the set of executing
execution ids — serialized as the §4.1 `live` list, several at once under `maxParallel`) is
filled by one startup query for the latest execution
per `automation_id` and kept current as executions complete; `resultChip`/`resultStatus` read straight
off that latest execution's header (§4.5) — never from `result/`. `skipped` records never count as the
"latest" execution for this display state — they never ran, and §4.1's `lastStatus` vocabulary
excludes them (a mid-execution trigger skip must not shadow the live execution's final status/chip).
`test` records (§4.5) never count either — a draft test must not change what the automation's
list row, detail page, or menu bar report about real executions.

Executions load **headers-eagerly, bodies-lazily**: startup reads every header row from the
`executions.db` index into an in-memory `executions` table — one header per execution with
`id, automation_id, status, trigger, kind, version, queued_at, started_at, finished_at, duration_ms`, plus the
light display fields (`automation_name`, `note`, `chip`/`chip_status`, `trigger_sender` —
the §4.5 `triggerPayload` sender for list rows, stamped onto the header **once at record
creation** from the trigger payload; every reader takes it from that field alone, never by
reaching into the payload — there is no dual-shape fallback — the §4.5 `error`
fields) — kept queryable by `trigger`, `status`, `automation_id`, and `started_at`; paths
resolve on demand from the id. The body (`execution.yaml` — steps, attempts, params,
redacted names — plus `result/` and log files) is read only when an execution is opened; the
live execution's in-memory record is the engine's own full record, so it needs no disk read.
**On a terminal status transition the stored record is demoted to the same header projection
the DB index uses** — the full body stays lazy behind its `execution.yaml`, re-read on the
next open like any settled execution, so full bodies are never pinned in memory for the
backend's lifetime.
The in-memory table is rebuilt from the DB at every launch. An automation folder whose
`versions/` is empty cannot resolve a current version and is skipped at startup with a
warning in the app log. Every top-level YAML file is hand-editable, so an unreadable one —
invalid YAML or invalid text encoding alike — loads as its default with a warning in the app
log; a damaged file never bricks startup into a launchd crash loop.

Rules:

- Every write goes disk-first (atomic temp-write + rename for files — `execution.yaml`
  included; a committed transaction for the `executions.db` index), then the in-memory state
  updates. A crash between the two self-heals at the next startup, since startup rebuilds
  everything from disk: after loading the DB index, startup scans `executions/` for
  directories the index doesn't know (crash between the yaml write and the DB upsert, or a
  DB schema wipe) and restores their header rows from `execution.yaml` — the yaml stays
  authoritative. Nothing exists only in memory.
- Retention cleanup (§4.9 `days`) deletes execution directories and DB rows, then their
  in-memory records. Records still `executing` or waiting in the §6 queue (`queued`) are
  exempt — deleting a queued record would silently drop a firing that never ran.
- Changing the data location (§4.9) closes the DB connection first, updates `dataPath`, then
  reloads everything from the new directory. Nothing is moved — execution state is wholly
  contained in the executions dir, so there is no migration step.
- Logs stream as append-only NDJSON — nothing else written on the execution hot path; CLI can
  tail/grep them directly. **Line cap:** a per-attempt log file stops appending at 10,000
  lines — one final `sys` marker line records the truncation, then nothing more lands in
  that file (the step itself keeps executing). `logs/execution.ndjson` has the same cap. A
  runaway step can't fill the disk through its logs.
- Secret values never appear in any file — Keychain only, keyed by the secret's §4.8 id
  (the keyring account string), so metadata edits never touch the Keychain and the entry
  needs no rename path.

**Terminology:** **execution** is the one and only term for a single occurrence of an
automation — in files, code, APIs, and UI copy alike. The verb form is **execute** ("Execute
now", "Executing"). The word "run" is never used for this
concept anywhere; "running" survives only in its ordinary process sense (a daemon or the
backend being up).

**Directory naming:** automation directories are named by the automation's UUID — the same
`id` as in `automation.yaml`, so path and identity always agree, no collision handling exists,
and renaming an automation touches only the `name` field (the directory never moves). For
human browsability the folder name is intentionally traded away; the `name` inside
`automation.yaml` is the readable label. Execution directories are flat under `executions/`
and named by execution uuid; each execution record carries `automation_id` for the link back.

**Cross-references:** everything references an automation by `id` only — never by name.
The execution page resolves `automation_id` through the backend's in-memory automations to the
current path and current name (so renames show up everywhere immediately). The execution record also snapshots
`automation_name` at execution time as a display-only fallback: when the automation has been
deleted, its executions still render with the historical name (marked deleted). The snapshot is
never used for lookups.

### 5.1 Transfer archives — export / import (decided)

An automation can be exported to a single shareable file and imported on any machine. The file
is `<name>.autowright` — a plain zip. **References plus safe metadata travel; credentials,
grants, uuids, and local state never do.** Archive layout:

```
manifest.yaml                # format_version: 1 (import rejects any other with 422),
                             # exported_at, app_version (diagnostics only), name,
                             # agent: the drafting agent's name (absent when none) — names
                             #   the agents.yaml entry the imported agent_id maps to,
                             # triggers: [{kind, expression? | timezone? | channel+secret… | from…}] —
                             #   cron, app_start, discord, and imessage (§4.3 stored
                             #   fields; the token itself never travels, and a discord
                             #   entry's `secret` is the secret's NAME — export resolves
                             #   the trigger's §4.3 secret id to its name, import maps it
                             #   back to the local record's id); no ids,
                             #   no enabled state; one-shot `time` triggers are moments
                             #   in time and are never exported,
                             # param_values: {name: value} — only when "Include parameter
                             #   values" was checked at export
automation/                  # exactly the §5 version-folder shape; import copies it
  automation.yaml            #   description, param definitions, steps manifest, packages —
                             #   no when/note (import stamps v1 fresh), never the
                             #   draft-only step_agents/allowed_secrets/triggers/param_values/concurrency keys
  spec.md                    #   verbatim
  instructions.md            #   verbatim; absent when none
  notes.md                   #   verbatim; absent when empty (§4.1 notes)
  NN-name.py                 #   every step script, verbatim
agents.yaml                  # configs of referenced agents (the automation's drafting
                             # agent + every agent referenced by a step's agents: entry
                             # ids, resolved to names at export):
                             # [{name, description, harness, mode, model}] — no ids, no credentials
secrets.yaml                 # referenced secret names (union of every step's secrets:
                             # entry ids and code-referenced ids — resolved to names at
                             # export — and every
                             # discord trigger's bot-token secret):
                             # [{name, description}] — never values
```

**Identity across machines.** Uuids are meaningless on another Mac, so none travel and import
mints everything fresh: a new automation id + directory, new trigger ids. Secrets are matched
by **name** (unique + immutable, §4.8); agents are matched by name + config. Step and trigger
references **translate at the boundary** (well-defined, since names are unique on both
sides): export rewrites ids to names — step `agents:`/`secrets:` entries become
`{ name, why }`, the literal `secrets["<id>"]`/`agents["<id>"]` code subscripts become
`secrets["<NAME>"]`/`agents["<Name>"]` (any §6.1 trailing `# NAME` comment travels verbatim —
it names the name, so it stays accurate in both forms), and a discord
trigger's `secret` id becomes the secret's name — and import rewrites the names back to the
matched/created records' **local ids**, manifest entries and code subscripts alike. An
export reference whose id matches
no stored record answers 422 naming the step (or trigger) — a dangling reference must be
repaired before the automation can travel, since there is no name to carry it. Import
symmetrically rejects an archive that still carries id-form step entries or uuid code
subscripts ("re-export the automation"). Inside an
archive, names ARE the reference format; on disk they never are (§4.1/§4.3/§4.8: ids only).

**Import behavior** (the whole archive validates before anything is written — any failure
answers 422 and writes nothing):

- Validate: `format_version`, every yaml's schema, step files matching the steps manifest
  (step `agents:`/`secrets:` entries in the archive's `{ name, why }` form — the §4.1 id
  form is rejected: ids never travel), §4.2 param kinds, §4.7 agent configs
  (harness/mode/model rules), §4.8 secret names, trigger
  kinds with at most one `app_start`. Imported steps obey the §8 step bounds: `retries`
  is 1–10, `timeout` never combines with `no_timeout`, and `retries` never combines with
  `infinite_retries` — an archive can't land a step no drafting call could produce. Step
  filenames obey the §8 `NN-name.py` rule in listed order (`01-…`, `02-…`), like every other
  ingest path — otherwise the app's own save endpoints would 422 on a version import created.
- The automation lands as **v1** of a brand-new automation (note "Imported") — version history
  is local editing history and never travels. Duplicate names are fine (§5 directory naming);
  re-importing your own export creates a copy, never overwrites.
- Every trigger imports **off** — nothing fires unexpectedly on a new machine.
- `param_values` from the manifest seed the top-level file (§5 name+kind matching applies at
  execution time as usual); absent values fall back to definition defaults.
- **Secrets:** a referenced name that doesn't exist locally is created as a §4.8 placeholder
  (`set: false`, description from the archive). An existing name is the same secret by definition —
  left completely untouched.
- **Agents:** an archive agent matching a local record exactly (name + harness + mode + model)
  reuses it; otherwise a new record is created with the archive's config — same name even when
  a differently-configured local agent already holds it (step grant names resolve against the
  automation's enabled agents only, §6, so both automations keep resolving to the agent they
  mean; the §6 first-enabled-wins rule already covers an automation granting both). A created
  agent whose harness isn't installed or signed in surfaces through the ordinary §12/§19
  install and sign-in flows. The drafting `agent_id` maps to the matched/created record; an
  archive with no agents falls back to the local default agent.
- **Grants — auto-grant only what the import itself created.** Created placeholder secrets
  (valueless — nothing to leak) and created agents (exactly the exporter's config) are granted
  on the new automation — passed **directly into the automation-creation call** as its grant
  lists (one write): there is no post-create grant patch, so no window ever exists in which
  the automation is stored with different grants than it ends up with, and a wiring mistake
  can never momentarily grant a pre-existing local agent. Anything that matched a
  **pre-existing** local record is *not*
  auto-granted — silently granting would hand the imported automation a real local credential
  or agent; the §9.1 import summary lists each for one-click review in the editor.
- Memory starts empty; no executions, snapshots, or drafts are created.

The import response carries a **summary** — secrets created (need values), existing secrets
referenced but not granted, agents created (each with a `ready` flag — the §19 check-ready
rule run at import time on the created agent's harness/mode/model, so the §9.1 modal badges
a not-ready harness Needs setup) vs. reused, declared packages (the app installs
them on first execution as usual, §6.2; a §20 CLI import runs the ensure right away) —
rendered by the §9.1 summary modal.

### 5.2 URL import (decided)

An archive can be imported straight from the web: the backend downloads it and runs the §5.1
import path unchanged — same validation, same 422-writes-nothing rule, same summary. The
security posture is §5.1's, unchanged: triggers land off, created secrets are valueless
placeholders, nothing pre-existing is auto-granted.

**URL rules** — anything that fits no rule answers 422 with the reason:

- HTTPS only; plain `http://` is rejected.
- A URL whose **path ends `.autowright`** downloads directly — any host (GitHub release
  assets, `raw.githubusercontent.com`, gist raw links, any web server).
- A **`github.com/{owner}/{repo}`** page (optional `.git` suffix, trailing `/`, or `/releases/latest`)
  resolves through the unauthenticated GitHub API: the latest release's first asset named
  `*.autowright`; when the repo has no release with such an asset, the repo root's file
  listing, first `*.autowright` alphabetically. `github.com/{owner}/{repo}/releases/tag/{tag}`
  resolves against that release's assets. Public repos only — no token ever travels.
- Download: `User-Agent: autowright/<version>`, 30-second timeout, streamed with the §5.1
  64 MB archive cap enforced during the read — an oversized or non-archive download is a 422,
  and the §5.1 decompression caps still apply after.

**Preview + confirm.** Import from the UI is two-phase, so the user reviews exactly the bytes
that will land (no re-download between review and import):

- §19 `POST /automations/import/url` (a URL) and `POST /automations/import/preview` (raw
  archive bytes — the file path through the same review step) validate the archive fully,
  write nothing, and park the bytes in backend memory under a one-time **token** (15-minute
  expiry; a handful of slots, oldest evicted). The response carries the token plus a
  **preview**: name, description, steps (name/description/agent flag), param definitions, triggers,
  declared packages, and the §5.1 match rules run dry — each referenced secret with
  `exists`, each agent with `reused`; URL fetches add `sourceUrl` (as pasted) and
  `resolvedUrl` (after GitHub resolution; equal for direct links).
- `POST /automations/import/confirm` `{token}` lands the parked bytes through the §5.1
  import. A spent, expired, or unknown token answers 404.
- The one-shot `POST /automations/import` (raw body, §5.1) stays for callers that need no
  preview: the §20 CLI file import and the §17 agent skill.

The UI flow is the §9.1 import modal. The §20 `automation import` accepts a URL and confirms
immediately — the typed command is the user's explicit action, so no interactive preview.

