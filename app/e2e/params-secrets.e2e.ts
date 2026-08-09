// §15 e2e: §4.2 parameter editing on the detail page reaching a real
// execution, and the missing-secret failure flow with a §4.8 placeholder
// (blank value — the Keychain is never written).
import { afterEach, describe, expect, it } from 'vitest'
import { Backend, closeApp, launchApp, shot, waitFor, type AppHandle } from './harness'

const PARAMS = [
  { name: 'greeting', kind: 'text', label: 'Greeting', help: 'Logged by the step.', default: '', placeholder: 'Type a greeting' },
  { name: 'limit', kind: 'number', label: 'Limit', help: 'Minimum is five.', min: 5, default: 9 },
  { name: 'party', kind: 'toggle', label: 'Party mode', help: 'Just a flag.', default: false },
  { name: 'links', kind: 'list', label: 'Links', help: 'One link per line.', validate: true, default: ['https://example.com'] },
  { name: 'names', kind: 'kv', label: 'Nicknames', help: 'Long to short.', default: [{ key: 'long', value: 'short' }] },
]
const PARAM_STEP = {
  file: '01-use-params.py', name: 'Use params', description: 'logs param values',
  code: 'from autowright import log, params, result\nlog(f"greeting={params[\'greeting\']}")\nlog(f"limit={params[\'limit\']}")\nresult.status("ok")\nresult.chip("Params")\n',
}
const SECRET_STEP = {
  file: '01-secret.py', name: 'Use secret', description: 'references a secret',
  code: 'from autowright import log, result, secrets\nlog(secrets.MY_TOKEN)\nresult.status("ok")\n',
}

interface ParamJson { name: string; value?: unknown; on?: boolean }

describe('params and secrets e2e', () => {
  let backend: Backend | null = null
  let handle: AppHandle | null = null

  afterEach(async () => {
    await closeApp(handle)
    handle = null
    await backend?.stop()
    backend = null
  })

  it('edits all param kinds on the detail page and the values reach the execution', async () => {
    backend = await new Backend().start()
    const { id } = await backend.createAutomation('Params e2e', [PARAM_STEP], { params: PARAMS })
    handle = await launchApp(backend.home, true)
    const { page } = handle

    await page.getByText('Params e2e').waitFor({ timeout: 20_000 })
    await page.getByText('Params e2e').click()
    await page.getByText('PARAMETERS').waitFor({ timeout: 10_000 })

    const param = async (name: string) => {
      const a = await backend!.api('GET', `/automations/${id}`) as { params: ParamJson[] }
      return a.params.find((p) => p.name === name)
    }

    // Text param — debounced commit, flushed on blur.
    await page.getByPlaceholder('Type a greeting').fill('Hello e2e')
    await page.keyboard.press('Tab')
    await waitFor(async () => (await param('greeting'))?.value === 'Hello e2e', 10_000, 'text param commit')

    // Number param — a below-min entry clamps to min (5).
    const num = page.locator('input[inputmode="numeric"]')
    await num.fill('2')
    await page.keyboard.press('Tab')
    await waitFor(async () => (await param('limit'))?.value === 5, 10_000, 'number param clamp')

    // Toggle — the param row's switch control.
    await page.getByTestId('param-row-party').getByRole('switch').click()
    await waitFor(async () => (await param('party'))?.on === true, 10_000, 'toggle param commit')

    // List URL validation: typing a non-URL flags the line inline. The row's
    // textboxes are its lines in data order — edit the first (only) line.
    await page.getByTestId('param-row-links').getByRole('textbox').first().fill('not a link')
    await page.getByText('NOT A VALID LINK').waitFor({ timeout: 10_000 })
    await page.getByText(/1 needs attention/).waitFor()
    await shot(page, 'params-edited.png')

    // Execute — the edited text value and clamped number reach the step log.
    await page.getByRole('button', { name: 'Execute now' }).click()
    await page.getByText('Succeeded', { exact: true }).first().waitFor({ timeout: 30_000 })
    await page.getByText('Manual · v1').first().click()
    await page.getByText('greeting=Hello e2e').waitFor({ timeout: 20_000 })
    await page.getByText('limit=5').waitFor()
    await shot(page, 'params-execution.png')
  }, 120_000)

  it('surfaces the missing-secret failure for a placeholder secret', async () => {
    backend = await new Backend().start()
    await backend.putSecretPlaceholder('MY_TOKEN', 'Placeholder for the e2e secret flow')
    const { id } = await backend.createAutomation('Secret e2e', [SECRET_STEP], { allowedSecrets: ['MY_TOKEN'] })
    const exec = await backend.executeAndWait(id)
    expect(exec.status).toBe('failed') // stops before any step (§6)

    handle = await launchApp(backend.home, true)
    const { page } = handle

    // Detail page: the §9.2 failure notice with the §7 placeholder-specific
    // message + reason, the step's secret tag, and the View-execution door.
    await page.getByText('Secret e2e').waitFor({ timeout: 20_000 })
    await page.getByText('Secret e2e').click()
    await page.getByText('Execution failed').first().waitFor({ timeout: 10_000 })
    await page.getByText(/secret MY_TOKEN has no value yet — add it on the Secrets page/).first().waitFor()
    await page.getByText(/whose value hasn't been added yet/).first().waitFor() // ASCII apostrophe (engine string)
    await page.getByText('MY_TOKEN', { exact: true }).first().waitFor() // step secret tag
    await shot(page, 'missing-secret-detail.png')
    await page.getByRole('button', { name: /View execution/ }).click()
    await page.getByText('Failed', { exact: true }).first().waitFor({ timeout: 10_000 })
    await page.getByText(/has no value yet/).first().waitFor()
    await shot(page, 'missing-secret-execution.png')
  }, 120_000)
})
