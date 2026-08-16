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

Autowright is a macOS desktop app for recurring personal automations. The user describes a job in
plain words ("Check the manga I follow for new chapters every morning at 8"); a connected AI agent
(Claude Code, Gemini CLI, Codex, or OpenCode — the latter optionally driving a local Ollama
model) writes it as human-readable
scripts; Autowright executes those scripts on a schedule, entirely on the user's Mac, and shows results.

Core promises (exact UI copy, repeated in the onboarding footer):
- "Your automations execute only on this Mac"
- "Passwords never leave your Keychain"

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
  launchd service
  (`service.py`, runnable as `python -m autowright.service` — the §3 registration entry the
  app uses; the UI and backend never invoke the CLI), CLI (`cli.py`), `awake.py` (§3/§4.9 `keepAwake` permanent power assertion).
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
  `AUTOWRIGHT_HOME` override), `timefmt.py` (§4.1 display labels + §5 canonical UTC
  timestamps), `yamlio.py` (§5 atomic temp-write + rename IO).
  `autowright/instructions/` holds the §8 prompt texts as markdown (packaged via
  `[tool.setuptools.package-data]`): `framework-instructions.md` (contract preamble) and
  `default-build-instructions.md` (default build instructions seeded into new automations).
  `pyproject.toml` defines the `autowright` / `autowright-backend` entry points.
- `app/` — Electron app: `electron/main.cjs` + `preload.cjs` (window, tray panel, backend.json
  bridge), Vite + React + TS renderer under `src/` (`store.ts` central model, `api.ts` client,
  `ui.tsx` shared primitives, `tokens.css` design tokens, `pages/` one file per screen —
  except the §11 create/edit flow: `pages/CreateFlow.tsx` is a thin page over the
  `pages/createflow/` directory (`model.ts` — the pure editor model and helpers,
  `useDraftJob.ts` — §8 job polling, `ChatPanel.tsx`, `BuildTestPanel.tsx`,
  `SectionCards.tsx`), and a shared step-list/param-editor module serves both the
  create/edit flow and the automation detail page).
  `brand-electron.cjs` (npm `postinstall`) renames the dev Electron.app bundle to "Autowright"
  (§14). `electron/icon/` holds the checked-in AW app-icon assets (§14: `icon.svg`
  source, `icon.png` 1024 px dock/raster, `icon.icns` bundle icon); `electron/` also holds
  the checked-in tray template PNGs (`trayTemplate.png`/`@2x`, `trayAlert.png`/`@2x`),
  rendered by `scripts/gen_tray_icon.py`.
  Renderer tests live here too: `app/tests/` (vitest unit/render suites) and `app/e2e/`
  (end-to-end specs driving the real Electron app, shared `harness.ts`); both Vitest configs
  (`vitest.config.ts`, `vitest.e2e.config.ts`) sit at the `app/` root — `npm run test:e2e`
  passes the e2e one via `--config`. `ds-entry.ts` is the renderer entry point for the `.design-sync/`
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
  GitHub release via `gh`, and rewrites the §3 update feed under `docs/updates/`, §18;
  `test-fast.sh` runs the cheap test tiers cheapest-first (§15 shift-left order), §18;
  `test-all.sh` runs every test tier in the same order — the fast gate via `test-fast.sh`,
  then pytest `-m integration`, then e2e — §15/§18;
  `knowledge.sh` regenerates `knowledge.md`; its `audit` mode writes `knowledge-audit.md`, §18;
  `pip-release.sh` builds and uploads the `pypi/` placeholder package, §18;
  `gen_licenses.py` regenerates `app/src/acknowledgements.md` — the §4.9
  open-source-libraries list, checked in, refreshed by `build.sh` on every build).
- `skills/autowright/` — the agent skill (`SKILL.md`): teaches an AI coding agent (Claude Code
  and compatible harnesses) to drive Autowright end-to-end through the §20 CLI — create/edit
  automations via pull/push workdirs, execute and follow, inspect results, manage params,
  triggers, secrets, settings. The skill presents a summary for user confirmation before
  saving or executing — the full command including `--grant-*` flags (§20 review-promise and
  grant-model rules). Checked in beside the code; users copy or symlink it into their agent's
  skill directory.
- `tests/` — pytest suite for the backend (storage, drafting, engine, triggers, API): the fast
  tiers at the top level (shared `tests/conftest.py`), the live integration tier under
  `tests/integration/` (§15 — its own `conftest.py` + `it_harness.py`), the test doubles
  `tests/bin/claude` (fake agent CLI) and `tests/bin/osascript` (fake Messages sender),
  and `tests/seed_data.py` (§16 fixture). `pytest.ini` at the repo root configures
  the suite. Renderer tests live under `app/` (above), not here.
- `docs/` — marketing landing page for autowright.ai, hosted via GitHub Pages (`index.html`
  single self-contained page + `CNAME` with the custom domain). Dark, matches the §14 visual
  language (IBM Plex Sans/Mono — no 700 weight, per §14 — brand orange accent `#f68b43`, and
  the §14 AW-monogram mark as both header mark and favicon, inlined from
  `app/electron/icon/icon.svg`). Audience: technically savvy users plus curious
  non-technical people — plain-language copy, no jargon. Page structure, in order: header
  (mark + wordmark + GitHub link) · hero (headline, one-paragraph pitch, "Download for
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
  chat-pane layout: a scrolling thread above a pinned composer. The composer is a
  bordered `.ad-input`-style textarea with the real placeholders (empty-state
  "Describe the job - one sentence is enough.", then the in-thread
  "Change something, or ask a question…" once the first turn lands), agent-picker and
  Send/Cancel both `.ad-btn-pill` clones — mono 10.5 px, white .06 background, radius 6,
  microchip glyph + `name · model` + caret-down on the picker. Each scene plays a §11
  turn in thread form: the typed prompt lands as the quiet right-aligned user bubble;
  then the §11 operation blocks stream in — spinner while live, settling to a green
  check beside the unified §8 stage labels "Working on the request…" / "Updating the
  documents…" / "Syncing the workflow…", each with its `• `-bulleted feed lines flush
  left ("Choosing what to do"; "Writing the spec"; "Writing the manifest - name,
  triggers, parameters, step list" and "Writing step n of N - `NN-name.py`") — with the
  faint system-chip receipts between stages ("Spec updated." `fa-file-pen`,
  "Renamed to …" / "Description updated." `fa-pen`, "Steps synced with the spec."
  `fa-rotate`); the turn closes with the §11 turn action row — "Undo this change"
  (`fa-rotate-left`) and "Test draft" (`fa-vial`) as icon-led action pills. No step
  cards, no trigger/ran chips — the demo shows exactly what the app's thread shows.
  Three looping scenes cover a cron, a Discord-trigger, and an interval job across
  different agents; the thread clears between scenes and the empty-state heading
  returns) · a three-step "how it works" strip (say it → read it → let it run) · three promise
  cards (the two §1 core promises plus the review promise "Nothing executes until you
  approve it") · a feature grid (message triggers, runs-with-window-closed + menu bar,
  versions, memory + snapshots, execution history, `.autowright` share/import) ·
  supported-agent badges (Claude Code, Gemini CLI, Codex, OpenCode + local Ollama) · closing
  download CTA (same feed-driven direct-DMG link as the hero — both anchors carry
  `data-download`; the JSON-LD `downloadUrl` stays the static latest-release page URL) ·
  footer (GitHub, Privacy, MIT). All repo links point to
  `hansololz/autowright`. The page never uses the em dash character (—) anywhere -
  copy, meta tags, demo strings, code comments; where an app string it mirrors
  carries one, the page substitutes a plain hyphen. Respects `prefers-reduced-motion`. Head metadata: canonical
  `https://autowright.ai/`, `theme-color` `#090d14`, Open Graph + Twitter-card tags with a
  1200×630 social image (`docs/og.png`, AW mark + headline on the dark background),
  `docs/apple-touch-icon.png` (180 px full-bleed AW mark), and JSON-LD
  (`SoftwareApplication`, macOS, free, MIT). Sections below the demo fade up on first
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
- `LICENSE` — MIT, copyright David Zhang (also `"license": "MIT"` in `app/package.json`).
- `PRIVACY.md` — the privacy policy, canonical copy: rendered in-app on the §9.4 About
  page (raw import into the renderer bundle) and read by GitHub visitors in place.
