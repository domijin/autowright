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
- **First feed publish:** `docs/updates/linux-x86_64/latest-linux.yml` does not exist
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
