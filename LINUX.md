# Linux x86-64 port worksheet

Temporary working notes (SPEC §17): what remains of the Linux port, ordered by dependency.
Steps 1–4 of the original worksheet (platform modules on both halves, systemd backend
runtime, shell + renderer surface, AppImage packaging) have shipped into the spec — §2
(platform layer, both halves), §3 (Linux service / notifier / keep-awake / packaging
blocks, headless secret-store constraint), §9 (per-OS copy table Linux column, chrome,
devlog padding), §13 (tray assets, any-edge panel placement), §4.9 (XDG-autostart login
item), §18 (`prod-linux.sh`). Delete this file when the rest lands.

## Remaining: updates + release (step 5 of the original plan)

- **Update channel:** electron-updater generic provider pointed at
  `https://autowright.ai/updates/linux-x86_64/` (`latest-linux.yml` + AppImage + blockmap;
  yml under `docs/updates/linux-x86_64/`, binaries on the GitHub release — the same
  hosting split as win32). Work: `linux.cjs` `updateFeedUrl` returns the base and
  `UPDATER` names the AppImage machinery, `capabilities.updates` flips true, the
  `main.cjs:843`-area win32 lazy-require block generalizes (the renderer-facing IPC
  surface must stay byte-identical), `app/package.json` `build.linux.publish` replaces
  `null` with the generic entry (guard: `app/tests/platform-shell.test.ts` pins the null),
  and the managed-install probe may later detect a distro-package install.
- **Release leg:** a `release` script leg that builds via `prod-linux.sh`, publishes the
  AppImage + blockmap to the same GitHub release as the mac/win artifacts, and rewrites
  `docs/updates/linux-x86_64/latest-linux.yml`.
- **Download page:** `docs/index.html` gains a Linux download path once artifacts exist
  (mac-only until then, per the §17 rule).

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
