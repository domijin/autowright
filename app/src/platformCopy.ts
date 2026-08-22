// §9 per-OS copy — the table itself lives store-free in platformCopyTable.ts
// (the §15 e2e harness imports it into a Node process, where the renderer
// store's window listeners cannot load); this module binds it to the §9
// store's `platformOs` token for components.
import { platformCopy, type PlatformCopy } from './platformCopyTable'
import { useStore } from './store'

export { platformCopy } from './platformCopyTable'
export type { PlatformCopy } from './platformCopyTable'

/** §9 per-OS copy for the connected backend's OS — the form components use. */
export function usePlatformCopy(): PlatformCopy {
  return platformCopy(useStore((s) => s.platformOs))
}
