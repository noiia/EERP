import { fas } from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'

// FontAwesome's own `byPrefixAndName.fas['icon-name']` lookup ships only from a paid
// Kit package (`@awesome.me/kit-<code>/icons`) — not available from the free npm
// packages. This mirrors that exact lookup shape over the free Solid set, so every
// call site uses the same syntax with no Kit subscription.
export const byPrefixAndName = {
  fas: Object.fromEntries(Object.values(fas).map((def) => [def.iconName, def])) as Record<
    string,
    IconDefinition
  >,
}

export { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
