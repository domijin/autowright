# UI conventions (for page implementers)

Implement pages to SPEC.md — §9–§13 describe each screen, §14 is the authoritative token sheet.
Pages style with inline JSX `style={{…}}` objects using the exact spec values. Dark theme only.
All tokens exist as CSS vars (see `src/tokens.css`): use `var(--accent)`, `var(--bg-card)`,
`var(--text-2)`, `var(--mono)` etc. instead of raw hex where a token exists; keep exact
oklch/rgba values where no token fits.

## Data + state

- `useStore()` from `src/store.ts` — the central model:
  - data: `automations: Automation[]`, `executions: Execution[]` (list headers — no
    steps/result), `agents: Agent[]`, `secrets: SecretMeta[]`, `settings: Settings | null`,
    `pendingDraft`, `version`, `connected`
  - nav: `surface`, `page`, `automationId`, `executionId`, `createFrom`, `agentEditId`;
    navigate with `go(page, {automationId?, executionId?, agentEditId?})` and
    `setSurface(surface, from?)`
  - `showToast(msg, ms?)`; `toast` is rendered by App — never render your own toast container.
  - `executionFull: Record<executionId, Execution>` — full execution (steps/result) cache; call
    `loadExecution(id)` to (re)fetch; live `execution.step` WS events are merged in
    automatically while the record is in `executionFull`.
  - `execLogs: Record<executionId, Record<logKey, LogLine[]>>` — lazy log buckets; call
    `loadExecLogs(id, step?, attempt?)` to open+fetch one; live `execution.log` WS events
    extend open buckets (deduped by `sequence`).
  - Cache eviction: only the currently viewed execution plus the 5 most recently viewed keep
    their `executionFull` records and log buckets — older ones are dropped on navigation and
    refetch on next open, so never assume a record from a past visit is still cached.
  - `loadAuto(id)` refetches one automation into `automations`.
  - `test: { executionId } | null` + `beginTest(executionId)` / `clearTest()` — the §11 tracked
    test. It holds only the tracked id: steps, status, and logs live on the ordinary exec
    record (`executionFull[executionId]`, kept fresh by the `execution.*` events). There is no
    `test.issue` WS event and no analysis state on `test`.
- `api` from `src/api.ts` — typed §19 client (`api.executeNow`, `api.patchAutomation`,
  `api.putSecret`, …). All mutations trigger WS `*.changed` events which update the store —
  after calling a mutation you usually only `showToast(...)`. Single-automation events carry
  the changed row and patch it in place; only bare/many-changed events re-fetch `/state`.
- Types in `src/types.ts` (`Automation`, `Execution`, `ExecutionStep`, `ParamDef`, `SpecBlock`,
  `ExecutionResult`, …). WS envelopes are the `WsEvent` discriminated union — extend it when
  the backend adds an event; `applyEvent` narrows on `event`, no casts.

## Shared primitives (`src/ui.tsx`) — use these, don't reinvent

`P` (palette), `Badge status=…` (§4.6 vocabulary), `Chip`, `resultChipColors(resultChip)`
(takes the automation's `resultChip` status: `'changes' | 'ok' | 'attention'`),
`Eyebrow`, `Spinner`, `Toggle`, `RadioRing`, `BtnPrimary`, `BtnGhost`,
`usePopover()` → `[open, setOpen, ref]` (closes on outside mousedown; wrap trigger+menu in
`<div ref={ref} style={{position:'relative'}}>`), `menuStyle`, `MenuRow`,
`paramSummary(p)`, `validUrl(s)`, `nextIn(auto)` (countdown; re-render every 30 s with a
`useEffect` interval), `ConfirmModal`, `PageTitle`, `CountPill`. App renders `Toast` globally.
Result rendering lives in `src/result.tsx`: `ResultSection label=… result=… executionId=…`.

## Behaviors that must match the spec

- Pages animate in with `className="ad-anim-page"` on the page container (never a raw
  `animation:` style), max-width 1200 (forms 620–720, settings 640), padding
  `26px 30px 70px` (detail pages `20px 30px 70px`).
- Icons: Font Awesome classes (`fa-solid fa-…`), already loaded.
- Status colors/labels only via `Badge`/`badgeOf`. Mono for timestamps/chips/eyebrows/metadata.
- Toast copy, warning copy, empty-state copy: use the exact strings from SPEC.md.
- Popovers close on outside mousedown (usePopover). Danger rows red.
- Never block on `window.confirm` — use `ConfirmModal`.
- `void`-call async api methods from event handlers; wrap in try/catch and
  `showToast(err.message)` on failure where the spec defines a message.

## Working style

Write ONLY your assigned file(s) under `app/src/pages/`. Default-export the page component.
After writing, check with `cd app && npx tsc --noEmit` and fix errors in YOUR files (ignore errors in
other pages — someone else owns them). Do not edit store.ts/ui.tsx/api.ts/App.tsx; if you're
blocked by a missing store field, work around it locally inside your component.
