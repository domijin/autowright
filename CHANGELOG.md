# Changelog

## v0.8.2 - 2026-08-31

- The Executions list is now paged: 50 finished rows at a time with a Prev/Next pager, and deeper history fetched on demand.
- The status filter splits into per-status segments, including Running and Queued tabs; "Waiting" is now called "Queued" everywhere.

## v0.8.1 - 2026-08-30

- Schedules can opt out of catch-up: a per-trigger "Run if missed" setting decides whether a cron or one-time run slept through fires late or is dropped - in the trigger editor, the CLI, and transfer archives.
- Step rows show the retry budget next to the timeout, in the detail view and the editor.
- A sleep disclaimer appears wherever the app promises background firing.
- Linux installs get a proper launcher entry and app icon on first launch.

## v0.8.0 - 2026-08-29

- Windows gets a proper in-app title bar, with the sidebar and chat panel aligned beneath it.
- Editing a secret that is already set shows a masked "kept value" row, so it is clear the current value stays unless you replace it.
- The Build & test panel no longer jumps while a sync is running.

## v0.7.2 - 2026-08-28

- Launch-at-login is registered only by the installed app, so running a development copy no longer changes your login item.

## v0.7.1 - 2026-08-27

- Stability fixes around concurrent runs, imports, and queued executions, plus cleaner errors for bad input in the app and the CLI.

## v0.7.0 - 2026-08-27

- The create flow streams live progress from Codex, Gemini CLI, and OpenCode runs, and a signed-out Gemini CLI fails fast with a clear error.
- Per-step durations show on the chat thread's step bullets.
- Long tool inputs in the chat thread are collapsed, and URL fetches are labeled as reads.
- `autowright --help` documents the full command surface.

## v0.6.3 - 2026-08-25

- Import and Export return, rebuilt: shared agents and secrets are matched against what you already have instead of recreated, and anything unmatched imports flagged for attention instead of failing the whole import.
- Imported automations finish their package setup in the background, so the import returns immediately.

## v0.6.2 - 2026-08-24

- Re-running onboarding no longer creates duplicate agents.

## v0.6.1 - 2026-08-24

- macOS auto-update moves to a standard updater flow.
- Backward-compatibility promise: data written by v0.6.0 and later keeps loading in newer versions.

## v0.6.0 - 2026-08-23

- Linux support: a packaged Linux build (AppImage) with in-app updates.
- Windows packaging and releases land.
- Settings gains a Reset card that wipes all data and quits the app.
- Import and Export are temporarily hidden while they are reworked.

## v0.5.0 - 2026-08-22

- Windows x86-64 support: a real Windows distribution with its own installer and tray icons.

## v0.4.1 - 2026-08-21

- Automations that miss their schedule are flagged overdue, and a corrupt data file degrades to read-only instead of breaking the app.

## v0.4.0 - 2026-08-21

- The `autowright` CLI is enabled by default and installed on first run.
- A needs-fixing audit surfaces missing or ungranted secrets, agents, and packages - as a list chip, a detail banner, and CLI output.
- Automation names must be unique; import dedupes names visibly.
- Drafting jobs keep running in the background and re-attach when you return.
- Homebrew-managed installs hand updates to `brew upgrade`.

## v0.3.5 - 2026-08-17

- Autowright can be installed through a Homebrew cask.

## v0.3.4 - 2026-08-17

- Drafting prompt hardening, including resistance to prompt injection from message content.
- Drafting jobs owned by a draft are cancelled when the draft settles.

## v0.3.3 - 2026-08-16

- Small presentation fixes on the automation detail page.

## v0.3.2 - 2026-08-16

- The CLI becomes an explicit toggle with a user-local install, an explicit Delete action, and a copyable add-to-PATH command; no admin prompt.
- "Quit entirely" stops the background service instead of leaving it running.

## v0.3.1 - 2026-08-16

- "Report an issue" opens a prefilled GitHub issue.
- The CLI resolves automations by unique id prefix.

## v0.3.0 - 2026-08-16

- Creating and editing become one continuous chat: describe changes in conversation and the draft, parameters, triggers, and concurrency update from it.
- Chat entries are redesigned into operation and message blocks, and chat history outlives the draft.
- Versions can be deleted from the version menu.

## v0.2.5 - 2026-08-14

- Job activity splits into one chat entry per stage.

## v0.2.4 - 2026-08-14

- Ollama model pulls are more reliable.

## v0.2.3 - 2026-08-14

- Manual executions can queue when all concurrency slots are busy.
- The concurrency card shows on every automation.

## v0.2.2 - 2026-08-14

- Local-model (Ollama) mode extends to Claude Code and Codex.
- Automation memory files can be listed and read, in the app and the CLI.

## v0.2.1 - 2026-08-13

- "Update available" becomes a nav row, backed by an opt-out daily automatic update check.
- Esc cancels an in-flight composer job.

## v0.2.0 - 2026-08-09

- Steps declare their packages and grants with a per-use "why" note shown on the review screen.
- Discord message triggers reply to every firing, threaded in Discord.
- Field names are spelled out in full across the app, API, and CLI.

## v0.1.2 - 2026-08-08

- Undo arrives in the draft chat.
- Keyboard and screen-reader hardening: real buttons and proper dialog roles.

## v0.1.1 - 2026-08-07

- Discord triggers gain an optional author filter.
- Automations can be imported from a URL, with a preview step.
- Draft testing gets a Run test row with an optional mocked trigger message.

## v0.1.0 - 2026-08-06

- First release: describe a recurring job in plain words, a connected AI agent (Claude Code, Gemini CLI, Codex, OpenCode, or a local Ollama model) writes it as readable Python steps, and Autowright schedules and runs it on your Mac.
- Automations, versions, executions with per-step logs, cron, one-time, and message triggers (Discord and iMessage), parameters, Keychain secrets, a menu bar surface, and the `autowright` CLI.
