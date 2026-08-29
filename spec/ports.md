# Port worksheet — Windows & Linux open items

Temporary working notes (SPEC §17), **not a numbered spec section**. The ports themselves
shipped into the spec (§2 platform layer both halves, §3 per-OS service / notifier /
packaging / update blocks, §9 per-OS copy table, §13 tray, §18 per-OS script pairs); this
file holds only what remains open, consolidated from the former root `WINDOWS.md` /
`LINUX.md` worksheets. Every item below was re-verified against the working tree on
2026-08-27 (v0.7.1); resolved items were dropped (the Linux first-feed publish —
`release/linux-x86_64/latest-linux.yml` exists at 0.6.0 — and the e2e per-OS copy-helper
selectors, done via `app/e2e/harness.ts` `COPY`). Each remaining item moves into the
§-sections as it ships; delete the file when empty.

## Shared (both OSes)

- **`window-all-closed` never fires once the tray panel has been opened.** The panel
  (`app/electron/main.cjs:625`) is a `closable: false` BrowserWindow that is only ever
  hidden (`:612`, `:640`, `:745`, and `:548` when the tray icon is switched off — which
  destroys the tray but only hides the panel), never closed or destroyed, so the residency
  check at `main.cjs:1312-1315` is unreachable afterward. Scenario: open the tray panel
  once, later disable `menuBarIcon` in Settings, close the main window — resident
  invisible process with no quit path. Fix the panel teardown or the residency rule.
- **Service-manager timeout multiplication — all three OSes.** Fixed poll counts multiply
  with per-probe subprocess timeouts instead of a wall-clock deadline:
  `platform/windows.py` `_await_running` 20 × a PowerShell probe blocking up to 30 s
  (`windows.py:243-244`, `:376-383`), `platform/linux.py` `_await_active` 40 × 30 s
  (`linux.py:34-35`, `:126`), and the macOS `service.py` loops (`:139`, `:248`). Blast
  radius is smaller than first written up: a probe that *times out* returns an error and
  aborts the loop, so the pathological case is repeated slow-but-successful probes
  (~10–20 min ceiling), not stacked timeouts. Replace with a `monotonic()` deadline.
- **`PRIVACY.md` hardcodes macOS copy** ("your Mac" `:8`, `:26`;
  `~/Library/Application Support` `:11`; "macOS Keychain" `:13`) and is rendered verbatim
  in-app (§9.4); needs a per-OS seam (the app's own store-name table is
  `paths.py:50-51`). The §9.4 legal-disclaimer copy in `spec/ui-shell.md` ("on this
  Mac") shares the problem.
- **Release-script hygiene twins.** `windows-scripts/release.ps1:77-78` and
  `linux-scripts/release.sh:77-78` both carry the stale "GitHub Pages serves the yml"
  comment (feeds moved to raw in 0c4e6f5), and neither has the current-branch guard the
  mac leg has (`scripts/release.sh` `require_main_branch`) while both push `origin HEAD`
  with feed URLs hardcoding `/main/` — a release cut from a topic branch leaves raw
  serving the old feed.
- **`managedInstall` answers false on both** (`win32.cjs:122-124`, `linux.cjs:153-156`);
  the probe may later detect a distro-package / winget-style managed install.
- **Release messaging: Windows is advertised as experimental; Linux is not advertised
  yet.** The README (2026-08-28) lists both builds but labels them **unstable** (early
  testers only; Windows unsigned / SmartScreen, Linux lagging and failing on Ubuntu
  24.04+). The download page (`docs/index.html`, §17) carries a second, ghost-style
  "Download for Windows" button tagged `experimental` (2026-08-28) that reads the
  `win32-x86_64` entry of `downloads.json`, and says "Windows experimental · Linux coming
  soon"; Linux gets no button until its port is stable. When Windows is stable, drop the
  README "unstable" wording and the page's `experimental` tag together; when Linux is,
  add its button + copy the same way.

## Windows

- **Shipped 0.5.0 exe is cut off from updates — remedy still undecided.** It has the old
  `https://autowright.ai/updates/win32-x86_64/` feed URL baked in, which 404s since the
  feeds moved to GitHub raw (0c4e6f5). No win32 bridge exists (`release/` holds only the
  darwin `feed.json` Squirrel bridge); the 0.6.0 release (feed at
  `release/win32-x86_64/latest.yml`, 2026-08-23) did not restore the legacy path. Decide
  clean break vs restored legacy feed — and, per the shared release-messaging item,
  whether the site advertises the 0.6.0 exe it already indexes.
- **Verify `appMenu: true` on a real Windows build.** `spec/ui-shell.md` claims
  `titleBarStyle: 'hidden'` never draws the stock menu bar on Windows and
  `win32.cjs:151` relies on it (`main.cjs:1274` gates `Menu.setApplicationMenu(null)` on
  `!caps.appMenu`). If a real build does draw it, ship the same one-line
  `appMenu: false` Linux got (Ctrl+C/V/X/A stay Blink-native).
- **`shim_text()` uses `sys.executable` — live shim ping-pong.**
  `platform/windows.py:520-525` emits `"{sys.executable}" -m autowright.cli %*`, which
  under the Task Scheduler backend is `pythonw.exe` (`windows.py:397`), while the shell
  writes its shim from `backendInfo().python` = `paths.console_python()`
  (`app/electron/main.cjs:686,691,705`; `main.py:157`). The two texts differ
  byte-for-byte, and each side's whole-file compare keeps rewriting the other's shim.
  Use `console_python()` in `shim_text()`.
- **`skills/autowright/SKILL.md:46-49` hardcodes the POSIX PATH help** (`~/.local/bin`,
  the zsh `~/.zprofile` one-liner) — wrong on Windows; needs per-OS wording before the
  skill is advertised to Windows users.
- **NSIS-specific updater behavior has zero test coverage on macOS hosts.** The
  electron-updater describe in `app/tests/main-cjs-leaf.test.ts` runs on every OS, so the
  shared handler logic is covered on mac hosts — but NsisUpdater-specific behavior
  (installer swap, differential/blockmap) still is not. Run the renderer suite (and e2e)
  on a real Windows host before the next Windows release.

## Linux

- **Published 0.5.0 AppImage is broken and should be pulled from the v0.5.0 GitHub
  release** (still attached as of 2026-08-27: `Autowright-0.5.0-linux-x86_64.AppImage`,
  3 downloads). Built before the AppImage-updater commit (ee2a847), so it ships
  `updates: false` forever and carries no block map; it also hits the AppArmor userns
  abort below on stock Ubuntu 24.04+. Users can reach it through the site's static
  latest-release fallback link. Delete the asset until a real `linux-scripts/release.sh`
  run publishes a working one.
- **New-agent page swallows the Linux sign-in instruction.**
  `app/src/pages/AgentNewPage.tsx:189-190` treats every 409 from `/agents/login` as
  "already signed in — ready to save". On Linux, `installer.login` raises the "run this
  command in your terminal" instruction for claude/gemini/opencode, which `api.py` turns
  into a 409 — so the user gets a false success toast and never sees the command.
  `Onboarding.tsx:289` already does this right by matching on the "already signed in"
  message text; the page must use the same check.
- **Tray stranding on GNOME without a StatusNotifier host.** `new Tray()` succeeds and
  returns a live object even when no host renders it, so the `main.cjs:1312-1315`
  residency guard (non-null tray keeps the app alive after the last window closes)
  leaves a running process with no window and no visible icon. Needs a real probe or a
  different residency rule.
- **AppImage runtime needs FUSE (`libfuse2`) on some distros** — decide whether the
  download page documents `--appimage-extract-and-run` as the fallback.
- **Ubuntu 24.04+ AppArmor userns restriction**
  (`kernel.apparmor_restrict_unprivileged_userns=1`): unconfined Chromium cannot create
  its namespace sandbox and falls back to the SUID helper, which inside an AppImage can
  never be setuid root — the packaged app aborts exactly like a dev checkout did. Decide
  the packaged answer before the Linux release (ship an AppArmor profile with the app?
  document a one-time sysctl?). The dev loop already heals its own checkout:
  `linux-scripts/dev.sh` fixes `chrome-sandbox` ownership/mode via sudo (§18).
- **`app/src/acknowledgements.md` lost the Linux keyring closure** (cffi, cryptography,
  jeepney, pycparser, SecretStorage) when a macOS regeneration overwrote a Linux one
  (467aa24). `build.sh` regenerates per-build so the AppImage itself is fine, but the
  checked-in file under-reports; regenerate on a Linux build when convenient.
- **Dev-setup notes** (Debian/Ubuntu): `apt install python3.14-venv` (ensurepip is split
  out of the base python package, so `python3.14 -m venv` fails without it). Node lives
  user-local at `~/.local/opt/node-v24.19.0-linux-x64` (symlinked into `~/.local/bin`).
  Audit `scripts/dev.sh`/`build.sh` for GNU-vs-BSD flag drift before first use here.
