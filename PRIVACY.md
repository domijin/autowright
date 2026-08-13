# Privacy policy

Autowright collects nothing. There is no telemetry, no analytics, no crash
reporting, no account, and no Autowright server. This page explains where your
data lives and the few network connections the app can make — each one listed
below, with its off switch.

## Everything stays on your Mac

- **Automations, versions, executions, settings** are stored in
  `~/Library/Application Support/Autowright` (execution data location is
  changeable in Settings). Nothing is synced or uploaded.
- **Secrets** (passwords, API keys) are stored in the macOS Keychain. Secret
  values never appear in scripts, logs, or exported files, and are injected
  only at execution time.
- **Memory and logs** stay in the same local folders. You can open, snapshot,
  or delete all of it at any time.

## The AI you connect is your choice

When you create or edit an automation, Autowright sends the drafting context —
your description, the automation's spec, build instructions, and related step
code — to the AI agent **you** connected (Claude Code, Gemini CLI, Codex, or
OpenCode). That data is handled under that provider's own terms and privacy
policy, using your own account. If you use OpenCode with a local Ollama model,
drafting also stays entirely on your Mac.

## Network connections Autowright itself makes

- **Check for updates** — once a day by default: one request to autowright.ai
  (served by GitHub Pages) to read the latest version number, nothing more.
  Turn off "Check for updates automatically" on the About page and Autowright
  never checks in the background — only when you press the button. Downloading
  an update — always started by you — fetches it from GitHub. Those servers
  see your IP address, as with any web request.
- **Installing an AI or a model** — only when you ask during setup: downloads
  come from the provider's official source (npm, Ollama, or the vendor's
  installer).

That is the complete list. Your automations' scripts can of course reach the
network themselves — but only in the ways you reviewed and saved.

## Changes

This policy lives at the root of the repository; any change to it is visible in
the project's git history.

_Last updated: 2026-08-12_
