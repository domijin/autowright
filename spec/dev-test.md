# Autowright SPEC — Dev/test knobs, seed data, commands

Part of the Autowright spec. Index and § map: [SPEC.md](../SPEC.md). § numbers are global across spec files.

## 15. Dev/test knobs

**Dev/release parity rule:** dev and release share the SAME code paths — there are no mock modes,
no alternate backends, no dev-only branches in app code. The only knobs that exist are pure
configuration (they relocate or re-tune the same behavior, never select different behavior).
Every knob defaults to the release value and is developer opt-in; the single knob dev.sh sets
itself is `AUTOWRIGHT_RENDERER_URL` (below — same renderer source, served with HMR instead of
pre-bundled). Dev sessions use the real app-support dir, real Keychain, real agent CLIs, random
port, request logging via the §4.9 developerMode setting (§5), and the real launchd service (§18
dev.sh).

Frontend state (localStorage/URL — production mechanisms, not dev branches): `ad-onboarded`
(persisted onboarding completion; clearing it replays onboarding), `#menubar` URL hash (selects
the menu-bar surface — how the tray panel window loads). The renderer discovers the backend only
via `backend.json` through the Electron preload bridge; there is no browser-dev URL-param
fallback.

Backend env knobs (configuration only):

- `AUTOWRIGHT_HOME` — overrides the app-support root (isolated dev/test homes); logs move to
  `<home>/logs/` (§5), and Electron's Chromium profile follows to `<home>/electron/` — an
  isolated home isolates the renderer's localStorage/cookies too, never the real profile.
- `AUTOWRIGHT_PORT` — fixed port instead of a random free one.
- `AUTOWRIGHT_OLLAMA_URL` — Ollama HTTP endpoint override (default `http://localhost:11434`).
- `AUTOWRIGHT_STEP_TIMEOUT` — the **default** per-step timeout in seconds (default 900); a
  step's own `timeout`/`no_timeout` (§4.1, §6) always wins over it.
- `AUTOWRIGHT_AGENT_TIMEOUT_S` — per-invocation agent-call **idle window** in seconds (default
  300): the call is killed after this long with no stdout output; every streamed line resets
  the window (§8)
- `AUTOWRIGHT_AGENT_HARD_CAP_S` — per-invocation agent-call **total wall-clock cap** in seconds
  (default 1800); ends a call that streams forever (§8)
  for every §8 harness call (drafting, chat, build diagnosis).
  Configuration only, never a different code path; read per call, so a running backend picks
  up changes. Local Ollama models on big builds are the typical reason to raise it.
- `AUTOWRIGHT_REPAIR_ROUNDS` — §8 maximum automatic repair rounds per drafting call
  (default 1, clamped 0–5; 0 = no repair, an invalid response goes straight to the §8
  build diagnosis). Configuration only, never a different code path; read per call, so a
  running backend picks up changes.
- `AUTOWRIGHT_TICK_S` — scheduler tick period in seconds (default 15). Same loop re-tuned,
  never a different code path; the integration harness sets `1` so live-scheduler tests wait
  seconds instead of sitting out real 15 s ticks.
- `AUTOWRIGHT_LISTEN_TICK_S` — §6 listener-manager reconcile period in seconds (default 3).
  Same rule as `AUTOWRIGHT_TICK_S`: configuration only, never a different code path.
- `AUTOWRIGHT_QUEUE_TTL_S` — §6 firing-queue staleness cutoff in seconds (default 120): an entry
  that reaches the head having waited longer finishes `skipped` instead of executing.
- `AUTOWRIGHT_CHAT_DB` — path of the Messages database the §6 iMessage watcher reads (default
  `~/Library/Messages/chat.db`). Configuration only — tests point it at a fixture db; the
  watcher code path is identical.
- `AUTOWRIGHT_IMSG_MAX_AGE_S` — §6 iMessage backlog fence in seconds (default 120): a
  cursor-passed row whose message timestamp is older than this when observed never fires.
- `AUTOWRIGHT_STEP_RETRY_PAUSE_S` — §7 spacing between consecutive attempts of an
  `infiniteRetries` step in seconds (default 1; finite retries never pause). Configuration
  only — tests set `0` so retry loops run instantly.

Electron env knob (configuration only):

- `AUTOWRIGHT_RENDERER_URL` — when set, Electron `loadURL`s the renderer from this origin (with
  the same `#/app` / `#/menubar` hashes) instead of `loadFile`-ing `app/dist/index.html`. It
  points at a Vite dev server serving the identical `app/src` source — HMR delivery of the same
  code, not a different code path (the preload bridge, `backend.json` discovery, and backend
  are untouched; the backend's open CORS covers the http origin). Set by `dev.sh` (§18);
  release never sets it.

Test doubles live in `tests/` only: a fake `claude` CLI at `tests/bin/claude` (conftest prepends
`tests/bin` to `PATH`, so the real detect/invoke/subprocess path is exercised against it;
`AUTOWRIGHT_TEST_CLAUDE_SIGNED_OUT=1` makes its `auth`-status invocation exit non-zero, so the
signed-out detection path is testable; `AUTOWRIGHT_TEST_STREAM_DELAY_MS` — milliseconds pacing
its stream-json output, for manual UI checks of live §8 progress; unset → instant, so the
pytest suite stays fast), a fake
`osascript` at `tests/bin/osascript` (records its argv to a file named by
`AUTOWRIGHT_TEST_OSASCRIPT_LOG` and exits 0 — the §6 iMessage sender resolves `osascript`
through PATH, so tests exercise the real send path; exit/stderr overridable via
`AUTOWRIGHT_TEST_OSASCRIPT_FAIL` to simulate the −1743 denial), and conftest
fixtures that monkeypatch `keychain` (in-memory dict) and `notify.post` (no-op). Removed knobs —
do not reintroduce: `AUTOWRIGHT_MOCK_AGENT`, `AUTOWRIGHT_KEYRING`, `AUTOWRIGHT_NO_NOTIFY`,
`ad-sudo-denied`, `?port=&token=` (the renderer dev server returned as `AUTOWRIGHT_RENDERER_URL`,
above — `VITE_DEV`/`npm run dev:app` themselves stay gone).

**Test suite layout.** Backend unit tests are pytest under `tests/` (run
`python -m pytest tests/` from the repo root; `pytest.ini` runs them parallel via
pytest-xdist `-n auto`). Renderer unit tests are Vitest under
`app/tests/` (run `npm test` in `app/`) — pure logic (label
formatting, store reducers, spec/text round-trips) plus a small happy-dom component tier
(`*.render.test.tsx`, @testing-library/react). It covers flows the e2e tier cannot reach
under its safety rules — the original motivation: installer/set-up card flows (e2e must
never click them), queued/waiting execution rows (timing-hard to stage live), and
grant-checkbox → draft-request payloads — and editor branch behavior uneconomical to stage
live: blocker-entry states and action gating, chat-response application branches, thread
progress-entry stage labels, collapsed-card defaults, and analyze/agent-picker request
payloads. Full
journeys stay e2e; all other component rendering is exercised by the playwright-driven
Electron path, never by DOM unit tests.

**Shift-left order.** Tiers run cheapest-first so failures surface early: Vitest unit
(<1 s) → `tsc --noEmit` → pytest unit (seconds) → pytest `-m integration` (~10 s) →
e2e (minutes). `scripts/test-fast.sh` (§18) runs the three cheap tiers in that order,
failing fast. `scripts/test-all.sh` (§18) runs all five tiers in the same order — the
fast gate via `test-fast.sh`, then integration, then e2e — failing fast at every tier.

**Integration tests** live under `tests/integration/`, marked `integration` and excluded from
the default run (`pytest.ini` at the repo root; run them with `python -m pytest -m
integration`). They boot the real backend (`python -m autowright.main`) as a subprocess and
exercise it over real HTTP/WebSocket connections and via the real CLI as a second subprocess —
the §3 bind-before-publish handshake, the execution lifecycle, crash recovery
(SIGKILL → restart → stale-executing repair), live scheduler firing, the §6 iMessage
message-trigger loop over a fixture chat.db (`AUTOWRIGHT_CHAT_DB` + the fake `osascript`
capturing the reply), and the CLI authoring/execution surfaces (pull → edit → push
round-trip; execution cancel). Isolation is
per-test: a fresh `AUTOWRIGHT_HOME` tmp dir (the app's entire write surface), a random
localhost port per backend (the harness also sets `AUTOWRIGHT_TICK_S=1`, §15), and
localhost-only test doubles in the spirit of the fake `claude`
CLI — a local HTTP server standing in for the web (`fetch_page` pages + robots.txt) and a
local wheel directory standing in for PyPI (pip's `PIP_NO_INDEX`/`PIP_FIND_LINKS`, so
`packages.ensure` runs a real pip install into the home's `site-packages/`). Nothing outside
the tmp home is written and no packet leaves localhost. Deliberately excluded (machine-mutating,
covered at their unit seams): Keychain values, launchd, harness/Ollama installers, real agent
CLIs. The backend subprocess runs real `notify.post`, so a failed-execution test may show one
real macOS notification — accepted, per the no-dev-only-branches rule.

**End-to-end tests** live under `app/e2e/` (run `npm run test:e2e` in `app/` — it builds
first, then runs a second Vitest config, `vitest.e2e.config.ts`, sequentially with long
timeouts and one automatic retry per test: launching a real Electron per test occasionally
dies to a transient helper-process crash outside our code — "Target page, context or browser
has been closed" — and a genuine failure still fails both attempts). Each test launches the real pieces exactly as release does: the backend subprocess
over a tmp `AUTOWRIGHT_HOME` (fake `claude` from `tests/bin` on PATH), then the real Electron
binary via playwright-core `_electron.launch` loading `app/dist` — real preload bridge, real
`backend.json` discovery, real windows on screen. Scenarios stay high-value journeys —
everything finer-grained belongs to the unit/integration tiers:

- onboarding on an empty home, real agent detection (fake CLI)
- list → detail → execute → result on a seeded-via-API home
- the create-flow journey: request → AI draft via the fake CLI through the real two-call
  pipeline → Test draft run → Create → execute → execution page
- adding a config-only agent; adding a placeholder secret, then editing and deleting it;
  adding a cron trigger, seeing its humanized chip, and toggling it off
- an execution whose step writes a result file, rendered in the execution page's result view;
  the read-only "Show workspace in Finder" button is present (never clicked — it would open a
  real Finder window)
- memory snapshots from the detail page — create, list, restore
- an edit-mode draft Test on an existing automation: run Test from the editor, the §11 test
  record succeeds while live memory stays untouched, its View run opens the execution page;
  the settled test also lands as a quiet system chip in the chat thread; editing the spec
  locks Test until Sync; Discard drops the draft
- failed execution → §7 diagnostics on the execution page → Retry in place → attempt 2
  succeeds → attempts visible, list chip recovers
- Cancel on a live execution; skip-step on a live execution continuing to the next step
- the full edit loop: spec edit → Sync spec (real second AI call) → Save as v2 →
  version history → restore v1 as v3
- the editor chat pane, question then edit: a question-shaped message lands a prose answer
  entry (workflow untouched); a change request rewrites the spec from chat, the thread
  entry's inline Sync now rebuilds the steps, and the draft saves as v2; the same journey
  checks the pane's two §11 visual behaviors happy-dom can't reach — the composer
  auto-grows and shrinks with its content, and the thread scroll stays put while typing
  and re-pins to the newest entry when one lands
- the chat `actions.yaml` fix-and-test chain: one response carrying an answer, a spec
  rewrite, a notes rewrite, and `sync: true` + `test: true` → auto-sync → auto-test →
  the settled-test system chip in the thread
- Fix with AI from a failed execution: the failure seeds the thread as a system entry, the
  canned analyze message sends automatically, and the response's spec rewrite lands in the
  thread
- backend restart under a live UI: the renderer re-reads backend.json, reconnects (§3), and
  keeps working
- parameter editing across the §4.2 kinds on the detail page, values reaching a real execution
- the missing-secret warning flow (placeholder secret only, no Keychain write)
- agent management: switch the default agent, delete an agent → default reassigns
- the menu-bar surface (`#menubar`): rows with status dots, execute from the tray panel
- executions list behavior: §4.5 test records hidden, statuses and click-through correct
- Settings: retention-days edit with clamp, notification setting persisted The §10 install/sign-in machines are
real — e2e must never click "Set up" suggestion cards (they install CLIs onto the machine);
the found-card "Check connection" is read-only and safe. Secret values go to the real macOS
Keychain in every mode, so e2e only ever creates §4.8 placeholder secrets (blank value —
name + description, no Keychain write); value-setting is covered by the unit tier's in-memory
keychain. Trigger math has **one** implementation (backend `triggers.py`; the editors
preview through §19 `POST /triggers/preview`), so there is no cross-language parity fixture
to maintain — the backend pytest suite covers the cron/one-shot cases (DST gap and
fall-back included) directly. Testability knobs (configuration only, release
behavior unchanged): `Scheduler` accepts an injectable `clock` callable (defaults to
`datetime.now`) so tick-loop policies (coalescing, catch-up, one-shot consumption) are
deterministic under test, and the §17 createflow module (`app/src/pages/createflow/model.ts`)
exports its pure helpers
(`specToText`, `textToSpec`, `amendSpec`, `stepSecretNames`, `secretRefsOf`, `instrToMd`,
`mergeDraftTriggers`, `persistChat`, `applyTestValues`, and the seed/serialization helpers
`seedDrafting`, `seedFromPayload`, `seedFromAuto`, `serializeDraft`) and `result.tsx`
exports `SpecMarkdown`/`Markdown` and `ext`/`fileKind` for the Vitest suite.

**Selector policy.** An element an e2e test targets carries a stable `data-testid` (or is
reached by role/label/user-visible text); tests never select by internal CSS class, DOM
order (`.nth()`, xpath ancestor walks, unscoped `.first()` used to pick among same-named
controls), or structural traversal — those re-aim silently when layout, styling, or copy
around them changes. `.first()` stays legal only to collapse duplicates of the *same*
target (a text that legitimately renders twice), never to choose between different
controls. Test ids in the app (all in `app/src`): `nav-rail` (the §9 nav rail — the
harness's `clickNav` measures its width), `agent-card` (§12 agent cards),
`execution-row` (§9 executions-list rows), `param-row-<name>` (§9.2 parameter rows, one
per param), `spec-edit` / `spec-editor` (§11 SPEC card's Edit button and its edit
textarea), `sync-steps` (§11 Build panel's Sync now / Sync spec button), `test-draft-toggle` (§11 test
panel's Test draft setup-toggle button — its "Test draft" label also appears on the chat
turn-row pill `chat-test-draft`, so bare text can't reach it),
`chat-sync-now` (§11 chat thread rewrite entry's inline Sync now), `chat-turn-actions` /
`chat-test-draft` / `chat-analyze-failure` (§11 chat turn action row and its Test draft /
Analyze failure pills), `chat-thread` (§11
chat thread's scrolling body — the element whose scrollTop the pinning tests measure),
`chat-progress` (§11 thread's transient live-job progress entry — its stage label text
also appears verbatim as settled activity-entry titles, so bare text can't reach it),
`version-menu` (§11 editor version pill). New e2e targets that role/label/text cannot
reach unambiguously get a test id added here.

## 16. Seed / demo data (tests only)

The shipped app has NO seed path: a fresh install always starts empty (onboarding), and there is
no CLI or API to populate demo data. The seed fixture lives in `tests/seed_data.py` and is
applied only by tests calling `seed(store)` (it refuses to seed when any automations exist).

The fixture ships four demo automations: "Track manga
chapters" (cron `0 8 * * *`, list/toggle/number/text/kv params, result.md markdown table with a READ
column),
"Nightly folder backup" (cron `0 2 * * *`), "Weekly report email" (cron `0 9 * * 1`, failed, uses
`SMTP_PASSWORD`, retry-from-step), "Clean screenshots folder" (cron `0 21 * * 0`). Demo secrets:
`SMTP_PASSWORD`, `VAULT_DRIVE_KEY`. Twelve seed executions cover every terminal status including
skipped (§4.6 queue-entry records that never ran, note "previous execution still in
progress"), cancelled (a user-cancelled execution with a cancelled step and queued
remainder), and interrupted (note "Mac went to sleep"); `executing` is inherently live and
is not seeded. The fixture includes one execution
with a skipped step (execution still `succeeded`) and one failed-then-retried execution whose
failing step carries two attempts.


## 18. Commands

Everything under `scripts/` is developer-only: run by hand in a terminal, never by an agent.
`.claude/settings.json` enforces this with PreToolUse hooks (commands in
`.claude/hooks/guard_bash.py` + `guard_paths.py`): the Bash hook blocks any command referencing
the repo's `scripts/` directory (bare `scripts/`, `./scripts/`, `cd scripts`, or the
`$CLAUDE_PROJECT_DIR` absolute path) or the repo-root `knowledge.md`; the path hook
(`Read|Edit|Write|Grep|Glob`) blocks tool calls targeting the repo-root `knowledge.md`.
Both are scoped to exactly those repo-root paths — same-named files or `scripts/` directories
anywhere else (other repos, `node_modules`, subdirectories) are unaffected. Deterministic
harness-level block, independent of model compliance; agents may still read/edit the `scripts/`
files via the non-Bash tools. Agents verify
changes by launching the app pieces directly (backend module, `npm run build`, Electron via
playwright — see `.claude/skills/verify`).

Dev workflow:

- **`./scripts/build.sh`** — build only, no launch: creates the venv and `node_modules` if
  missing, re-installs deps when `backend/pyproject.toml` (stamp file `.venv/.backend-stamp`)
  or `app/package.json` changed, then typechecks + builds the renderer (`npm run build` →
  `app/dist`, the bundle Electron loads in release). Runs `release.sh --sync` first, so the
  three version sites always track `VERSION`. Touches no processes and no data dir;
  safe to invoke anytime. **`--deps`** stops after the dependency step (no renderer bundle) —
  what dev.sh uses.
- **`./scripts/release.sh <version>`** — cuts a release end to end: sets the app version,
  builds the distributable, and publishes it as a GitHub release. Steps, in order:
  refuses if the working tree is dirty (the release commit must contain only the version
  bump), if the tag `v<version>` already exists (checked locally and on `origin`, before
  anything is modified), or if the new version is not strictly higher than the current
  `VERSION` (semver ordering: numeric core compared field by field; on an equal core a
  release outranks any pre-release, and two pre-releases compare lexically); validates the
  argument (semver: `MAJOR.MINOR.PATCH`, optional
  pre-release suffix); writes it to the repo-root `VERSION` file (the single version source, §17) and
  syncs it into the three version sites: `app/package.json` (`"version"`),
  `backend/pyproject.toml` (`version =`), and `backend/autowright/__init__.py`
  (`__version__`); runs the full test suite before anything is committed or built
  (`build.sh --deps` for the venv/node_modules, then `test-fast.sh`, then
  `pytest -m integration`, then `npm run test:e2e` — §15 shift-left order; any failure
  aborts the release with the bump uncommitted); commits the bump via `scripts/commit.sh`
  (AI-generated message; skipped when the version is unchanged) and pushes; invokes
  `prod.sh` to produce the versioned `.app` + DMG (which re-checks the DMG itself: the
  in-bundle import smoke test and the Gatekeeper assessment);
  then runs `gh release create v<version> <DMG> <zip> --title "v<version>"
  --generate-notes` to tag the pushed commit and upload the DMG plus the §3 update zip;
  finally rewrites the built arch's Squirrel feed (`docs/updates/darwin-<arch>.json`, §3 —
  `currentRelease` + one entry pointing at the release zip's download URL) and commits +
  pushes it with a plain git commit. Requires the `gh` CLI,
  authenticated (`gh auth login`); fails with a hint otherwise. Files are rewritten only
  when their version actually differs, so an unchanged `pyproject.toml` mtime never
  churns the `.backend-stamp` dependency re-install. Modes (version-only — no build, no
  git/GitHub actions): **`--sync`** rewrites the three sites from `VERSION` without
  taking a new version (what `build.sh` runs); **`--check`** verifies all three match
  `VERSION` and exits non-zero listing every mismatch (what `prod.sh` runs).
- **`./scripts/prod.sh`** — the production distribution (§3), under `build/` (gitignored).
  Runs `release.sh --check` first and refuses to build on any version mismatch (the
  distributable's DMG name, bundle, and backend must agree on one version).
  Invokes `build.sh` (full), then: downloads the pinned relocatable CPython
  (python-build-standalone `20260807` / CPython `3.14.7`, arch from `uname -m`, tarball
  cached in `build/cache/`, URL overridable via `AUTOWRIGHT_PBS_URL`), upgrades the bundled
  pip to the latest release, pip-installs the backend
  + curated packages into it (inside the bundle the backend/CLI execute as
  `python3 -m autowright.main` / `-m autowright.cli` — pip's `bin/` entry scripts carry absolute
  staging-path shebangs), uses the checked-in app icon `app/electron/icon/icon.icns`
  (§14), packages `Autowright.app` with `@electron/packager` (bundle id
  `com.autowright.app`; ships only `electron/`, `dist/`, and `package.json` — the renderer is
  fully bundled and main/preload use Electron builtins only, so no `node_modules`), copies
  the interpreter to `Contents/Resources/python/`, smoke-checks that the bundled interpreter
  imports `autowright` + every curated package from inside the bundle, codesigns and
  notarizes per §3 (Developer ID + hardened runtime on every Mach-O, inside-out, stapled —
  no ad-hoc fallback), and produces `build/Autowright-<version>-darwin-<arch>.dmg` (hdiutil UDZO)
  plus the §3 update zip `build/Autowright-<version>-darwin-<arch>.zip` (`ditto` of the stapled
  app, the Squirrel.Mac artifact `release.sh` uploads).
- **`./scripts/dev.sh`** — fastest dev loop, with hot reloading: invokes `build.sh --deps` only
  (no renderer bundle); shuts down lingering processes from previous sessions — backend by
  command-line pattern (`[Pp]ython -m autowright` — ps shows the venv python's resolved binary,
  never the `.venv/bin/python` path; SIGTERM, 5 s grace, then SIGKILL — defensive against any
  process stuck in shutdown; the §19 ws handler exits on client disconnect, so uvicorn's
  graceful shutdown no longer waits on WebSockets), stale Electron, and stale Vite;
  then (re)installs the real launchd LaunchAgent (`autowright service uninstall` +
  `service install`, `com.autowright.backend`, §3) so the backend behaves exactly as in release:
  launchd-managed, RunAtLoad/KeepAlive, cwd `/`, minimal launchd PATH, random free port,
  macOS Keychain, developerMode-gated request logging (§5) to `backend.out.log`/`backend.err.log`
  and per-request files under `<logs>/requests/` (§5) under the logs
  dir (§5), data in `~/Library/Application Support/Autowright` (starts empty on a fresh
  machine); starts a Vite dev server on a random free port (`npx vite --strictPort`, log
  `vite.log` under the logs dir, killed on script exit); waits for a fresh `backend.json`
  (rewritten with new pid/token
  each start) plus `/health` and for Vite to answer, then launches Electron in the foreground
  with `AUTOWRIGHT_RENDERER_URL=http://127.0.0.1:<vite port>` (§15) — renderer edits under
  `app/src` hot-reload live; backend edits need a dev.sh restart. Quitting Electron normally
  (Cmd+Q) leaves the backend running (release semantics — automations keep firing; stop it with
  `.venv/bin/autowright service uninstall`). Ctrl+C in the dev.sh terminal instead shuts the
  whole app down: Electron dies with the terminal's SIGINT, the exit trap kills Vite, and an
  INT/TERM trap stops the backend — `autowright service uninstall` first (launchd KeepAlive
  would otherwise respawn it), then the same SIGTERM → 5 s grace → SIGKILL escalation as the
  startup stale-process sweep (defensive — the §19 ws handler exits on disconnect, so a plain
  SIGTERM normally suffices); the script exits 130. The SIGKILL path leaves a stale `backend.json` behind, which the next
  startup already tolerates (fresh-file compare).
  Isolated mode: setting any `AUTOWRIGHT_*` knob (§15) switches dev.sh to spawning the backend
  directly with that env instead of via launchd (the plist carries no env) — detached, cwd `/`,
  launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), same log filenames under the chosen home.
  `--fresh` wipes the data dir first and is refused unless `AUTOWRIGHT_HOME` is set (never wipes
  the real app data).
- **`./scripts/build-clean.sh`** — resets the repo to a pre-build state so the next
  `build.sh`/`dev.sh` rebuilds from scratch. First stops anything running **from this repo**
  (deleting `.venv` under the live launchd KeepAlive service would otherwise break):
  `autowright service uninstall` only when the LaunchAgent plist's program points inside the
  repo — a service registered by the installed `/Applications` app is the user's live backend
  and survives a repo clean untouched — then the same kill_stale patterns as dev.sh for the
  repo's backend, Electron, and Vite processes. Then deletes the build
  artifacts: `.venv` (incl. the `.backend-stamp`), `app/node_modules`, `app/dist`, and the
  contents of `build/` except `build/cache/` (the pinned CPython tarball, expensive to
  re-download); **`--cache`** drops the cache too, removing `build/` entirely. Never touches the
  data dir (`~/Library/Application Support/Autowright` or `AUTOWRIGHT_HOME`) or the logs dir.
- Backend: `python3.14 -m venv .venv && .venv/bin/pip install -e "backend[dev]"`; test with
  `.venv/bin/python -m pytest tests/`; dev.sh launches the backend via `python -m autowright.main`
  (equivalent to the `autowright-backend` entry point); start an isolated backend (real agent CLIs,
  real Keychain, empty home) with `AUTOWRIGHT_HOME=<dir> AUTOWRIGHT_PORT=8799 .venv/bin/autowright-backend`.
- App: `cd app && npm install`; typecheck+bundle with `npm run build`; `npm run app` launches
  Electron against the built bundle (release delivery; dev.sh instead serves the same source
  via Vite + `AUTOWRIGHT_RENDERER_URL`, §15).
- **`./scripts/uninstall/<tool>.sh`** (`claude-code.sh`, `codex.sh`, `gemini.sh`,
  `opencode.sh`, `ollama.sh`) — developer-only reversal of the §19 installers, run manually by a
  developer in a terminal. Default removes what the §19 installer put there (Claude: the
  `~/.local/bin/claude` symlink + `~/.local/share/claude` versions; Codex: the
  `~/.local/bin/codex` + `codex-code-mode-host` symlinks and the
  `~/.codex/packages/standalone` payload tree; Gemini via
  `npm uninstall -g --prefix ~/.local @google/gemini-cli` plus its `~/.local/lib/node_modules`
  tree; Ollama quits the app and running server first, then removes `Ollama.app` from
  `/Applications`/`~/Applications` and the `~/.local/bin/ollama` symlink (plus a
  `/usr/local/bin/ollama` symlink when it points into that app bundle — the §19
  vendor-location symlink); OpenCode prefers
  the CLI's own `opencode uninstall --force` — with `--keep-config --keep-data` unless
  purging — then removes leftovers in `~/.opencode/bin` and legacy `~/.local/bin`).
  **`--purge`** also deletes the tool's
  config/auth/data dirs (`~/.claude` + `~/.claude.json*` and `~/.local/share/claude`;
  `~/.codex`; `~/.gemini`; `~/.opencode` plus the
  `~/.config`/`~/.local/share`/`~/.local/state`/`~/.cache` `opencode` dirs;
  `~/.ollama` incl. models). Never invoked by the app, the backend, or any
  agent — each script guards itself (shared `_lib.sh`): exits if agent env markers are present
  (`CLAUDECODE`), exits without an interactive TTY on stdin+stdout, and requires the developer
  to type the tool name to confirm.
- **`./scripts/knowledge.sh`** — regenerates `knowledge.md` at the repo root: a gitignored,
  developer-only orientation doc (concise, diagram-heavy — mermaid architecture + per-action
  sequence diagrams, annotated file tree, data-model and key-file tables, CLI command table,
  agent-skill overview, Python APIs — step SDK + backend HTTP/WS endpoint map — message-trigger
  flows (Discord + iMessage today, pubsub reserved), and a dev-workflow scripts table). Invokes
  `claude --model claude-opus-5 -p` with read-only tools (`Read`, `Glob`, `Grep`, and
  read-only Bash: `ls`/`tree`/`git ls-files`/`git log`/`wc`/`head`/`cat`) to explore the repo
  (SPEC.md as primary source, verified against code), prepends a generated-at header, and
  writes atomically (temp file + `mv`). Purely for developer reading — never read by agents,
  never used to build the app; no other file references it. Developer-only: agents never run
  this script (`.claude/CLAUDE.md` forbids it). The §18 PreToolUse hooks reject
  any Bash command or `Read|Edit|Write|Grep|Glob` call targeting the repo-root `knowledge.md`
  (only that exact path — same-named files elsewhere are unaffected).
  **`audit` mode** — `./scripts/knowledge.sh audit` writes `knowledge-audit.md` (repo root,
  gitignored, developer-only, same generated-at header) instead of the orientation doc: a
  soundness audit, run with the same read-only Claude invocation, that cross-checks three
  layers against each other and reports every mismatch rather than describing the app.
  Coverage: (1) **data model** — every §4 entity/field in `spec/data-model.md` vs the backend
  (`storage.py`, `execdb.py`) vs the renderer mirror (`app/src/types.ts`, `store.ts`): missing
  fields, type/enum drift, fields present in code but absent from the spec or vice versa;
  (2) **on-disk layout** — the §5 storage tree in `spec/storage.md` vs `paths.py` and the
  read/write sites: paths or files the spec promises but code never writes, and files code
  writes that the spec omits; (3) **repository structure** — §17 vs `git ls-files`: entries
  documented but missing, top-level files/dirs present but undocumented. Output is a findings
  table per layer (finding, where spec says, where code says, severity: mismatch /
  spec-missing / code-missing) with an explicit "sound — no findings" verdict for any clean
  layer; no orientation prose. Fails (non-empty check, same as the doc mode) if generation
  returns nothing.
- **`./scripts/pip-release.sh`** — builds and uploads the `pypi/` placeholder package (§17;
  reserves the `autowright` name on PyPI, unrelated to the app build and to `release.sh`).
  Creates `pypi/.venv` if missing, installs/upgrades `build` + `twine` into it, rebuilds
  `pypi/dist/` from scratch, validates both artifacts with `twine check`, then uploads.
  Credentials come from `~/.pypirc` or `TWINE_USERNAME`/`TWINE_PASSWORD` (API token: username
  `__token__`) — never stored in the repo. Modes: **`--build`** stops after build + check (no
  upload); **`--test`** uploads to TestPyPI (`--repository testpypi`) instead of PyPI.
- **`./scripts/commit.sh`** — stages all uncommitted changes (`git add -A`), asks Claude
  (Opus 5, `claude --model claude-opus-5 -p`) for a commit message based on the staged diff
  (≤72-char imperative summary, whole message capped at 2-3 sentences), strips any markdown
  code-fence lines (```/```lang) the model wraps the message in, prints it, and commits. Exits 0 with no commit if
  the tree is clean; fails if the message is empty after stripping. Does not push. Developer-only:
  agents never run this script (`.claude/CLAUDE.md` forbids it).

