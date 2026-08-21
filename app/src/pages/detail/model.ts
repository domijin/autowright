// Shared helpers for the automation detail page and its cards (§9.2).
import { useStore } from '../../store'
import { PULSE } from '../../ui'

export const badgeAnim = (s: string) => (s === 'executing' ? PULSE : 'none')

/** The one mutation shape every detail card uses: fire-and-forget an api call
 *  from an event handler, toast on failure, reload the automation on success.
 *  The body optionally returns the success toast (silent saves return
 *  nothing); `reload: false` is for actions that navigate away instead;
 *  `onError` runs before the error toast (optimistic-value rollback). */
export const runAction = (
  automationId: string,
  body: () => Promise<string | void>,
  opts?: { reload?: boolean; onError?: () => void },
) => {
  const { showToast, loadAuto } = useStore.getState()
  void (async () => {
    try {
      const msg = await body()
      if (msg) showToast(msg)
      if (opts?.reload !== false) void loadAuto(automationId)
    } catch (err) {
      opts?.onError?.()
      showToast((err as Error).message)
    }
  })()
}
