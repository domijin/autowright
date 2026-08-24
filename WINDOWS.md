# Windows port worksheet

Temporary working notes (SPEC §17). The port itself shipped into the spec (§2 platform
layer, §3 Task Scheduler service / NSIS packaging / toast notifier, §9 per-OS copy
table); this file was recreated on 2026-08-22 to hold the Windows-specific findings from
the pre-release audit, parked until Windows becomes active work. None block the macOS
release. Each item moves into the §-sections as it ships; delete the file when empty.

## Deferred from the 2026-08-22 pre-release audit

- **Shipped 0.5.0 exe is cut off from updates.** It has the old
  `https://autowright.ai/updates/win32-x86_64/` feed URL baked in, which 404s since the
  feeds moved to GitHub raw (0c4e6f5). Whatever remedy the macOS side settles on (clean
  break vs restored legacy feed) applies here at the next Windows release; also decide
  whether the site's "Windows support is planned" copy and the downloadable exe on the
  release page should coexist until then.
- **`window-all-closed` never fires once the tray panel has been opened** (shared with
  Linux). The panel (`app/electron/main.cjs:530-556`) is a `closable: false`
  BrowserWindow that is only ever hidden, never closed or destroyed, so Electron's
  all-closed event is unreachable afterward. Scenario: open the tray panel once, later
  disable `menuBarIcon` in Settings, close the main window - resident invisible process
  with no quit path. Fix the panel teardown or the residency rule.
- **Verify `appMenu: true`.** `spec/ui-shell.md:29-30` claims `titleBarStyle: 'hidden'`
  never draws the stock menu bar on Windows and `win32.cjs:151` relies on it. If a real
  Windows build does draw it, ship the same one-line `appMenu: false` Linux got
  (Ctrl+C/V/X/A stay Blink-native).
- **Service-manager timeout multiplication twin.** `platform/windows.py`
  `_await_running` polls 20 x with each PowerShell probe blocking up to 30 s (worst case
  ~10 min). Apply the same wall-clock-deadline fix the macOS `service.py` gets.
- **`shim_text()` uses `sys.executable`** (`platform/windows.py:520-525`) while
  `backend.json` publishes `paths.console_python()`. They agree today because the shell
  always runs `service install` under `python.exe`, but a heal invoked from a
  `pythonw`-hosted process would write a shim with no console. Use `console_python()`
  there (or add the constraint as a comment).
- **`skills/autowright/SKILL.md:43-50` hardcodes the POSIX PATH help**
  (`~/.local/bin`, the zsh `~/.zprofile` one-liner) - wrong on Windows; needs per-OS
  wording before the skill is advertised to Windows users.
- **NSIS-specific updater behavior has zero test coverage on macOS hosts.** Since the
  0.6.1 mac migration the electron-updater describe in `app/tests/main-cjs-leaf.test.ts`
  runs on every OS (darwin uses MacUpdater), so the shared handler logic is covered on
  mac hosts - but NsisUpdater-specific behavior (installer swap, differential/blockmap)
  still is not. Run the renderer suite (and e2e) on a real Windows host before the next
  Windows release.
- **`windows-scripts/release.ps1` hygiene:** stale "GitHub Pages" comment (feeds moved
  to raw in 0c4e6f5), and no current-branch guard while the feed URLs hardcode `/main/`.
- **`PRIVACY.md` hardcodes macOS copy** and is rendered verbatim in-app; needs a per-OS
  seam before any Windows release (shared with Linux - see LINUX.md).
