// Component tests for the shared step-list / param-editor module (src/steps.tsx)
// serving both the §11 create/edit flow ('editor' variant) and the §9.2
// automation detail page ('detail' variant): step rows with agent/secret/
// package/timeout tags, the script disclosure, and the five §4.2 param value
// kinds with each variant's cosmetic contract.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Agent, PackageDep, ParamDef, SecretMeta, Step, UnresolvedRefs } from '../src/types'
import { ParamValueEditor, StepList, stepPackageTags, stepSecretTags } from '../src/steps'

afterEach(() => cleanup())

const AGENT: Agent = { id: 'g1', name: 'Cloud writer', harness: 'Claude Code', mode: 'default', model: null }
// §4.8 fixture secrets — step entries and code subscripts reference these ids
const MAIL_ID = '11111111-1111-1111-1111-111111111111'
const CRM_ID = '22222222-2222-2222-2222-222222222222'
const GONE_ID = '99999999-9999-4999-8999-999999999999'
const SECRETS: SecretMeta[] = [
  { id: MAIL_ID, name: 'MAIL_PASSWORD', description: '', set: true, usedBy: [] },
  { id: CRM_ID, name: 'CRM_API_KEY', description: '', set: true, usedBy: [] },
]
// §4.1/§5.1 imported placeholders: ids the archive's references were minted
// as, carried by the automation's unresolvedReferences map because nothing on
// this Mac matched them.
const IMP_SECRET_ID = '33333333-3333-4333-8333-333333333333'
const IMP_AGENT_ID = '44444444-4444-4444-8444-444444444444'
const UNRESOLVED: UnresolvedRefs = {
  [IMP_SECRET_ID]: { kind: 'secret', name: 'STRIPE_KEY', description: 'billing token' },
  [IMP_AGENT_ID]: { kind: 'agent', name: 'Researcher', description: 'reads the web' },
}
const step = (over: Partial<Step> = {}): Step => ({ name: 'Fetch page', description: 'reads it', code: '', ...over })

describe('StepList (shared)', () => {
  it('detail variant: secret tags from code refs resolve to live names, fallback agent tag, script on expand', () => {
    const steps = [step({ agent: true, code: `x = secrets["${MAIL_ID}"]  # MAIL_PASSWORD\nlog(x)` })]
    render(<StepList variant="detail" steps={steps} agents={[AGENT]} secrets={SECRETS} fallbackAgent="Cloud writer" />)
    expect(screen.getByText('MAIL_PASSWORD')).toBeTruthy()
    expect(screen.getByText('Cloud writer')).toBeTruthy()
    // gutter number, no dot
    expect(screen.getByText('1')).toBeTruthy()
    // the script renders inside the collapsible body
    fireEvent.click(screen.getByText('Fetch page'))
    expect(screen.getByText(new RegExp(MAIL_ID), { selector: 'pre *, pre' })).toBeTruthy()
  })

  it('detail variant: a dangling secret or agent id renders the red deleted state', () => {
    const steps = [step({
      agent: true,
      agents: [{ id: GONE_ID }],
      code: `x = secrets["${GONE_ID}"]`,
    })]
    render(<StepList variant="detail" steps={steps} agents={[AGENT]} secrets={SECRETS} fallbackAgent="Cloud writer" />)
    const tags = screen.getAllByText('99999999…')
    expect(tags.length).toBe(2) // one agent tag, one secret tag
    const labels = tags.map((el) => el.closest('span')?.getAttribute('aria-label'))
    expect(labels).toContain('This step calls an agent that no longer exists — this step would fail')
    expect(labels).toContain('This step uses a secret that no longer exists — this step would fail')
  })

  it('detail variant: an unresolved imported id shows the archive name and the imported tooltip', () => {
    const steps = [step({
      agent: true,
      agents: [{ id: IMP_AGENT_ID }],
      code: `x = secrets["${IMP_SECRET_ID}"]`,
    })]
    render(
      <StepList
        variant="detail" steps={steps} agents={[AGENT]} secrets={SECRETS}
        unresolvedReferences={UNRESOLVED} fallbackAgent="Cloud writer"
      />,
    )
    // the red tags read as the archive's names, never the short id
    expect(screen.queryByText('33333333…')).toBeNull()
    expect(screen.queryByText('44444444…')).toBeNull()
    expect(screen.getByText('Researcher').closest('span')?.getAttribute('aria-label'))
      .toBe('This step calls Researcher from the imported file. '
        + 'No agent on this Mac matched it, so this step would fail.')
    expect(screen.getByText('STRIPE_KEY').closest('span')?.getAttribute('aria-label'))
      .toBe('This step uses STRIPE_KEY from the imported file. '
        + 'No secret on this Mac matched it, so this step would fail.')
  })

  it('detail variant: a dangling id outside the map keeps the short-id deleted state', () => {
    const steps = [step({
      agent: true,
      agents: [{ id: GONE_ID }, { id: IMP_AGENT_ID }],
      code: `a = secrets["${GONE_ID}"]\nb = secrets["${IMP_SECRET_ID}"]`,
    })]
    render(
      <StepList
        variant="detail" steps={steps} agents={[AGENT]} secrets={SECRETS}
        unresolvedReferences={UNRESOLVED} fallbackAgent="Cloud writer"
      />,
    )
    const labels = screen.getAllByText('99999999…').map((el) => el.closest('span')?.getAttribute('aria-label'))
    expect(labels).toContain('This step calls an agent that no longer exists — this step would fail')
    expect(labels).toContain('This step uses a secret that no longer exists — this step would fail')
    // the imported pair beside them still reads as the archive names
    expect(screen.getByText('Researcher')).toBeTruthy()
    expect(screen.getByText('STRIPE_KEY')).toBeTruthy()
  })

  it('editor variant: an unresolved imported id shows the archive name and the imported tooltip', () => {
    const steps = [step({
      agent: true,
      agents: [{ id: IMP_AGENT_ID }, { id: GONE_ID }],
      code: `a = secrets["${IMP_SECRET_ID}"]\nb = secrets["${GONE_ID}"]`,
    })]
    render(
      <StepList
        variant="editor" steps={steps} availAgents={[AGENT]} allAgents={[AGENT]}
        secrets={SECRETS} unresolvedReferences={UNRESOLVED} packages={[]}
      />,
    )
    expect(screen.getByText('Researcher').closest('span')?.getAttribute('aria-label'))
      .toBe('This step calls Researcher from the imported file. '
        + 'No agent on this Mac matched it, so this step would fail.')
    expect(screen.getByText('STRIPE_KEY').closest('span')?.getAttribute('aria-label'))
      .toBe('This step uses STRIPE_KEY from the imported file. '
        + 'No secret on this Mac matched it, so this step would fail.')
    // an id the map doesn't carry keeps the plain deleted wording
    const labels = screen.getAllByText('99999999…').map((el) => el.closest('span')?.getAttribute('aria-label'))
    expect(labels).toContain('This step calls an agent that no longer exists — this step would fail')
    expect(labels).toContain('This step uses a secret that no longer exists — this step would fail')
  })

  it('editor variant: package tag for imported deps and red no-agent tag when none enabled', () => {
    const packages: PackageDep[] = [{ pip: 'beautifulsoup4', import: 'bs4', why: 'parse pages' }]
    const steps = [step({ agent: true, code: 'import bs4' })]
    render(<StepList variant="editor" steps={steps} availAgents={[]} allAgents={[]} secrets={[]} packages={packages} />)
    // 'bs4' also appears in the (collapsed) script body — assert the tag itself
    // (the tooltip text rides the tag's aria-label — §14 Tag tooltip)
    const pkgTag = screen.getAllByText('bs4').find((el) =>
      el.closest('span')?.getAttribute('aria-label')?.includes('Python package'))
    expect(pkgTag).toBeTruthy()
    // no per-step entry → the tooltip falls back to the declaration's why
    expect(pkgTag!.closest('span')?.getAttribute('aria-label')).toContain('— parse pages')
    expect(screen.getByText('no agent')).toBeTruthy()
    // inline "1." number prefix (editor keeps the left edge free)
    expect(screen.getByText('1.')).toBeTruthy()
  })

  it('editor variant: a declared per-step package why wins the tooltip', () => {
    const packages: PackageDep[] = [{ pip: 'pandas', import: 'pandas', why: 'data wrangling', version: '2.2' }]
    const steps = [step({ code: 'import pandas', packages: [{ import: 'pandas', why: 'parses the price tables' }] })]
    render(<StepList variant="editor" steps={steps} availAgents={[]} allAgents={[]} secrets={[]} packages={packages} />)
    const pkgTag = screen.getAllByText('pandas').find((el) =>
      el.closest('span')?.getAttribute('aria-label')?.includes('Python package'))
    expect(pkgTag!.closest('span')?.getAttribute('aria-label'))
      .toBe('This step uses the pandas Python package, version 2.2 — parses the price tables')
  })

  it('editor variant: agent entry ids resolve to the live agent', () => {
    const steps = [step({ agent: true, agents: [{ id: 'g1', why: 'writes prose' }] })]
    render(<StepList variant="editor" steps={steps} availAgents={[AGENT]} allAgents={[AGENT]} secrets={[]} packages={[]} />)
    const tag = screen.getByText('Cloud writer')
    expect(tag.closest('span')?.getAttribute('aria-label')).toContain('mid-execution — writes prose')
  })

  it('editor variant: an existing-but-disabled agent id warns red with the live name', () => {
    const steps = [step({ agent: true, agents: [{ id: 'g1' }] })]
    render(<StepList variant="editor" steps={steps} availAgents={[]} allAgents={[AGENT]} secrets={[]} packages={[]} />)
    const tag = screen.getByText('Cloud writer')
    expect(tag.closest('span')?.getAttribute('aria-label'))
      .toBe('Cloud writer isn’t enabled for steps — this step would fail')
  })

  it('editor variant: a deleted agent id renders the red deleted state', () => {
    const steps = [step({ agent: true, agents: [{ id: GONE_ID }] })]
    render(<StepList variant="editor" steps={steps} availAgents={[AGENT]} allAgents={[AGENT]} secrets={[]} packages={[]} />)
    const tag = screen.getByText('99999999…')
    expect(tag.closest('span')?.getAttribute('aria-label'))
      .toBe('This step calls an agent that no longer exists — this step would fail')
  })

  it('editor variant: an agent entry without a why falls back to the step why', () => {
    const steps = [step({ agent: true, why: 'needs judgment on titles', agents: [{ id: 'g1' }] })]
    render(<StepList variant="editor" steps={steps} availAgents={[AGENT]} allAgents={[AGENT]} secrets={[]} packages={[]} />)
    const tag = screen.getByText('Cloud writer')
    expect(tag.closest('span')?.getAttribute('aria-label'))
      .toContain('mid-execution — needs judgment on titles')
  })

  it('editor variant: the empty-list fallback agent tag carries the step why', () => {
    const steps = [step({ agent: true, why: 'summarizes the page' })]
    render(<StepList variant="editor" steps={steps} availAgents={[AGENT]} allAgents={[AGENT]} secrets={[]} packages={[]} />)
    const tag = screen.getByText('Cloud writer')
    expect(tag.closest('span')?.getAttribute('aria-label')).toContain('— summarizes the page')
  })

  it('secret tag tooltip: what + why when declared, what alone for code refs', () => {
    const steps = [step({
      secrets: [{ id: CRM_ID, why: 'authenticates the CRM fetch' }],
      code: `a = secrets["${CRM_ID}"]\nb = secrets["${MAIL_ID}"]`,
    })]
    render(<StepList variant="editor" steps={steps} availAgents={[]} allAgents={[]} secrets={SECRETS} packages={[]} />)
    expect(screen.getByText('CRM_API_KEY').closest('span')?.getAttribute('aria-label'))
      .toBe('This step uses the CRM_API_KEY secret from your Keychain — authenticates the CRM fetch')
    expect(screen.getByText('MAIL_PASSWORD').closest('span')?.getAttribute('aria-label'))
      .toBe('This step uses the MAIL_PASSWORD secret from your Keychain')
  })

  it('package tag tooltip: no why at all drops the why clause', () => {
    const packages: PackageDep[] = [{ pip: 'requests', import: 'requests', why: '' }]
    const steps = [step({ code: 'import requests' })]
    render(<StepList variant="editor" steps={steps} availAgents={[]} allAgents={[]} secrets={[]} packages={packages} />)
    const pkgTag = screen.getAllByText('requests').find((el) =>
      el.closest('span')?.getAttribute('aria-label')?.includes('Python package'))
    expect(pkgTag!.closest('span')?.getAttribute('aria-label'))
      .toBe('This step uses the requests Python package')
  })

  it('detail variant: agent tag tooltip reads what + why', () => {
    const steps = [step({ agent: true, why: 'writes the final summary' })]
    render(<StepList variant="detail" steps={steps} agents={[AGENT]} secrets={[]} fallbackAgent="Cloud writer" />)
    const tag = screen.getByText('Cloud writer')
    expect(tag.closest('span')?.getAttribute('aria-label'))
      .toBe('This step calls the Cloud writer AI agent — writes the final summary')
  })
})

describe('stepSecretTags', () => {
  it('unions declared entries (with why) and code references, resolving live names', () => {
    const tags = stepSecretTags(step({
      secrets: [{ id: CRM_ID, why: 'auth' }],
      code: `a = secrets["${CRM_ID}"]\nb = secrets["${MAIL_ID}"]`,
    }), SECRETS)
    expect(tags).toEqual([
      { id: CRM_ID, name: 'CRM_API_KEY', missing: false, why: 'auth' },
      { id: MAIL_ID, name: 'MAIL_PASSWORD', missing: false },
    ])
  })

  it('a dangling id keeps its short prefix and missing flag', () => {
    const tags = stepSecretTags(step({ code: `a = secrets["${GONE_ID}"]` }), SECRETS)
    expect(tags).toEqual([{ id: GONE_ID, name: '99999999…', missing: true }])
  })

  it('§5.1: an unresolved imported id takes the archive name and the imported flag', () => {
    const tags = stepSecretTags(
      step({ code: `a = secrets["${IMP_SECRET_ID}"]\nb = secrets["${GONE_ID}"]` }),
      SECRETS, UNRESOLVED,
    )
    expect(tags).toEqual([
      { id: IMP_SECRET_ID, name: 'STRIPE_KEY', missing: true, imported: true },
      { id: GONE_ID, name: '99999999…', missing: true },
    ])
  })

  it('§5.1: an agent entry in the map never resolves a secret tag', () => {
    const tags = stepSecretTags(step({ code: `a = secrets["${IMP_AGENT_ID}"]` }), SECRETS, UNRESOLVED)
    expect(tags).toEqual([{ id: IMP_AGENT_ID, name: '44444444…', missing: true }])
  })
})

describe('stepPackageTags', () => {
  const deps: PackageDep[] = [
    { pip: 'pandas', import: 'pandas', why: 'general data work', version: '2.2' },
    { pip: 'beautifulsoup4', import: 'bs4', why: 'parse pages' },
  ]
  it('unions declared entries (per-step why) with code-matched declared imports', () => {
    const tags = stepPackageTags(step({
      packages: [{ import: 'pandas', why: 'parses the price tables' }],
      code: 'import bs4',
    }), deps)
    expect(tags).toEqual([
      { import: 'pandas', why: 'parses the price tables', version: '2.2' },
      { import: 'bs4', why: 'parse pages', version: undefined },
    ])
  })
  it('a declared entry with an empty why falls back to the declaration general why', () => {
    const tags = stepPackageTags(step({ packages: [{ import: 'pandas', why: '' }] }), deps)
    expect(tags).toEqual([{ import: 'pandas', why: 'general data work', version: '2.2' }])
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

  it('list: editing a line patches it in place without committing', () => {
    const setLines = vi.fn()
    render(
      <ParamValueEditor
        variant="draft" p={listParam} on={false} lines={['a', 'b']} rows={[]} value=""
        {...noop} setLines={setLines}
      />,
    )
    const inputs = document.querySelectorAll('input.ad-input')
    fireEvent.change(inputs[1], { target: { value: 'B' } })
    expect(setLines).toHaveBeenCalledWith(['a', 'B'])   // edit → no commit flag
  })

  it('kv: edits patch the one row, removal commits at once, add appends a blank pair', () => {
    const setRows = vi.fn()
    const kv: ParamDef = { name: 'h', kind: 'kv', label: 'Headers', help: '' }
    const rows = [{ key: 'a', value: '1' }, { key: 'b', value: '2' }]
    render(
      <ParamValueEditor variant="draft" p={kv} on={false} lines={[]} rows={rows} value="" {...noop} setRows={setRows} />,
    )
    fireEvent.change(screen.getAllByPlaceholderText('Key')[0], { target: { value: 'A' } })
    expect(setRows).toHaveBeenCalledWith([{ key: 'A', value: '1' }, { key: 'b', value: '2' }])
    fireEvent.change(screen.getAllByPlaceholderText('Value')[1], { target: { value: '9' } })
    expect(setRows).toHaveBeenCalledWith([{ key: 'a', value: '1' }, { key: 'b', value: '9' }])
    fireEvent.click(screen.getByLabelText('Remove a'))  // named row → labeled remove button
    expect(setRows).toHaveBeenCalledWith([{ key: 'b', value: '2' }], true) // removal → commit now
    fireEvent.click(screen.getByText('+ Add pair'))
    expect(setRows).toHaveBeenCalledWith([...rows, { key: '', value: '' }])
  })

  it('kv: a blank key falls back to the generic remove label', () => {
    const kv: ParamDef = { name: 'h', kind: 'kv', label: 'Headers', help: '' }
    render(
      <ParamValueEditor variant="detail" p={kv} on={false} lines={[]} rows={[{ key: ' ', value: '' }]} value="" {...noop} />,
    )
    expect(screen.getByLabelText('Remove row')).toBeTruthy()
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
