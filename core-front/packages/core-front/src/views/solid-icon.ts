import { fas } from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'

// Server-only (exported from the server barrel): the full Solid set, looked up by
// name. A module's `menu_icon` can be any Solid icon, so the landing page resolves
// tile icons here and hands the client just those definitions — the ~950 KB set
// never enters a browser bundle.
const byName = new Map<string, IconDefinition>(Object.values(fas).map((def) => [def.iconName, def]))

/** The Solid icon named `name` (e.g. `'globe'`), or undefined when there is none. */
export function solidIcon(name: string | undefined): IconDefinition | undefined {
  return name ? byName.get(name) : undefined
}
