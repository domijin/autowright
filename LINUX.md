# Linux x86-64 port worksheet

Temporary working notes (SPEC §17): what remains of the Linux port, ordered by dependency.
Steps 1–5 of the original worksheet (platform modules on both halves, systemd backend
runtime, shell + renderer surface, AppImage packaging, updates + release) have shipped
into the spec — §2
(platform layer, both halves), §3 (Linux service / notifier / keep-awake / packaging +
updates blocks, headless secret-store constraint), §9 (per-OS copy table Linux column,
chrome, devlog padding), §13 (tray assets, any-edge panel placement), §4.9 (XDG-autostart
login item), §18 (`linux-scripts/prod.sh` + `release.sh`). Delete this file when the rest
lands.

## Remaining

- **Download page:** `docs/index.html` gains a Linux download path once artifacts exist
  (mac-only until then, per the §17 rule).
- **First feed publish:** `release/linux-x86_64/latest-linux.yml` does not exist
  until the first `linux-scripts/release.sh` run after this change writes it — until
  then a Linux build's update check errors with the generic network copy (the same
  window win32 had before its first release).
- The managed-install probe may later detect a distro-package install (`linux.cjs`
  `managedInstall` answers false for now).

## Open items noted during steps 1–4

- Dev-setup prerequisite on Debian/Ubuntu: `apt install python3.14-venv` (ensurepip is
  split out of the base python package, so `python3.14 -m venv` fails without it).
  Node lives user-local at `~/.local/opt/node-v24.19.0-linux-x64` (symlinked into
  `~/.local/bin`). Audit `scripts/dev.sh`/`build.sh` for GNU-vs-BSD flag drift before
  first use here.
- e2e literal selectors go through the copy helper when e2e first runs on Linux (same
  open item Windows had).
- AppImage runtime needs FUSE (`libfuse2`) on some distros — decide whether the download
  page documents `--appimage-extract-and-run` as the fallback.
- Ubuntu 24.04+ AppArmor userns restriction
  (`kernel.apparmor_restrict_unprivileged_userns=1`): unconfined Chromium cannot create
  its namespace sandbox and falls back to the SUID helper, which inside an AppImage can
  never be setuid root — the packaged app aborts exactly like a dev checkout did. Decide
  the packaged answer before the Linux release (ship an AppArmor profile with the app?
  document a one-time sysctl?). The dev loop already heals its own checkout:
  `linux-scripts/dev.sh` fixes `chrome-sandbox` ownership/mode via sudo (§18).
- README still reads "macOS only" — release-messaging update when Linux (and Windows)
  artifacts are published.

## Deferred from the 2026-08-22 pre-release audit

Linux-specific findings parked until the Linux release becomes active work. Each names
the file it lives in; none block the macOS release.

- **Published 0.5.0 AppImage is broken and should be pulled from the v0.5.0 GitHub
  release.** It was built before the AppImage-updater commit (ee2a847), so it ships
  `updates: false` (About answers "Updates are not supported on this platform yet."
  forever); the release carries no `.AppImage.blockmap`; `release/linux-x86_64/
  latest-linux.yml` does not exist. It also hits the AppArmor userns abort above on
  stock Ubuntu 24.04+. Users can reach it today through the site's static
  latest-release fallback link. Delete the asset until a real `linux-scripts/release.sh`
  run publishes a working one.
- **New-agent page swallows the Linux sign-in instruction.**
  `app/src/pages/AgentNewPage.tsx:177-185` treats every 409 from `/agents/login` as
  "already signed in - ready to save". On Linux, `installer.login` raises the
  "run this command in your terminal" instruction for claude/gemini/opencode, which
  `api.py` turns into a 409 - so the user gets a false success toast and never sees the
  command. `Onboarding.tsx:288-291` already does this right by matching on the
  "already signed in" message text; the page must use the same check.
- **Tray stranding on GNOME without a StatusNotifier host.** `new Tray()` succeeds and
  returns a live object even when no host renders it, so the `main.cjs:1297-1303`
  residency guard (non-null tray keeps the app alive after the last window closes)
  leaves a running process with no window and no visible icon. The guard only protects
  against a constructor that throws. Needs a real probe or a different residency rule.
- **`window-all-closed` never fires once the tray panel has been opened** (shared with
  Windows - see WINDOWS.md). The panel is a `closable: false` BrowserWindow that is only
  ever hidden, so Electron's all-closed event is unreachable afterward.
- **Service-manager timeout multiplication twin.** `platform/linux.py` `_await_active`
  polls 40 x with each probe blocking up to 30 s (worst case ~20 min). Apply the same
  wall-clock-deadline fix the macOS `service.py` gets.
- **`app/src/acknowledgements.md` lost the Linux keyring closure** (cffi, cryptography,
  jeepney, pycparser, SecretStorage) when a macOS regeneration overwrote a Linux one
  (467aa24). `build.sh` regenerates per-build so the AppImage itself is fine, but the
  checked-in file under-reports; regenerate on a Linux build when convenient.
- **`PRIVACY.md` hardcodes macOS copy** ("your Mac", `~/Library/Application Support`,
  "macOS Keychain") and is rendered verbatim in-app; needs a per-OS seam before any
  Linux release (shared with Windows).
- **`linux-scripts/release.sh` hygiene:** stale "GitHub Pages serves the yml" comment
  (feeds moved to raw in 0c4e6f5), and no current-branch guard while the feed URLs
  hardcode `/main/` (a release cut from a topic branch leaves raw serving the old feed).
