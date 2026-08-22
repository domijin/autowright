# Autowright — SPEC

Source of truth. Holds enough detail to rebuild the app from scratch, including the pixel-exact
values where they matter (colors, spacing, typography) — §14 is the authoritative design-token
sheet, implemented in code by `app/src/tokens.css`.

The spec is split across this index file and `spec/*.md`. § numbers are global across all spec
files; the map below says which file holds each section. Read this file first, then open only the
spec files the task touches. Keep the map current when sections are added or moved.
The spec is written in English only — every word, including quoted UI copy and examples; no
words from other languages except established technical terms.

**Section map** — ordered so later sections build on earlier ones:

- **Foundations:** §1 product · §2 components (both below, in this file) ·
  §3 packaging & process lifecycle → [spec/packaging.md](spec/packaging.md)
- **Data:** §4 data model (entities) → [spec/data-model.md](spec/data-model.md) ·
  §5 storage (files on disk, incl. §5.1 transfer archives · §5.2 URL import) →
  [spec/storage.md](spec/storage.md)
- **Runtime:** §6 engine contract & framework policies (incl. §6.1 step SDK · §6.2 curated
  packages · §6.3 memory snapshots) → [spec/engine.md](spec/engine.md) ·
  §7 execution lifecycle → [spec/execution.md](spec/execution.md) ·
  §19 backend API → [spec/backend-api.md](spec/backend-api.md) ·
  §20 CLI → [spec/cli.md](spec/cli.md)
- **AI:** §8 agent drafting contract → [spec/agent-pipeline.md](spec/agent-pipeline.md)
- **UI:** §9 shell & navigation (incl. §9.1 automations list · §9.2 automation detail ·
  §9.3 developer log overlay · §9.4 about page · §9.5 report issue modal) ·
  §10 onboarding · §12 agents & secrets pages · §13 menu bar →
  [spec/ui-shell.md](spec/ui-shell.md) ·
  §11 create/edit flow → [spec/ui-create-edit.md](spec/ui-create-edit.md) ·
  §14 design tokens → [spec/design-tokens.md](spec/design-tokens.md)
- **Dev:** §15 dev/test knobs · §16 test seed data · §18 commands →
  [spec/dev-test.md](spec/dev-test.md) · §17 repository (below, in this file)

## 1. Product overview

Autowright is a desktop app for recurring personal automations — macOS and Windows (the §2
platform layer holds every OS-coupled seam; macOS is the original platform). The user
describes a job in
plain words ("Check the manga I follow for new chapters every morning at 8"); a connected AI agent
(Claude Code, Gemini CLI, Codex, or OpenCode — the latter optionally driving a local Ollama
model) writes it as human-readable
scripts; Autowright executes those scripts on a schedule, entirely on the user's machine,
and shows results.

Core promises (exact UI copy, repeated in the onboarding footer; the macOS forms — Windows
renders them through the §9 per-OS copy table: "this PC", "Credential Manager"). Each
states only what the app
enforces: execution is local, and secret values are stored in the OS secret store (Keychain
/ Credential Manager) and kept out of the
authored scripts and the logs (via §6 runtime injection + redaction). Neither promise claims a
step *cannot* transmit a value it was given at runtime - the engine is not a sandbox (§6.2), so
the copy must never imply that secret values can never leave the machine.
- "Your automations execute only on this Mac"
- "Secrets live in your Keychain, never in a script or log"

## 2. Architecture

Four components (per top-level README):

- **Electron desktop app** — the UI (dark theme only; visual language in §14). One window plus
  a menu-bar (tray) surface. Talks to the backend over a local API.
- **Python backend** — long-lived local service: owns the data store (automations, versions,
  executions, agents, settings), the scheduler (fires triggers even when the app window is closed),
  Keychain access for secrets, and orchestration of AI agents that draft/edit automation specs
  and step scripts.
- **Python engine** — executes an automation's steps as scripts, streams per-step status and logs,
  enforces the framework policies (§6), injects secrets at runtime, persists execution results.
- **CLI** — command-line access to the same backend, full UI parity (§20): manage, author
  (pull/push workdirs), and execute automations; executions, secrets, agents, settings; §5.1
  export/import. Headless operation is a supported mode (§3), not just a debug aid, and the
  §17 agent skill drives everything through it. **Invariant: the CLI is a pure leaf — the UI
  and the backend must never depend on or invoke it.** Dependency direction is one-way (CLI →
  backend API, CLI → `service.py`); the app registers the backend via
  `python -m autowright.service` (§3) and may *install* the CLI's PATH shim, but never
  executes the CLI. This keeps the CLI freely removable, optional per install, and unable to
  break app bootstrap. Naming: user-facing surface (command names,
  arguments, metavars, help and error text) always spells out `automation` — never the `auto`
  shorthand. Grants are explicit (§20 grant model): `create`/`push` grant only the agents and
  secrets named by `--grant-agent`/`--grant-secret` flags — no all-on seed, no silent widening.

**Stack (decided):** the Electron renderer is React 19 + TypeScript + Vite (state: one zustand
store mirroring the §4 model; markdown rendering is react-markdown + remark-gfm — see §4.5). The backend is Python 3.14 + FastAPI/uvicorn (PyYAML, keyring for
Keychain; request bodies are validated by pydantic request models — `models.py`, §19 —
while response bodies remain plain dicts). Transport is localhost HTTP (JSON) plus one WebSocket for live events —
the full API surface is §19. Packaging is decided — see §3. Storage is decided — see §5.

**Platform layer (decided):** every OS-coupled capability sits behind a small composed
interface — composition, never a class hierarchy. Backend: the `autowright/platform/` package
defines one narrow Protocol per capability (`ServiceManager`, `Notifier`, `PowerAssertion` —
both the permanent §4.9 keepAwake `reconcile` and the §3 per-execution `hold_execution`
hold — `ProcessControl`) plus a `Capabilities` flag set (`imessage`, `notifications`,
`keepAwake`, `service`, `agentInstall` — whether the §19 agent install/sign-in-help
endpoints work on this OS), composed into one frozen `Platform` object by `platform.current()` — per-OS
`build()` functions; shared logic lives in plain functions the implementations import, never in
a superclass. Electron: `app/electron/platform/` mirrors the shape — per-OS modules exporting
plain objects (window chrome, tray spec, panel placement, CLI shim, update feed, managed-install
probe, reveal rules), selected once by `platform/index.cjs`. These modules never import
`electron` (they take `app`/window objects as arguments), so the §15 source-scanning guards and
test loaders keep working. **macOS is the only fully implemented platform.** On Linux,
`current()` composes explicit degraded implementations rather than crashing: service actions
answer a plain "not supported on <OS> yet" failure line (exit 1, §3 result-code rule),
notifications and keepAwake are silent no-ops, POSIX process control is real, and
every capability flag the OS can't honor is false. Windows composes `windows.build()`:
`imessage` and `agentInstall` stay false, the **real toast notifier** (`WindowsNotifier`,
§3: PowerShell WinRT toast under the `ai.autowright.app` AUMID; `notifications` is probed —
true only where the §3 installer's Start-menu shortcut or AUMID registration exists, false
on a dev checkout), **real service management** (`WindowsService`,
§3's Windows service block: the `ai.autowright.backend` Task Scheduler task via the
PowerShell ScheduledTasks cmdlets; `service` true), **real keep-awake power**
(`WindowsPower`, §3: one thread-owned
`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` behind counted holds;
`keepAwake` true) and **real process control** (`WindowsProcessControl`): the spawn
policy is `creationflags = CREATE_NEW_PROCESS_GROUP`, and "group" operations act on the
process tree rooted at the child's pid via `taskkill /T /F` — Windows has no signalable
process groups, so the §4.5 persisted group id stays the child's pid (same pid == group
invariant as POSIX own-session spawns), and the §3 pid-reuse guard answers False until a
pid+creation-time identity check lands (orphan recovery never kills what it can't verify).
Hard-kill contract, all platforms: callers pass `sig=None` to mean kill-hard —
`signal.SIGKILL` must never appear at a call site (the name does not exist on Windows);
`signal.SIGTERM` exists everywhere and Windows treats any signal as the tree kill.
Pipe-encoding contract, all platforms: every text-mode subprocess pipe on a cross-OS code
path (executor, harness invocation and probes, pip, installer streaming) is opened with
explicit `encoding="utf-8", errors="replace"` — never the locale default, which is cp1252 on
Windows and cannot even encode the §6.1 executor's own log text; the executor and the
`python -m autowright.service` entry (whose result lines carry `·`/`—` and are captured by
the Electron ensure-backend step) likewise reconfigure their real stdout/stderr to UTF-8 at
boot, so both ends agree regardless of the OS locale (macOS-only helpers like
osascript/launchctl may keep the platform default, which is UTF-8 there). The shell
half mirrors this: `win32.cjs` carries the Windows-correct values (flat `python\python.exe`
bundled-interpreter layout, the §3 `.cmd` shim, PATH read from the process environment —
Windows GUI apps inherit the full user PATH, no login-shell probe — native window frame, no
update feed yet); Linux keeps the degraded `fallback.cjs`. Clients gate features on the §19
`/health` `os` + `capabilities` fields — never by sniffing the platform at a call site.
Behavior on macOS is identical to the pre-layer code; the layer exists so a port fills in
per-OS modules instead of hunting call sites.

**Naming policy:** identifiers spell out full words on every surface - stored fields, serialized
API fields, routes and query params, code identifiers, CLI flags: `expression` not `expr`,
`timezone` not `tz`, `automation` not `auto`, `versionLabel` not `ver`, `snapshot_id` /
`secret_id` not `sid`. Exceptions are established conventions only: `id`, universal domain
terms (`cron`, `os`, the `Ms` epoch-milliseconds suffix), and the backend's internal `exec_*`
helper prefix. Renames carry no compatibility aliasing (the §4.7 lenient-load rule covers old
data on disk); both ends of a served surface change in the same commit.

## 17. Repository structure

- `SPEC.md` + `spec/` — the spec: `SPEC.md` is the index (holds §1, §2, §17 and the section map);
  `spec/*.md` hold every other section, grouped by domain.
- `backend/` — Python package `autowright`: storage, engine (+`executor.py` step SDK,
  `imports_check.py` shared §6.2 import allowlist), `scheduler.py` (the trigger tick loop
  only), `firing.py` (the §6 queue/firing operations, moved out of the scheduler:
  `fire_trigger`, `finish_queued`, `drain_queue`, `cancel_unmatched_queue`, and the shared
  never-ran finisher), `triggers.py` (pure §4.3 trigger math, validation, and display
  labels — backs §19 `POST /triggers/preview`), `models.py` (the §19 pydantic request
  models), `listeners.py` (§6
  message-trigger listener manager — Discord gateway connections, the §6 iMessage chat.db
  watcher, reply sending), `imessage.py` (chat.db reader + ROWID cursor, typedstream
  `attributedBody` decoder, osascript Messages sender, §19 permission probes),
  drafting, harness adapters,
  transfer archives (`transfer.py`, §5.1 + §5.2 URL fetch/resolution), FastAPI API (`api.py`),
  the §2 platform layer (`platform/` package: `base.py` — the capability Protocols,
  `Capabilities`, and the composed `Platform` dataclass; `darwin.py` — the macOS build:
  osascript notifier, caffeinate power assertion, launchd service delegation, POSIX process
  control; `posixproc.py` — the shared POSIX process-group helpers; `windows.py` — the §2
  Windows build: real `taskkill`-tree process control, the §3 Task Scheduler
  service manager, the SetThreadExecutionState power assertion, the §3 WinRT
  toast notifier (capability probed); `fallback.py` — the
  degraded Linux (and unknown-OS) builds), launchd service
  (`service.py`, runnable as `python -m autowright.service` — the §3 registration entry the
  app uses; the UI and backend never invoke the CLI), CLI (`cli.py`), `awake.py` (the macOS caffeinate `PowerAssertion` implementation — the §3/§4.9 permanent
  keepAwake assertion plus the per-execution hold; `platform/darwin.py` delegates here).
  Further modules: `main.py` (backend entry point, `python -m autowright.main` — bind localhost,
  write `backend.json` per the §3 bind-before-publish handshake, start the scheduler, serve the
  API), `installer.py` (§19 real harness installers + sign-in help), `packages.py` (§6.2
  declared-package check/ensure/upgrade via the bundled interpreter's pip), `execdb.py`
  (`executions.db`, the §5 list/filter index over execution headers — any `SCHEMA_VERSION` bump
  drops the table and startup's yaml reconcile rebuilds it), `reqlog.py` (§5 per-request log
  files + build-failure records, developerMode-gated), `testexec.py` (§11 draft test executions
  through the real engine path, plus the §8 chat call's RECENT EXECUTIONS context), `specmd.py`
  (spec.md ↔ §4.1 block-list conversion), `events.py` (in-process pubsub hub feeding the §19
  WebSocket), and the small utilities `keychain.py` (§4.8 Keychain values via keyring),
  `notify.py` (osascript notifications), `paths.py` (§5 filesystem locations,
  `AUTOWRIGHT_HOME` override, the §5.1 `current_os` platform token and its §4.1
  `os_display_name` form, shared by every surface that names a platform), `timefmt.py` (§4.1 display labels + §5 canonical UTC
  timestamps), `yamlio.py` (§5 atomic temp-write + rename IO).
  `autowright/instructions/` holds the §8 prompt texts as markdown (packaged via
  `[tool.setuptools.package-data]`): `framework-instructions.md` (contract preamble) and
  `default-build-instructions.md` (default build instructions seeded into new automations).
  `pyproject.toml` defines the `autowright` / `autowright-backend` entry points, and
  `constraints.txt` beside it pins the full runtime dependency closure (direct **and**
  transitive) at exact versions, so two §3 distributables built from one commit ship the
  same packages; platform-conditional pins carry environment markers, under
  `sys_platform == "win32"`: `pywin32-ctypes` (keyring's Windows Credential Locker backend)
  and `tzdata` (the IANA timezone database — Windows has no system copy and
  python-build-standalone ships none, so without it `zoneinfo` resolves no timezone at all
  and every §4.3 timezone-bearing trigger fails validation);
  `prod.sh` passes it as `pip install -c` (§18).
- `app/` — Electron app: `electron/main.cjs` + `preload.cjs` (window, tray panel, backend.json
  bridge), `electron/platform/` (the §2 platform layer's shell half: `index.cjs` selects the
  per-OS module once; `darwin.cjs` holds the macOS values and helpers — window-chrome options,
  tray icon spec, panel placement, dock icon, data/log roots, CLI shim path+text, login-shell
  PATH probe, update feed URL, Homebrew managed-install probe, reveal bundle rule, the
  settings deep-link scheme; `win32.cjs` holds the §2 Windows groundwork values; the modules
  never import `electron`), Vite + React + TS renderer
  under `src/` (`store.ts` central model, `api.ts` client,
  `ui.tsx` shared primitives, `tokens.css` design tokens, `pages/` one file per screen —
  except the two biggest screens, each a thin page over its own directory: the §11
  create/edit flow (`pages/CreateFlow.tsx` over `pages/createflow/`: `model.ts` — the pure
  editor model and helpers, `useDraftJob.ts` — §8 job polling, `ChatPanel.tsx`,
  `BuildTestPanel.tsx`, `SectionCards.tsx`) and the §9.2 automation detail page
  (`pages/AutomationDetail.tsx` over `pages/detail/`: `model.ts` — the `runAction`
  fire-and-forget mutation wrapper every detail card shares (body optionally returns the
  success toast; defaults are error toast + automation reload), `TriggerEditor.tsx` — the
  §9.2 add/edit trigger editor and its widgets, `TriggersCard.tsx`, `ConcurrencyCard.tsx`,
  `ParamRow.tsx`, `MemoryCard.tsx`, `RecentExecutions.tsx`); a shared step-list/param-editor
  module serves both the create/edit flow and the automation detail page).
  `brand-electron.cjs` (npm `postinstall`) renames the dev Electron.app bundle to "Autowright"
  (§14). `electron/icon/` holds the checked-in AW app-icon assets (§14: `icon.svg`
  source, `icon.png` 1024 px dock/raster, `icon.icns` bundle icon, `icon.ico` — the §3
  Windows app/installer icon, PNG-compressed entries at 256/128/64/48/32/16 px rendered
  from the same source); `electron/` also holds
  the checked-in tray PNGs (`trayTemplate.png`/`@2x`, `trayAlert.png`/`@2x` — the mac
  template images — and the §13 Windows colored variants `trayWin.png`/`@2x`,
  `trayWinAlert.png`/`@2x`),
  rendered by `scripts/gen_tray_icon.py`.
  Renderer tests live here too: `app/tests/` (vitest unit/render suites) and `app/e2e/`
  (end-to-end specs driving the real Electron app, shared `harness.ts`); both Vitest configs
  (`vitest.config.ts`, `vitest.e2e.config.ts`) sit at the `app/` root — `npm run test:e2e`
  passes the e2e one via `--config`. Two TypeScript configs sit there too: `tsconfig.json`
  (the shipped renderer, `src` only) and `tsconfig.test.json` extending it over everything
  else that is TypeScript but never shipped: `tests/`, `e2e/`, the Vite/Vitest configs, and
  `ds-entry.ts` (§15). `ds-entry.ts` is the renderer entry point for the `.design-sync/`
  previews (below).
  `UI-GUIDE.md` records the renderer conventions.
- `scripts/` — project scripts (`dev.sh`, `build.sh`, `prod.sh`, `build-clean.sh` — §18;
  `uninstall/` — developer-only uninstall scripts for the harness CLIs and Ollama, §18;
  `gen_tray_icon.py` renders the tray template PNGs;
  `gen_icon.cjs` regenerates `app/electron/icon/icon.png` + `icon.icns` from `icon.svg`
  (§14) — invoked from `app/` as `./node_modules/.bin/electron ../scripts/gen_icon.cjs`;
  `commit.sh` stages all uncommitted changes, generates a commit message via
  `claude --model claude-opus-5 -p` from the staged diff, and commits;
  `release.sh` sets the app version from the repo-root `VERSION` file, invokes
  `prod.sh` to build the release distributable, publishes the DMG + update zip as a
  GitHub release via `gh`, rewrites the §3 update feed under `docs/updates/`, and
  last publishes the §3 Homebrew cask to the separate `homebrew-tap` repository, §18;
  `test-fast.sh` runs the cheap test tiers cheapest-first (§15 shift-left order), §18;
  `test-all.sh` runs every test tier in the same order — the fast gate via `test-fast.sh`,
  then pytest `-m integration`, then e2e — §15/§18;
  `knowledge.sh` regenerates `knowledge.md`; its `audit` mode writes `knowledge-audit.md`, §18;
  `pip-release.sh` builds and uploads the `pypi/` placeholder package, §18;
  `gen_licenses.py` regenerates `app/src/acknowledgements.md` — the §4.9
  open-source-libraries list, checked in, refreshed by `build.sh` on every build).
- `windows-scripts/` — Windows developer scripts (PowerShell, runnable only on Windows).
  Developer-only exactly like `scripts/` — the same never-run rule and guard hook cover both
  directories, and the §15 BOM drift guard covers `*.ps1` here too. Currently:
  `dev.ps1` — the §18 Windows dev loop, `scripts/dev.sh` mapped per-OS;
  `commit.ps1` — the §18 Windows commit helper, `scripts/commit.sh` mapped per-OS;
  `prod.ps1` + `release.ps1` — the §3 Windows packaging/release pair.
- `skills/autowright/` — the agent skill (`SKILL.md`): teaches an AI coding agent (Claude Code
  and compatible harnesses) to drive Autowright end-to-end through the §20 CLI — create/edit
  automations via pull/push workdirs, execute and follow, inspect results, manage params,
  triggers, secrets, settings. The skill presents a summary for user confirmation before
  saving or executing — the full command including `--grant-*` flags (§20 review-promise and
  grant-model rules). The CLI is the skill's only surface: if `autowright` isn't found on
  PATH, the skill has the agent stop and ask the user to enable it — pointing at the §4.9
  COMMAND LINE card (toggle on to install, Reinstall if missing, and the card's copyable
  add-to-PATH command when the Terminal can't find an installed shim) — never falling back
  to the backend HTTP API. Checked in beside the code; users copy or symlink it into their
  agent's skill directory.
- `tests/` — pytest suite for the backend (storage, drafting, engine, triggers, API): the fast
  tiers at the top level (shared `tests/conftest.py`), the live integration tier under
  `tests/integration/` (§15 — its own `conftest.py` + `it_harness.py`), the test doubles
  `tests/bin/claude` (fake agent CLI) and `tests/bin/osascript` (fake Messages sender) with
  their §15 Windows twins (`claude.cmd`/`osascript.cmd` batch shims over `claude.py`/
  `osascript.py` Python ports of the same contract),
  `tests/seed_data.py` (§16 fixture), `tests/test_drift_guards.py` (§15: the
  cross-file version and §6.2 curated-list guards), and `tests/test_platform.py` (§2
  platform layer: composition, capability flags, degraded fallbacks, and the backend half
  of the §5 root-table drift guard — the shell half is `app/tests/platform-roots.test.ts`). `pytest.ini` at the repo root configures
  the suite. Renderer tests live under `app/` (above), not here.
- `docs/` — marketing landing page for autowright.ai, hosted via GitHub Pages (`index.html`
  single self-contained page + `CNAME` with the custom domain + `robots.txt` and
  `sitemap.xml` for search crawlers). Dark, matches the §14 visual
  language (IBM Plex Sans/Mono — no 700 weight, per §14 — brand orange accent `#f68b43`, and
  the §14 AW-monogram mark as both header mark and favicon, inlined from
  `app/electron/icon/icon.svg`). Audience: technically savvy users — copy is concise and
  concrete (short sentences, real nouns like Python, Keychain, scheduler, cron), never
  padded with explanation a developer does not need, and never marketing filler. Page
  structure, in order: header
  (mark + wordmark + GitHub link) · hero (an accent eyebrow that leads with the product
  name - "Autowright · open source · runs locally", so the brand appears as page text above
  the fold, not only in the wordmark - headline, one-paragraph pitch, "Download for
  macOS" → a direct download of the latest versioned DMG: on load, page JS fetches the
  same-origin §3 update feed (relative URL `updates/darwin-arm64.json`, so it also works
  when the page is served from a sub-path in local previews) and rewrites the download
  anchors' `href` to
  `releases/download/v<currentRelease>/Autowright-<currentRelease>-darwin-arm64.dmg`, so
  the click downloads the DMG with the version in its filename; the static fallback
  `href` (no JS, fetch failure) is the repo's latest-release GitHub page,
  "View source") · an animated app-window demo
  that mirrors the §11 chat thread (46 px icon rail with the §9 nav icon set —
  bolt, clock-rotate-left, microchip, key, sliders, circle-info pinned at the bottom — and all
  page icons inlined as the actual Font Awesome solid SVG paths, copied from the app's
  `@fortawesome/fontawesome-free` package into `<symbol>` defs. The stage is the real
  chat-pane layout and repeats its §11 type, color, and spacing values exactly: a
  scrolling thread (14/18 px padding) above a pinned composer fenced off by a hairline
  top border, entries carrying their own top margin - 12 px between families, 0 between
  chained operation blocks, so a run's blocks and receipts read as one stack. The four
  entry shapes are the app's: the quiet right-aligned user bubble (inset fill, hairline,
  radius 9, 500 12.5 px `--text-2`); operation blocks (13 px glyph box + 500 12.5 px
  `--text-muted` stage title, 3 px header top padding, then `• `-prefixed 11 px
  `--text-faint` feed bullets flush left with the glyph, single-line with ellipsis, the
  newest line brighter at `--text-muted` while it is the live one); message blocks
  (13 px glyph box + 600 13 px `--text` title over the 12.5 px `--text-2` markdown body,
  its list lines set tight - no gap between items, unlike the app's 6 px, so the plan
  reads as one dense block at demo scale);
  and faint system-chip receipts (10 px glyph, 400 11.5 px `--text-faint`). The composer
  is a bordered `.ad-input`-style textarea with the real placeholders (empty-state
  "Describe the job - one sentence is enough.", then the in-thread
  "Change something, or ask a question…" once the first turn lands) over the app's
  toolbar row: agent picker (`.ad-btn-pill` clone - mono 10.5 px, white .06 background,
  radius 6, microchip glyph + `name · model` + caret-down) and the dim `fa-eraser`
  Clear-chat button on the left, Send/Cancel alone on the right as an
  `.ad-btn-pill.action` clone (sans 11 px/500, the face every action pill in the demo
  uses). The empty state is the app's create empty state: 600 19 px heading "What should
  Autowright do for you?", the 12.5 px `--text-muted` subhead, the "OR START FROM AN
  EXAMPLE" eyebrow over the six rounded `.ad-chip-btn` example chips (the app's list,
  except the first chip reads "Track TV series" `fa-tv` where the app opens with the
  manga example, so it matches the demo's first scene), and the closing
  "Your AI writes the steps" line. Each scene then plays a §11 turn in thread form: the
  typed prompt lands as the user bubble; the §11 operation blocks stream in - spinner
  while live, settling to a green check beside the unified §8 stage labels "Working on
  the request…" / "Updating the documents…" / "Syncing the workflow…", each with its feed
  bullets ("Choosing what to do"; "Writing the spec"; "Writing the manifest - name,
  triggers, parameters, step list" and "Writing step n of N - `NN-name.py`") - with the
  mid-job "The plan" message block (`fa-list-check`, accent glyph) between the first two
  stages, exactly where §11 lands it, and the system-chip receipts between stages
  ("Spec updated." `fa-file-pen`, "Renamed to …" / "Description updated." `fa-pen`,
  "Steps synced with the spec." `fa-rotate`); the turn closes with the §11 turn action
  row - "Undo this change" (`fa-rotate-left`) and "Test draft" (`fa-vial`) as icon-led
  action pills. No step
  cards, no trigger/ran chips — the demo shows exactly what the app's thread shows.
  Three looping scenes cover a cron, a Discord-trigger, and an interval job across
  different agents; the thread clears between scenes and the empty state
  returns) · a three-step "how it works" strip (say it → read it → let it run) · three promise
  cards (the two §1 core promises plus the review promise "Nothing executes until you
  approve it") · a feature grid (message triggers, runs-with-window-closed + menu bar,
  versions, memory + snapshots, execution history, `.autowright` share/import) ·
  supported-agent badges (Claude Code, Gemini CLI, Codex, OpenCode + local Ollama) · a
  question-and-answer section ("Common questions", six items in the two-column card grid the
  promise cards use, each a `<h3>` question over an answer paragraph). Its purpose is
  twofold: answer what a first-time visitor actually asks, and give the page indexable prose
  that names the product and its domain nouns - what Autowright is, where automations run,
  which agents it drives, what it costs, how it differs from cron and from a chat agent
  running tasks itself, and which macOS versions it needs. Answers restate facts already
  spec'd elsewhere (§1 promises, §5 triggers, §6 execution, §13 agents) and must stay true to
  them; each is two or three sentences and names "Autowright" rather than "it" · closing
  download CTA (same feed-driven direct-DMG link as the hero — both anchors carry
  `data-download`; the JSON-LD `downloadUrl` stays the static latest-release page URL) ·
  footer (GitHub, Privacy, MIT). All repo links point to
  `hansololz/autowright`. The page never uses the em dash character (—) anywhere -
  copy, meta tags, demo strings, code comments; where an app string it mirrors
  carries one, the page substitutes a plain hyphen. Respects `prefers-reduced-motion`. Head metadata: canonical
  `https://autowright.ai/`, `theme-color` `#090d14`, Open Graph + Twitter-card tags with a
  1200×630 social image (`docs/og.png`, AW mark + headline on the dark background) and an
  `og:image:alt` describing it, `docs/apple-touch-icon.png` (180 px full-bleed AW mark), and
  JSON-LD.
  The `<title>` and `<meta name="description">` both lead with the product name and then say
  in plain words what the app is (an AI automation app for macOS that writes and schedules
  Python), because "Autowright" is a contested term - unrelated automotive businesses hold
  the top organic results - so every signal that ties the name to this product matters.
  Three JSON-LD graphs, each in its own `<script type="application/ld+json">`:
  `SoftwareApplication` (macOS, free, MIT, `downloadUrl` the static latest-release page,
  plus `featureList`, `screenshot`, and `author`); `WebSite` with `alternateName` and
  `publisher`; and `FAQPage` whose `mainEntity` mirrors the on-page question section
  verbatim - the two must never drift, since Google discards FAQ markup that is not visible
  on the page. The `Organization` node the other two reference carries `sameAs` links to
  every profile that is unambiguously this project (the GitHub repo and owner, the PyPI
  project), which is what lets a search engine treat this Autowright as an entity separate
  from the businesses of the same name. `docs/robots.txt` allows every crawler and points at
  `https://autowright.ai/sitemap.xml`; `docs/sitemap.xml` lists the single canonical page
  (the `updates/` feeds are machine endpoints and stay out of it). Section elements that a
  search engine may deep-link carry stable `id`s (`how`, `features`, `faq`). Sections below the demo fade up on first
  scroll-into-view (IntersectionObserver adding an `.in` class; entrance uses the app's
  §14 motion values — 360 ms `cubic-bezier(0.16,1,0.3,1)`). `::selection` is the accent at
  .35 alpha and links/buttons get a visible `:focus-visible` accent outline, per §14. A
  faint accent radial glow sits behind the demo window. Also serves `updates/darwin-<arch>.json` — the §3 Squirrel.Mac update
  feeds, rewritten by `scripts/release.sh` on every release.
- `pypi/` — standalone placeholder package reserving the `autowright` name on PyPI
  (`pyproject.toml` hatchling build, version 0.0.1, `Development Status :: 1 - Planning`,
  `src/autowright/__init__.py` with only `__version__`, README stating the real project is in
  development). Not part of the app build and not used by anything in the repo — the real backend
  package is `backend/`; never install `autowright` from PyPI. Uploaded by the developer via
  `scripts/pip-release.sh` (§18).
- `VERSION` — single source of truth for the app version (one line, semver). Synced into
  `app/package.json`, `backend/pyproject.toml`, and `backend/autowright/__init__.py` by
  `scripts/release.sh` (§18); `build.sh` re-syncs on every build and `prod.sh` refuses to
  build on mismatch.
- `README.md` — the top-level readme; §2's component list follows it.
- `pytest.ini` — pytest configuration for the `tests/` suite.
- `.design-sync/` — DesignSync workspace for UI component iteration: `config.json`,
  `conventions.md`, `NOTES.md`, and `previews/*.tsx` (one preview per shared UI primitive),
  rendered through `app/ds-entry.ts`.
- `.claude/` — Claude Code project config: `CLAUDE.md` (project instructions),
  `settings.json`, `hooks/` (the guard hooks), and `skills/` (project skills, including the
  verify skill).
- `.gitignore` — untracked-file rules (the generated `knowledge.md` / `knowledge-audit.md`
  among them).
- `.gitattributes` — `*.cmd text eol=crlf`: batch files (the §15 `tests/bin/*.cmd` doubles)
  must reach a Windows checkout CRLF regardless of the clone's autocrlf setting.
- `LICENSE` — MIT, copyright David Zhang (also `"license": "MIT"` in `app/package.json`).
- `PRIVACY.md` — the privacy policy, canonical copy: rendered in-app on the §9.4 About
  page (raw import into the renderer bundle) and read by GitHub visitors in place.
