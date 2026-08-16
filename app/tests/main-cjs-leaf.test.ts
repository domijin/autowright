// §2 CLI-leaf invariant guard over electron/main.cjs (spec §15). The app
// registers the backend via `python -m autowright.service` and must never
// execute the CLI; §3 shim writes only ever target the user-local location —
// no admin prompt exists, and nothing ever writes to the legacy
// /usr/local/bin (the pre-08-15 bug was a silent best-effort write there).
// main.cjs has no importable module structure, so the guard reads the source.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf-8')

describe('main.cjs CLI-leaf invariant (§2)', () => {
  it('registers the backend via -m autowright.service', () => {
    expect(src).toContain("'-m', 'autowright.service', 'install'")
  })

  it('quit-all stops the backend via -m autowright.service stop', () => {
    expect(src).toContain("'-m', 'autowright.service', 'stop'")
  })

  it('never executes the CLI — autowright.cli appears only inside the shim file text', () => {
    const hits = src.match(/autowright\.cli/g) ?? []
    expect(hits).toHaveLength(1)
    // The one mention is the shim file's contents (an exec line in shimText),
    // not a child-process invocation by the app.
    const line = src.split('\n').find((l) => l.includes('autowright.cli'))
    expect(line).toContain('exec "${python}" -m autowright.cli')
    expect(line).not.toMatch(/execFile|spawn/)
  })

  it('spawns only launchctl, the login shell, and the backend python', () => {
    // Every child-process call site: execFile('launchctl'|shell|py, …).
    // `shell` is the §3 login-shell PATH probe (printf $PATH, nothing else).
    // `spawn` is not used at all (the word may appear in comments only).
    const calls = [...src.matchAll(/(?<![.\w])(?:execFile|spawn|exec)\(\s*([^,)]+)/g)].map((m) => m[1].trim())
    for (const first of calls) {
      expect(["'launchctl'", 'shell', 'py']).toContain(first)
    }
    expect(calls.length).toBeGreaterThanOrEqual(3)
    // …and every python call site runs the service module, nothing else.
    const pyCalls = [...src.matchAll(/execFile\(\s*py\s*,\s*\[([^\]]*)\]/g)].map((m) => m[1])
    expect(pyCalls.length).toBeGreaterThanOrEqual(1)
    for (const args of pyCalls) {
      expect(args).toContain("'-m', 'autowright.service'")
    }
  })

  it('shim writes are user-local only — no admin prompt, no /usr/local/bin write (§3)', () => {
    // No osascript admin flow exists at all.
    expect(src).not.toContain('with administrator privileges')
    expect(src).not.toContain("'osascript'")
    // The silent-failure regression: no direct write targeting the legacy
    // shim location — cli-install writes shimPaths()[0] (user-local), and
    // the heal only rewrites an already-ours file.
    expect(src).not.toMatch(/writeFileSync\(\s*'\/usr\/local\/bin/)
    expect(src).not.toMatch(/writeFileSync\(\s*SYSTEM_SHIM/)
    expect(src).toMatch(/writeFileSync\(shim, shimText\(python\)/)
  })

  it('no auto-install: cli-install is reachable only via its IPC handler (§3)', () => {
    // Exactly two mentions of cliInstall: the definition and the IPC handler.
    const hits = src.match(/cliInstall(?!l)/g) ?? []
    expect(hits).toHaveLength(2)
    expect(src).toContain("ipcMain.handle('cli-install', () => cliInstall())")
  })

  it('cli-uninstall deletes only marker-carrying shims, via its IPC handler (§3)', () => {
    expect(src).toContain("ipcMain.handle('cli-uninstall', () => cliUninstall())")
    // The marker gate sits before the unlink — foreign files are never touched.
    expect(src).toMatch(/if \(!text\.includes\(SHIM_MARKER\)\) continue[\s\S]{0,120}unlinkSync/)
  })
})
