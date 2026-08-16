// §2 CLI-leaf invariant guard over electron/main.cjs (spec §15). The app
// registers the backend via `python -m autowright.service` and must never
// execute the CLI; the shim install goes through the §3 one-time admin prompt
// (chown-to-user so later heals are sudo-free) — never a silent best-effort
// write into the root-owned /usr/local/bin (the pre-08-15 bug).
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

  it('spawns only launchctl, osascript, and the backend python', () => {
    // Every child-process call site: execFile('launchctl'|'osascript'|py, …).
    // `spawn` is not used at all (the word may appear in comments only).
    const calls = [...src.matchAll(/(?<![.\w])(?:execFile|spawn|exec)\(\s*([^,)]+)/g)].map((m) => m[1].trim())
    for (const first of calls) {
      expect(["'launchctl'", "'osascript'", 'py']).toContain(first)
    }
    expect(calls.length).toBeGreaterThanOrEqual(3)
    // …and every python call site runs the service module, nothing else.
    const pyCalls = [...src.matchAll(/execFile\(\s*py\s*,\s*\[([^\]]*)\]/g)].map((m) => m[1])
    expect(pyCalls.length).toBeGreaterThanOrEqual(1)
    for (const args of pyCalls) {
      expect(args).toContain("'-m', 'autowright.service'")
    }
  })

  it('shim install is the admin-prompt flow with chown-to-user, no silent write', () => {
    expect(src).toContain('with administrator privileges')
    expect(src).toMatch(/chown \$\{process\.getuid\(\)\}/)
    // The silent-failure regression: no direct write targeting the default
    // shim location outside the osascript flow — writes go to the temp file
    // or through shimPath() heal of an already-ours file.
    expect(src).not.toMatch(/writeFileSync\(\s*'\/usr\/local\/bin/)
  })
})
