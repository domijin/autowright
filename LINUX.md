# Linux x86-64 port worksheet

Temporary working notes (SPEC §17): the audited port surface for building Autowright on
Linux x86-64, ordered by dependency. Each item moves into the spec as it ships; delete this
file when the port lands. Written on macOS 2026-08-22 from a full-repo audit; verify line
numbers before editing, they will drift. Decisions below are recommendations until David
settles them (the Windows precedent: a "settle the decisions" pass before implementation).

## Already in place (no work needed)

The §2 platform layer already routes Linux through explicit degraded builds on both halves,
and the shared plumbing is Linux-correct:

- Backend: `backend/autowright/platform/fallback.py` composes on Linux via
  `platform.current()` - service verbs answer plain "not supported on Linux yet" lines
  (exit 1), notifier/power are no-ops, capabilities all false, and **process control is
  real** (`posixproc.PosixProcessControl` is shared POSIX code). Tests:
  `tests/test_platform.py` (fallback composition + the Linux XDG root rows).
- Shell: `app/electron/platform/fallback.cjs` selected by `index.cjs` off darwin/win32.
  Correct values already: `OS_TOKEN 'linux'`/`OS_NAME 'Linux'`, XDG roots via `roots.cjs`
  (`$XDG_DATA_HOME/autowright`, `$XDG_STATE_HOME/autowright/log` - drift-guarded on both
  halves), `python/bin/python3` bundled-interpreter layout (matches the Linux
  python-build-standalone tarball), the POSIX `~/.local/bin/autowright` shim (`#!/bin/sh`,
  `# autowright CLI shim` marker - `main.cjs`'s status/heal/install/uninstall works
  unchanged), login-shell PATH probe. Placeholders: native frame, mac tray PNGs, no update
  feed, no managed-install probe.
- Secrets: `keychain.py` is pure `keyring` - the same code works on Linux once the Secret
  Service backend deps are pinned (step 1 below).
- Everything else is capability-gated already: `main.cjs` gates tray/login-item/dock/update
  wiring on `plat.capabilities`; the renderer gates on `/health` `os` + `capabilities`
  (iMessage chip, keep-awake row, notifications row, agent install actions); update IPCs
  answer the §3 "Updates are not supported on this platform yet." line.

Only 11 non-test platform checks exist repo-wide, all inside the layer or dev tooling - the
port fills in modules, it does not hunt call sites.

## Decisions to settle (recommendations)

1. **Distributable: AppImage via electron-builder (`--linux appimage`), x86_64 only.**
   Reuses the Windows electron-builder pipeline shape (`windows-scripts/prod.ps1` is the
   template), pairs with electron-updater's AppImage provider so the renderer-facing update
   IPC surface stays byte-identical (the §3 Windows rule), and needs no distro packaging
   review. deb/rpm/flatpak deferred; if one is added later it is a distro-managed channel
   like the Homebrew cask (updater refuses, package manager owns updates). Unsigned is fine
   (the Windows sign-later principle; Linux has no Gatekeeper/SmartScreen equivalent).
   Guard to relax: `app/tests/platform-shell.test.ts:176` asserts the electron-builder
   config has no `linux` key.
2. **Service manager: systemd user unit** (`~/.config/systemd/user/ai.autowright.backend.service`,
   registered via `systemctl --user`). The launchd contract maps as: unit name
   `ai.autowright.backend` (same reverse-DNS label); `ExecStart` = the backend interpreter's
   `python3 -m autowright.main`; `Restart=always` (KeepAlive) + `WantedBy=default.target`
   enabled (RunAtLoad); `install` = write unit + `daemon-reload` + `enable --now` + the §3
   health-poll verification; `uninstall` = `disable --now` + delete unit; `status` =
   `is-active`/unit-file presence mapped to the three §3 states; `stop` = `systemctl --user
   stop` only (unit stays enabled, returns at next login - the "bootout only" rule) plus the
   §3 stray-process sweep; `restart` = `systemctl --user restart`. Every `systemctl` call
   carries the same 30 s timeout + plain-word failure as `launchctl`. **Log routing:**
   `StandardOutput=append:` / `StandardError=append:` to the §5 logs root's `backend.log`,
   matching launchd's file capture so the §9.3 log overlay and `main.py`'s startup trim work
   unchanged (journal-only would orphan them; note `append:` needs systemd ≥ 240, fine
   everywhere current). Non-systemd distros stay on the degraded fallback lines - not
   supported for v1, documented, never a crash. Linger is not needed (the service is
   per-login-session, same as the LaunchAgent; the §3 stay-logged-in guidance carries over).
3. **Secrets: freedesktop Secret Service via keyring.** Pin `secretstorage` + `jeepney`
   in `backend/pyproject.toml` and `constraints.txt` under `sys_platform == "linux"`
   (mirror of the win32 `pywin32-ctypes` pin) - without them keyring silently resolves the
   null backend. User-facing name: "system keyring" (`paths.secret_store_name()` gains a
   `linux` arm; the §1 promise renders "Secrets live in your system keyring" through the §9
   per-OS copy table). Headless caveat mirrors the macOS Keychain one: a keyring daemon
   (GNOME Keyring / KWallet) needs an unlocked session; pure SSH without one cannot read
   secrets. Documented, not worked around.
4. **Tray: best-effort colored StatusNotifierItem.** Electron's Linux tray rides
   libappindicator/StatusNotifier; stock GNOME needs a user extension, so the tray is
   probed-not-assumed: `capabilities.trayPanel` stays best-effort and the existing
   `window-all-closed` discriminator (no dock + no live tray → quit) already handles the
   trayless case. New assets `trayLinux.png`/`@2x` + alert variants (colored, like the
   Windows set) rendered by `scripts/gen_tray_icon.py`. Panel placement: anchor to the tray
   click point against `display.workArea` on all four edges (the Windows height-aware
   bottom-anchor logic generalized), since Linux panels sit anywhere.
5. **Window chrome: native frame for v1** (what `fallback.cjs` already does). No custom
   title bar, no vibrancy; the §14 dark theme fills the client area. Revisit after v1 if the
   native bar clashes.
6. **Login item: XDG autostart.** Electron's `setLoginItemSettings` is a no-op on Linux;
   the §4.9 `login` setting reconciles a `.desktop` file in `~/.config/autostart/` instead
   (write on enable, delete on disable - same marker-style ownership rules as the CLI shim).
   Flips `capabilities.loginItem` true.
7. **Notifier: `notify-send`** (libnotify) - a small `LinuxNotifier` with the darwin
   contract (best-effort, never raises, never blocks); probe the binary once and flip
   `capabilities.notifications` accordingly (absent on minimal installs).
8. **Keep-awake: `systemd-inhibit` subprocesses**, one per assertion, each wrapping a
   `sleep infinity` tied to the backend's lifetime the way `caffeinate -w` is (child dies
   with the backend, so no orphan can keep the machine awake) - `--what=idle
   --who=Autowright`. Flips `capabilities.keepAwake` true on systemd hosts.
9. **Update channel: ship the feed with the packaging step.** electron-updater generic
   provider pointed at `https://autowright.ai/updates/linux-x86_64/` (`latest-linux.yml` +
   AppImage + blockmap; yml under `docs/updates/linux-x86_64/`, binaries on the GitHub
   release - the same hosting split as win32). `linux.cjs` `updateFeedUrl` returns the base;
   the managed-install probe returns false (or detects a distro-package install later) and
   `MANAGED_COPY_ERROR` loses the Homebrew wording.
10. **Agent install: enable the curl-pipe installers.** The Claude Code / opencode / Codex
    installer scripts in `installer.py` support Linux upstream; `agentInstall` can go true.
    Two mac-only pieces need per-OS treatment: the Ollama artifact (`OLLAMA_APP_ZIP` is a
    darwin app bundle; Linux uses Ollama's official install script) and the §19
    sign-in-help Terminal flow (osascript; Linux equivalent is launching the user's
    terminal - messy, so recommend degrading sign-in help to the §9 manual copy-paste lines
    for v1 while keeping install enabled, which needs the capability split or a per-verb
    gate - settle during step 2).

## Dev setup on Linux

`scripts/*.sh` are bash and mostly portable, but audit `dev.sh`/`build.sh` on the machine
first (BSD-vs-GNU flag differences: `sed -i ''`, `stat -f`, etc.). Manual baseline:

```
python3.14 -m venv .venv
.venv/bin/pip install -c backend/constraints.txt -e 'backend[dev]'
.venv/bin/python -m pytest -q        # expect launchd-internals + macOS-install-surface skips
cd app && npm ci && npx tsc --noEmit -p tsconfig.test.json && npx vitest run
```

Record the intended per-OS skip count once known (Windows precedent: 34). The launchd
internals tests skip; systemd ServiceManager tests replace them in step 2.

## Port order (each step buildable/verifiable on the Linux machine)

1. **Groundwork (can be written on macOS).** New `backend/autowright/platform/linux.py`
   (`build()` composing: systemd `ServiceManager` per decision 2, `notify-send` notifier,
   `systemd-inhibit` power, shared `posixproc.PosixProcessControl`; capabilities per the
   decisions) and `app/electron/platform/linux.cjs` (the full 24-export darwin surface with
   the fallback's already-correct values plus the decided ones); route both
   (`platform/__init__.py`, `index.cjs`). Parity is test-pinned
   (`app/tests/platform-shell.test.ts:94`, `tests/test_platform.py`), so a missed export
   fails loudly. Pin `secretstorage`/`jeepney` (decision 3). Then run the dev-setup baseline
   on the Linux machine and fix what it surfaces (the Windows baseline found blockers the
   audit missed: tzdata, cp1252 pipes - expect Linux equivalents, e.g. missing keyring
   daemon in CI-ish environments, `ps` BSD-args behavior under procps/busybox in
   `posixproc.py:47,61`).
2. **Backend runtime.** Implement + verify the systemd ServiceManager against the §3
   contract (install/uninstall/status/stop/restart result lines, health-poll, stray sweep,
   shim-heal half of `service install` - the POSIX helpers in `service.py:35-99` are
   already right, they just need to be called). Notifier + power land here too. Flip
   capabilities. `harness.py:90-95` gains Linux fallback bin dirs (`/usr/bin`, `/snap/bin`,
   `~/.nix-profile/bin` beside the existing ones). Agent-install enablement per decision 10.
3. **Shell + renderer surface.** `linux.cjs` finishing: tray assets + probed tray, XDG
   autostart login item, panel placement, managed-install/`MANAGED_COPY_ERROR` wording.
   Renderer: `app/src/platformCopy.ts` gains the third `LINUX` entry (`:70` becomes a
   3-way map) - "this PC"-style machine noun, "system keyring", "Show in file manager",
   `~/.profile` PATH command; `paths.machine_noun()` and `secret_store_name()` gain
   `linux` arms and the §19 keyring-locked copy in `api.py:1825` gets Linux remedy text;
   `devlog.tsx:153`'s 38 px traffic-light padding and `App.tsx:242`'s shell-background
   fork become per-OS. e2e literal selectors go through the copy helper when e2e first
   runs on Linux (same open item Windows had).
4. **Packaging.** `scripts/prod-linux.sh` (or a `--linux` mode in a shared script):
   sync `VERSION`, vite build, download python-build-standalone
   `x86_64-unknown-linux-gnu-install_only` (same pinned CPython 3.14.7 tag as `prod.sh`,
   `python/bin/python3` layout - `fallback.cjs`/`linux.cjs` `bundledPythonPath` already
   matches), pip install with `-c constraints.txt`, bundled-interpreter smoke test with
   `PYTHONDONTWRITEBYTECODE=1`, electron-builder `--linux appimage --x64` with
   `extraResources` reuse from the win config. Artifact
   `Autowright-<version>-linux-x86_64.AppImage`. No signing/notarization leg.
5. **Updates + release.** electron-updater generic provider on linux (the win32 lazy-require
   block in `main.cjs:843` generalizes; the IPC surface must stay byte-identical),
   `docs/updates/linux-x86_64/latest-linux.yml`, a `release` leg that publishes the AppImage
   + blockmap to the same GitHub release and rewrites the feed, and the `docs/index.html`
   download path once artifacts exist (mac-only until then, per the §17 rule).

## Audit dregs (small, catch during the matching step)

- `fallback.cjs:83` `MANAGED_COPY_ERROR` says "managed by Homebrew" - wrong copy off macOS
  (step 3).
- `installer.py:26,30,43` hardcodes `~/.local/bin`, `/usr/local/bin`, `/Applications` -
  reviewed in step 2's agent-install work.
- `main.py:70` self-redirects stdout/stderr only on Windows - stays that way if decision 2's
  `append:` log routing holds; otherwise Linux joins the self-logging branch.
- `app/e2e/harness.ts:18` POSIX venv arm already covers Linux.
- The §2 UTF-8 pipe contract is Windows-motivated and harmless on Linux (locale default is
  UTF-8 on any current distro); no work.
