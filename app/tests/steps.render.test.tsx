// Component tests for the shared step-list / param-editor module (src/steps.tsx)
// serving both the §11 create/edit flow ('editor' variant) and the §9.2
// automation detail page ('detail' variant): step rows with agent/secret/
// package/timeout tags, the script disclosure, and the five §4.2 param value
// kinds with each variant's cosmetic contract.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Agent, PackageDep, ParamDef, Step } from '../src/types'
import { ParamValueEditor, StepList, stepSecretTags } from '../src/steps'

afterEach(() => cleanup())

const AGENT: Agent = { id: 'g1', name: 'Cloud writer', harness: 'Claude Code', mode: 'default', model: null }
const step = (over: Partial<Step> = {}): Step => ({ name: 'Fetch page', description: 'reads it', code: '', ...over })

describe('StepList (shared)', () => {
  it('detail variant: secret tags from code refs, fallback agent tag, script on expand', () => {
    const steps = [step({ agent: true, code: 'x = secrets.MAIL_PASSWORD\nlog(x)' })]
    render(<StepList variant="detail" steps={steps} fallbackAgent="Cloud writer" />)
    expect(screen.getByText('MAIL_PASSWORD')).toBeTruthy()
    expect(screen.getByText('Cloud writer')).toBeTruthy()
    // gutter number, no dot
    expect(screen.getByText('1')).toBeTruthy()
    // the script renders inside the collapsible body
    fireEvent.click(screen.getByText('Fetch page'))
    expect(screen.getByText(/MAIL_PASSWORD/, { selector: 'pre *, pre' })).toBeTruthy()
  })

  it('editor variant: package tag for imported deps and red no-agent tag when none enabled', () => {
    const packages: PackageDep[] = [{ pip: 'beautifulsoup4', import: 'bs4', why: 'parse pages' }]
    const steps = [step({ agent: true, code: 'import bs4' })]
    render(<StepList variant="editor" steps={steps} availAgents={[]} packages={packages} />)
    // 'bs4' also appears in the (collapsed) script body — assert the tag itself
    // (the tooltip text rides the tag's aria-label — §14 Tag tooltip)
    const pkgTag = screen.getAllByText('bs4').find((el) =>
      el.closest('span')?.getAttribute('aria-label')?.includes('Python package'))
    expect(pkgTag).toBeTruthy()
    expect(screen.getByText('no agent')).toBeTruthy()
    // inline "1." number prefix (editor keeps the left edge free)
    expect(screen.getByText('1.')).toBeTruthy()
  })

  it('editor variant: named agent resolves against the enabled agents', () => {
    const steps = [step({ agent: true, agents: [{ name: 'Cloud writer', why: 'writes prose' }] })]
    render(<StepList variant="editor" steps={steps} availAgents={[AGENT]} packages={[]} />)
    const tag = screen.getByText('Cloud writer')
    expect(tag.closest('span')?.getAttribute('aria-label')).toContain('mid-execution')
  })
})

describe('stepSecretTags', () => {
  it('unions declared entries (with why) and code references', () => {
    const tags = stepSecretTags(step({
      secrets: [{ name: 'CRM_API_KEY', why: 'auth' }],
      code: 'a = secrets.CRM_API_KEY\nb = secrets.MAIL_PASSWORD',
    }))
    expect(tags).toEqual([{ name: 'CRM_API_KEY', why: 'auth' }, { name: 'MAIL_PASSWORD' }])
  })
})

describe('ParamValueEditor (shared)', () => {
  const listParam: ParamDef = { name: 'urls', kind: 'list', label: 'URLs', help: '' }
  const noop = {
    setOn: () => {}, setLines: () => {}, setRows: () => {}, setText: () => {}, setNumber: () => {},
  }

  it('detail list: always shows the count footer and commits removals at once', () => {
    const setLines = vi.fn()
    render(
      <ParamValueEditor
        variant="detail" p={listParam} on={false} lines={['a', 'b']} rows={[]} value=""
        {...noop} setLines={setLines}
      />,
    )
    expect(screen.getByText('2 entries')).toBeTruthy()
    const removeBtns = document.querySelectorAll('button.ad-btn-x')
    fireEvent.click(removeBtns[0])
    expect(setLines).toHaveBeenCalledWith(['b'], true) // removal → commit now
    fireEvent.click(screen.getByText('+ Add line'))
    expect(setLines).toHaveBeenCalledWith(['a', 'b', ''])
  })

  it('draft list: footer only with validate, invalid rows badge NOT A VALID LINK', () => {
    const { rerender } = render(
      <ParamValueEditor variant="draft" p={listParam} on={false} lines={['a']} rows={[]} value="" {...noop} />,
    )
    expect(screen.queryByText(/valid links/)).toBeNull()
    rerender(
      <ParamValueEditor
        variant="draft" p={{ ...listParam, validate: true }} on={false}
        lines={['https://ok.example', 'nope']} rows={[]} value="" {...noop}
      />,
    )
    expect(screen.getByText('2 lines · 1 valid links · 1 needs attention')).toBeTruthy()
    expect(screen.getByText('NOT A VALID LINK')).toBeTruthy()
  })

  it('kv: draft shows Key/Value placeholders and "+ Add pair", detail shows "+ Add row"', () => {
    const kv: ParamDef = { name: 'h', kind: 'kv', label: 'Headers', help: '' }
    const { rerender } = render(
      <ParamValueEditor variant="draft" p={kv} on={false} lines={[]} rows={[{ key: 'a', value: 'b' }]} value="" {...noop} />,
    )
    expect(screen.getByPlaceholderText('Key')).toBeTruthy()
    expect(screen.getByText('+ Add pair')).toBeTruthy()
    rerender(
      <ParamValueEditor variant="detail" p={kv} on={false} lines={[]} rows={[{ key: 'a', value: 'b' }]} value="" {...noop} />,
    )
    expect(screen.queryByPlaceholderText('Key')).toBeNull()
    expect(screen.getByText('+ Add row')).toBeTruthy()
  })

  it('number: strips non-digits through setNumber; detail variant is inputMode=numeric', () => {
    const num: ParamDef = { name: 'n', kind: 'number', label: 'Count', help: '', min: 1 }
    const setNumber = vi.fn()
    render(
      <ParamValueEditor variant="detail" p={num} on={false} lines={[]} rows={[]} value="5" {...noop} setNumber={setNumber} />,
    )
    const input = document.querySelector('input.ad-input') as HTMLInputElement
    expect(input.getAttribute('inputmode')).toBe('numeric')
    fireEvent.change(input, { target: { value: '1a2' } })
    expect(setNumber).toHaveBeenCalledWith('12')
  })

  it('toggle and text render their controls', () => {
    const setOn = vi.fn()
    const { rerender } = render(
      <ParamValueEditor
        variant="detail" p={{ name: 't', kind: 'toggle', label: 'On', help: '' }}
        on={true} lines={[]} rows={[]} value="" {...noop} setOn={setOn}
      />,
    )
    const setText = vi.fn()
    rerender(
      <ParamValueEditor
        variant="draft" p={{ name: 's', kind: 'text', label: 'Query', help: '', placeholder: 'type here' }}
        on={false} lines={[]} rows={[]} value="hi" {...noop} setText={setText}
      />,
    )
    const input = screen.getByPlaceholderText('type here') as HTMLInputElement
    expect(input.value).toBe('hi')
    fireEvent.change(input, { target: { value: 'hello' } })
    expect(setText).toHaveBeenCalledWith('hello')
  })
})
