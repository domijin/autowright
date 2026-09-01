# Changelog

## v0.8.3 - 2026-08-31

- A What's-new changelog is now built into the app: open it from the About page to read the release notes for this and earlier versions.
- Acknowledgements now list the open-source components used on every platform, including the Windows and Linux packages that were previously missing.

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
