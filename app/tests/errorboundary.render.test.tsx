// §9 render-failure containment: a throwing page is replaced by the notice with
// a way back, and the rest of the shell survives. The boundary renders for real
// (happy-dom) against the real store, with the api module mocked offline.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => false),
  openWs: vi.fn(() => () => {}),
  api: { state: vi.fn(() => Promise.reject(new Error('offline'))) },
}))

let storeMod: typeof import('../src/store')
let ErrorBoundary: typeof import('../src/ErrorBoundary').ErrorBoundary

function Boom(): React.ReactElement {
  throw new Error('spec block went sideways')
}

beforeAll(async () => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    onOpenTarget: () => {},
    trayAlert: () => Promise.resolve(),
  }
  storeMod = await import('../src/store')
  ErrorBoundary = (await import('../src/ErrorBoundary')).ErrorBoundary
})

beforeEach(() => {
  storeMod.useStore.setState({ page: 'execution', executionId: 'e1', surface: 'app' })
  // React logs the caught error through console.error by design — keep the
  // test output readable without hiding a real failure.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ErrorBoundary (§9)', () => {
  it('renders its children untouched while nothing throws', () => {
    render(<ErrorBoundary><div>page body</div></ErrorBoundary>)
    expect(screen.getByText('page body')).toBeTruthy()
    expect(screen.queryByText('Something went wrong on this page')).toBeNull()
  })

  it('catches a throwing child and shows the notice with the error message', () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.getByText('Something went wrong on this page')).toBeTruthy()
    expect(screen.getByText('spec block went sideways')).toBeTruthy()
  })

  it('the back action navigates to the automations list and clears the failure', () => {
    // A child that throws while the broken page is showing — after the back
    // action navigates away it renders, like any healthy page.
    const Once = () => {
      const page = storeMod.useStore((s) => s.page)
      if (page !== 'automations') throw new Error('execution page blew up')
      return <div>recovered</div>
    }
    render(<ErrorBoundary><Once /></ErrorBoundary>)
    fireEvent.click(screen.getByText('Back to Automations'))
    const m = storeMod.useStore.getState()
    expect(m.page).toBe('automations')
    expect(m.executionId).toBeNull()
    expect(screen.getByText('recovered')).toBeTruthy()
    expect(screen.queryByText('Something went wrong on this page')).toBeNull()
  })
})
