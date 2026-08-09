// Unit tests for the exported pure helpers in src/pages/CreateFlow.tsx.
// The module graph pulls in store/api/ui/result — api is mocked so importing
// never opens sockets or fetches.
import { describe, expect, it, vi } from 'vitest'
import type { Blocker, ChatEntry, DraftTrigger, ParamDef, SpecBlock, Step } from '../src/types'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => false),
  openWs: vi.fn(() => () => {}),
  api: {},
}))

import {
  specToText, textToSpec, amendSpec, stepSecretNames, stepSecretTags, secretRefsOf,
  instrToMd, mergeDraftTriggers, persistChat, applyTestValues,
} from '../src/pages/CreateFlow'

const step = (over: Partial<Step> = {}): Step =>
  ({ name: 's', description: '', code: '', ...over })

describe('specToText / textToSpec', () => {
  const blocks: SpecBlock[] = [
    { kind: 'h1', text: 'Title' },
    { kind: 'h2', text: 'Section' },
    { kind: 'li', text: 'item' },
    { kind: 'p', text: 'paragraph' },
  ]

  it('serializes with "# ", "## ", "- " prefixes and plain paragraphs', () => {
    expect(specToText(blocks)).toBe('# Title\n## Section\n- item\nparagraph')
  })
  it('round-trips stably', () => {
    expect(textToSpec(specToText(blocks))).toEqual(blocks)
  })
  it('drops blank lines and trims', () => {
    expect(textToSpec('a\n\n   \nb')).toEqual([
      { kind: 'p', text: 'a' }, { kind: 'p', text: 'b' },
    ])
  })
  it('"## " beats "# "; a hash without a space is a paragraph', () => {
    expect(textToSpec('## X')).toEqual([{ kind: 'h2', text: 'X' }])
    expect(textToSpec('# X')).toEqual([{ kind: 'h1', text: 'X' }])
    expect(textToSpec('- X')).toEqual([{ kind: 'li', text: 'X' }])
    expect(textToSpec('#X')).toEqual([{ kind: 'p', text: '#X' }])
  })
})

describe('stepSecretNames', () => {
  it('unions declared secrets with secrets.NAME code refs, deduped', () => {
    const s = step({
      secrets: [{ name: 'ALPHA', why: 'signs the request' }],
      code: 'x = secrets.BETA + secrets.ALPHA\ny = secrets.BETA',
    })
    expect(stepSecretNames(s)).toEqual(['ALPHA', 'BETA'])
  })
  it('stepSecretTags keeps the declared why; code-referenced names carry none', () => {
    const s = step({
      secrets: [{ name: 'ALPHA', why: 'signs the request' }],
      code: 'x = secrets.BETA',
    })
    expect(stepSecretTags(s)).toEqual([
      { name: 'ALPHA', why: 'signs the request' },
      { name: 'BETA' },
    ])
  })
  it('lowercase secrets.foo is NOT matched', () => {
    expect(stepSecretNames(step({ code: 'y = secrets.foo' }))).toEqual([])
  })
  it('empty step → empty list', () => {
    expect(stepSecretNames(step())).toEqual([])
  })
})

describe('secretRefsOf', () => {
  it('aggregates name → step indices', () => {
    const steps = [
      step({ code: 'a = secrets.API_KEY' }),
      step({ code: 'b = secrets.API_KEY + secrets.DB_PASS' }),
      step({ code: 'plain' }),
    ]
    expect(secretRefsOf(steps)).toEqual([
      { name: 'API_KEY', steps: [0, 1] },
      { name: 'DB_PASS', steps: [1] },
    ])
  })
})

describe('instrToMd', () => {
  it('bare prose lines become bullets; block syntax stays untouched', () => {
    const input = [
      'Rule one',
      '- already bullet',
      '* star bullet',
      '# heading',
      '1. ordered',
      '| a | b |',
      '',
      'Rule two',
    ].join('\n')
    expect(instrToMd(input)).toBe([
      '- Rule one',
      '- already bullet',
      '* star bullet',
      '# heading',
      '1. ordered',
      '| a | b |',
      '',
      '- Rule two',
    ].join('\n'))
  })
  it('a 4-hash heading is not block syntax — it gets bulleted', () => {
    // Intentional pinning: the regex allows #{1,3} only, so "#### x" reads as
    // bare prose and becomes a bullet. The spec's headings stop at h3.
    expect(instrToMd('#### x')).toBe('- #### x')
    expect(instrToMd('### x')).toBe('### x')
  })
  it('fenced code passes through untouched (fence state tracked)', () => {
    const input = [
      'Before fence',
      '```py',
      'plain code line',
      '```',
      'after fence',
    ].join('\n')
    expect(instrToMd(input)).toBe([
      '- Before fence',
      '```py',
      'plain code line',
      '```',
      '- after fence',
    ].join('\n'))
  })
})

describe('amendSpec', () => {
  const blockers: Blocker[] = [
    { reason: ' Site needs login ', fix: ' Use the saved cookie ' },
    { reason: 'Rate limited', fix: 'Retry with backoff' },
  ]
  const lines: SpecBlock[] = [
    { kind: 'li', text: 'Site needs login — Use the saved cookie' },
    { kind: 'li', text: 'Rate limited — Retry with backoff' },
  ]

  it('appends the section when missing', () => {
    const spec: SpecBlock[] = [{ kind: 'h1', text: 'T' }, { kind: 'p', text: 'body' }]
    expect(amendSpec(spec, blockers)).toEqual([
      ...spec,
      { kind: 'h2', text: 'Constraints & resolutions' },
      ...lines,
    ])
  })
  it('inserts at the end of an existing mid-document section, before the next heading', () => {
    const spec: SpecBlock[] = [
      { kind: 'h1', text: 'T' },
      { kind: 'h2', text: 'constraints & RESOLUTIONS' }, // case-insensitive match
      { kind: 'li', text: 'old — resolution' },
      { kind: 'h2', text: 'Next section' },
      { kind: 'p', text: 'tail' },
    ]
    expect(amendSpec(spec, blockers)).toEqual([
      spec[0], spec[1], spec[2],
      ...lines,
      spec[3], spec[4],
    ])
  })
  it('section at the end of the document gets the lines appended', () => {
    const spec: SpecBlock[] = [
      { kind: 'h1', text: 'T' },
      { kind: 'h2', text: 'Constraints & resolutions' },
      { kind: 'li', text: 'old — resolution' },
    ]
    expect(amendSpec(spec, blockers)).toEqual([...spec, ...lines])
  })
})

describe('mergeDraftTriggers', () => {
  const cron = (over: Partial<DraftTrigger>): DraftTrigger =>
    ({ kind: 'cron', enabled: true, ...over })

  it('drafted cron matching an existing expression+timezone keeps the existing entry (id and enabled)', () => {
    const cur: DraftTrigger[] = [
      cron({ id: 'c1', expression: '0 8 * * *', timezone: 'UTC', enabled: false }),
      { id: 't1', kind: 'time', enabled: true, at: '2026-01-01T00:00' },
    ]
    const drafted: DraftTrigger[] = [cron({ expression: '0 8 * * *', timezone: 'UTC' })]
    expect(mergeDraftTriggers(cur, drafted)).toEqual([
      cur[0],       // id c1 and enabled:false preserved
      cur[1],       // non-cron passes through unchanged
    ])
  })

  it('timezone must match too — undefined timezone equals absent, not a different zone', () => {
    const cur: DraftTrigger[] = [cron({ id: 'c1', expression: '0 8 * * *', timezone: 'UTC' })]
    const merged = mergeDraftTriggers(cur, [cron({ expression: '0 8 * * *' })]) // no timezone → no match
    expect(merged).toEqual([{ kind: 'cron', enabled: true, expression: '0 8 * * *' }])
  })

  it('duplicate identical exprs consume distinct existing entries once each', () => {
    const cur: DraftTrigger[] = [
      cron({ id: 'c1', expression: '0 8 * * *', enabled: false }),
      cron({ id: 'c2', expression: '0 8 * * *', enabled: true }),
    ]
    const drafted: DraftTrigger[] = [
      cron({ expression: '0 8 * * *' }),
      cron({ expression: '0 8 * * *' }),
    ]
    const merged = mergeDraftTriggers(cur, drafted)
    expect(merged.map((t) => t.id)).toEqual(['c1', 'c2'])
  })

  it('unmatched drafted cron becomes a new entry with enabled:true', () => {
    const cur: DraftTrigger[] = [
      cron({ id: 'c1', expression: '0 8 * * *' }),
      { id: 'a1', kind: 'app_start', enabled: true },
    ]
    const drafted: DraftTrigger[] = [cron({ expression: '30 9 * * 1', enabled: false })]
    const merged = mergeDraftTriggers(cur, drafted)
    expect(merged).toEqual([
      { kind: 'cron', enabled: true, expression: '30 9 * * 1' }, // enabled forced to true
      cur[1],                                            // app_start survives
    ])
    // the unmatched existing cron is replaced by the drafted schedule
    expect(merged.some((t) => t.id === 'c1')).toBe(false)
  })
})

describe('mergeDraftTriggers — non-cron drafted entries', () => {
  const disc = (over: Partial<DraftTrigger> = {}): DraftTrigger =>
    ({ kind: 'discord', enabled: true, channel: '123', secret: 'BOT_TOKEN', ...over })
  const imsg = (over: Partial<DraftTrigger> = {}): DraftTrigger =>
    ({ kind: 'imessage', enabled: true, from: '+15550123', ...over })

  it('drafted discord/imessage with no matching existing entry are appended with enabled:true', () => {
    const cur: DraftTrigger[] = [
      { id: 'c1', kind: 'cron', enabled: true, expression: '0 8 * * *' },
    ]
    const drafted: DraftTrigger[] = [
      { id: 'c1', kind: 'cron', enabled: true, expression: '0 8 * * *' },
      disc({ enabled: false }),          // enabled forced back to true on add
      imsg({ pattern: 'report' }),
    ]
    expect(mergeDraftTriggers(cur, drafted)).toEqual([
      cur[0],
      disc(),                        // enabled:true despite the drafted enabled:false
      imsg({ pattern: 'report' }),
    ])
  })

  it('identity treats an absent pattern as empty and coerces mention — no duplicate', () => {
    const cur: DraftTrigger[] = [
      { id: 'd1', ...disc() },                       // pattern/mention undefined
      { id: 'm1', ...imsg({ pattern: undefined }) },
    ]
    const drafted: DraftTrigger[] = [
      disc({ pattern: '', mention: false }),         // (pattern ?? '') and !!mention match
      imsg({ pattern: '' }),
    ]
    expect(mergeDraftTriggers(cur, drafted)).toEqual(cur)
  })

  it('discord author identity ignores order, dupes, and whitespace — no duplicate', () => {
    const cur: DraftTrigger[] = [{ id: 'd1', ...disc({ author: ['alice', 'bob'] }) }]
    const drafted: DraftTrigger[] = [disc({ author: ['bob ', 'alice', 'alice'] })]
    expect(mergeDraftTriggers(cur, drafted)).toEqual(cur)
  })

  it('a genuinely different author set is a new identity and does add', () => {
    const cur: DraftTrigger[] = [{ id: 'd1', ...disc({ author: ['alice'] }) }]
    const merged = mergeDraftTriggers(cur, [disc({ author: ['alice', 'carol'] })])
    expect(merged).toEqual([cur[0], disc({ author: ['alice', 'carol'] })])
  })

  it('a differing pattern, mention, or secret is a new identity and does add', () => {
    const cur: DraftTrigger[] = [{ id: 'd1', ...disc() }]
    const merged = mergeDraftTriggers(cur, [
      disc({ pattern: 'deploy' }),
      disc({ mention: true }),
      disc({ secret: 'OTHER_TOKEN' }),
    ])
    expect(merged).toEqual([
      cur[0],
      disc({ pattern: 'deploy' }),
      disc({ mention: true }),
      disc({ secret: 'OTHER_TOKEN' }),
    ])
  })

  it('drafted time entries are dropped entirely — only crons are mapped', () => {
    const cur: DraftTrigger[] = [
      { id: 't1', kind: 'time', enabled: true, at: '2026-01-01T00:00' },
    ]
    const drafted: DraftTrigger[] = [
      { kind: 'time', enabled: true, at: '2027-06-01T09:00' }, // dropped, not added
    ]
    expect(mergeDraftTriggers(cur, drafted)).toEqual([cur[0]])
  })
})

// ---- §8/§11 grant plumbing: seeds + draft serialization ----
import {
  seedDrafting, seedFromPayload, seedFromAuto, serializeDraft,
} from '../src/pages/CreateFlow'
import type { Agent, Automation, DraftPayload } from '../src/types'

const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id, name: id, harness: 'Claude Code', mode: 'default', model: null, ...over,
})
const AGENTS = [agent('g1'), agent('g2', { harness: 'OpenCode', mode: 'ollama', model: 'qwen3:8b' })]
const SECRETS = ['MAIL_PASSWORD', 'CRM_API_KEY']

describe('grant seeds (§11 Review checkboxes)', () => {
  it('a fresh drafting Rev starts all-on — every agent enabled, every secret allowed', () => {
    const r = seedDrafting(AGENTS, SECRETS)
    expect(r.enabledAgents).toEqual(['g1', 'g2'])
    expect(r.allowedSecrets).toEqual(SECRETS)
  })

  it('a resumed pending draft restores its own grant selections (§4.4)', () => {
    const d = { stepAgents: ['g2'], allowedSecrets: ['CRM_API_KEY'] } as DraftPayload
    const r = seedFromPayload(d, AGENTS, SECRETS)
    expect(r.enabledAgents).toEqual(['g2'])
    expect(r.allowedSecrets).toEqual(['CRM_API_KEY'])
  })

  it('a payload without grant keys defaults to everything (fresh job payloads carry none)', () => {
    const r = seedFromPayload({} as DraftPayload, AGENTS, SECRETS)
    expect(r.enabledAgents).toEqual(['g1', 'g2'])
    expect(r.allowedSecrets).toEqual(SECRETS)
  })

  it('stale grant ids pointing at deleted agents/secrets are filtered out', () => {
    const d = { stepAgents: ['g1', 'gone'], allowedSecrets: ['CRM_API_KEY', 'DELETED_KEY'] } as DraftPayload
    const r = seedFromPayload(d, AGENTS, SECRETS)
    expect(r.enabledAgents).toEqual(['g1'])
    const a = seedFromAuto({
      name: 'A', description: '', spec: [{ kind: 'h1', text: 'T' }], steps: [], instructions: '',
      triggers: [], stepAgents: ['g2', 'gone'], allowedSecrets: ['MAIL_PASSWORD', 'DELETED_KEY'],
      agentId: null, draft: null,
    } as unknown as Automation, AGENTS, SECRETS)
    expect(a.enabledAgents).toEqual(['g2'])
    expect(a.allowedSecrets).toEqual(['MAIL_PASSWORD'])
  })

  it('edit mode prefers the draft snapshot grants over the saved automation ones', () => {
    const a = seedFromAuto({
      name: 'A', description: '', spec: [{ kind: 'h1', text: 'T' }], steps: [], instructions: '',
      triggers: [], stepAgents: ['g1'], allowedSecrets: ['MAIL_PASSWORD'],
      agentId: null,
      draft: { spec: [{ kind: 'h1', text: 'T' }], steps: [], instructions: '', note: '',
               stepAgents: ['g2'], allowedSecrets: ['CRM_API_KEY'] },
    } as unknown as Automation, AGENTS, SECRETS)
    expect(a.enabledAgents).toEqual(['g2'])
    expect(a.allowedSecrets).toEqual(['CRM_API_KEY'])
  })
})

describe('serializeDraft (§4.4 draft payload)', () => {
  it('maps the editor grant state onto stepAgents/allowedSecrets — unchecked entries gone', () => {
    const r = { ...seedDrafting(AGENTS, SECRETS), enabledAgents: ['g2'], allowedSecrets: [] }
    const d = serializeDraft(r)
    expect(d.stepAgents).toEqual(['g2'])
    expect(d.allowedSecrets).toEqual([])
  })

  it('strips package status fields down to { pip, import } declarations', () => {
    const r = {
      ...seedDrafting(AGENTS, SECRETS),
      packages: [{ pip: 'pandas', import: 'pandas', status: 'installed', version: '2.2' }],
    } as ReturnType<typeof seedDrafting>
    expect(serializeDraft(r).packages).toEqual([{ pip: 'pandas', import: 'pandas' }])
  })

  it('carries the thread as `chat`, error entries included (§4.4)', () => {
    const r = {
      ...seedDrafting(AGENTS, SECRETS),
      chat: [entry('user'), entry('error'), entry('answer')],
    }
    expect(serializeDraft(r).chat?.map((e) => e.kind)).toEqual(['user', 'error', 'answer'])
  })
})

// ---- §11 thread persistence (§4.4 `chat` → §5 chat.jsonl) ----
const entry = (kind: ChatEntry['kind']): ChatEntry => ({ id: kind, kind, text: kind })

describe('persistChat', () => {
  it('keeps every §4.4 kind in order — error entries persist so a later chat can name the failure', () => {
    const chat = (['user', 'answer', 'error', 'rewrite', 'blockers', 'system'] as const).map(entry)
    expect(persistChat(chat).map((e) => e.kind))
      .toEqual(['user', 'answer', 'error', 'rewrite', 'blockers', 'system'])
  })
  it('drops entries outside the §4.4 kinds', () => {
    expect(persistChat([{ id: 'x', kind: 'progress' as ChatEntry['kind'], text: 'x' }])).toEqual([])
  })
})

// ---- §11 chat-armed test values (§8 actions.yaml test_values) ----
describe('applyTestValues', () => {
  const P = (over: Partial<ParamDef>): ParamDef =>
    ({ name: 'p', kind: 'text', label: '', help: '', ...over })

  it('leaves params whose name is absent from the values untouched', () => {
    const p = P({ name: 'other', value: 'keep' })
    expect(applyTestValues([p], { p: 'x' })).toEqual([p])
  })
  it('toggle coerces any yaml value through truthiness', () => {
    const ps = applyTestValues([P({ kind: 'toggle' })], { p: 1 })
    expect(ps[0].on).toBe(true)
    expect(applyTestValues([P({ kind: 'toggle', on: true })], { p: 0 })[0].on).toBe(false)
  })
  it('list stringifies array items and wraps a scalar into one line', () => {
    expect(applyTestValues([P({ kind: 'list' })], { p: [1, 'b'] })[0].lines).toEqual(['1', 'b'])
    expect(applyTestValues([P({ kind: 'list' })], { p: 'solo' })[0].lines).toEqual(['solo'])
  })
  it('kv takes row arrays as-is, maps objects to rows, ignores scalars', () => {
    const rows = [{ key: 'a', value: '1' }]
    expect(applyTestValues([P({ kind: 'kv' })], { p: rows })[0].rows).toEqual(rows)
    expect(applyTestValues([P({ kind: 'kv' })], { p: { a: 1 } })[0].rows).toEqual([{ key: 'a', value: '1' }])
    const scalar = P({ kind: 'kv', rows: [] })
    expect(applyTestValues([scalar], { p: 'nope' })[0]).toEqual(scalar)
  })
  it('number keeps numbers, parses numeric strings, falls back to min then 0', () => {
    expect(applyTestValues([P({ kind: 'number' })], { p: 7 })[0].value).toBe(7)
    expect(applyTestValues([P({ kind: 'number' })], { p: '8' })[0].value).toBe(8)
    expect(applyTestValues([P({ kind: 'number', min: 3 })], { p: 'x' })[0].value).toBe(3)
    expect(applyTestValues([P({ kind: 'number' })], { p: 'x' })[0].value).toBe(0)
  })
  it('text stringifies whatever the yaml carried', () => {
    expect(applyTestValues([P({})], { p: 42 })[0].value).toBe('42')
  })
})
