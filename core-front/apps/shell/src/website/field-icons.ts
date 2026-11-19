import 'server-only'
import { fab } from '@fortawesome/free-brands-svg-icons'
import { far } from '@fortawesome/free-regular-svg-icons'
import { fas } from '@fortawesome/free-solid-svg-icons'
import type { FieldKind, IconFamily } from './field-display'

// Font Awesome Free icons for website fields (ADR-036): Solid, Regular and Brands, all
// free (icons CC BY 4.0, code MIT — no Pro icon, no license key). The full sets are
// large, so they live here, server-only: a page gets just the path data of the icons
// it shows (`SiteIconData`), and the editor's picker searches through a Server Action.
// No icon font, no CSS — each icon is drawn as an inline SVG (FieldValue.tsx).

/** What the browser needs to draw an icon: its viewBox and path(s). */
export interface SiteIconData {
  family: IconFamily
  name: string
  width: number
  height: number
  /** One path, or a duotone's two (drawn in order). */
  path: string | string[]
}

type Def = { iconName: string; icon: [number, number, (string | number)[], string, string | string[]] }
const SETS: Record<IconFamily, Record<string, Def>> = {
  solid: fas as unknown as Record<string, Def>,
  regular: far as unknown as Record<string, Def>,
  brands: fab as unknown as Record<string, Def>,
}

/** Each family's icons by name and by alias — Font Awesome's former names (`map-marker-alt` → `location-dot`). */
const INDEX: Record<IconFamily, Map<string, Def>> = Object.fromEntries(
  (Object.keys(SETS) as IconFamily[]).map((family) => {
    const byName = new Map<string, Def>()
    for (const def of Object.values(SETS[family])) byName.set(def.iconName, def)
    for (const def of Object.values(SETS[family])) {
      for (const alias of def.icon[2]) if (typeof alias === 'string' && !byName.has(alias)) byName.set(alias, def)
    }
    return [family, byName]
  }),
) as Record<IconFamily, Map<string, Def>>

const data = (family: IconFamily, def: Def): SiteIconData =>
  ({ family, name: def.iconName, width: def.icon[0], height: def.icon[1], path: def.icon[4] })

/** The icon `name` of `family`, or undefined (a renamed or mistyped icon: the field shows without it). */
export function resolveIcon(family: IconFamily, name: string): SiteIconData | undefined {
  const def = INDEX[family]?.get(name)
  return def && data(family, def)
}

/** Icons whose name or alias contains every word of `query` (best: exact, then prefix, then
 * shorter names), across the families, at most `limit`. An empty query lists `suggested`. */
export function searchIcons(query: string, limit = 60, suggested: string[] = []): SiteIconData[] {
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (words.length === 0) {
    return suggested.flatMap((n) => {
      const [family, name] = n.includes(':') ? (n.split(':') as [IconFamily, string]) : (['solid', n] as const)
      const hit = resolveIcon(family, name)
      return hit ? [hit] : []
    })
  }
  const hits: { score: number; icon: SiteIconData }[] = []
  for (const family of Object.keys(SETS) as IconFamily[]) {
    // The packages export each icon under several keys (its aliases too): once per icon.
    for (const def of new Set(Object.values(SETS[family]))) {
      const names = [def.iconName, ...def.icon[2].filter((a): a is string => typeof a === 'string')]
      if (!words.every((w) => names.some((n) => n.includes(w)))) continue
      const q = words.join('-')
      const score = names.includes(q) ? 0 : names.some((n) => n.startsWith(words[0])) ? 1 : 2
      hits.push({ score: score * 1000 + def.iconName.length, icon: data(family, def) })
    }
  }
  return hits.sort((a, b) => a.score - b.score).slice(0, limit).map((h) => h.icon)
}

/** Icons offered first for a kind of field, before the user searches (`family:name`, solid by default). */
export const SUGGESTED_ICONS: Partial<Record<FieldKind, string[]>> & { default: string[] } = {
  phone: ['phone', 'mobile-screen', 'phone-volume', 'headset', 'brands:whatsapp', 'brands:telegram'],
  email: ['envelope', 'regular:envelope', 'at', 'paper-plane', 'inbox'],
  url: ['globe', 'link', 'arrow-up-right-from-square', 'brands:instagram', 'brands:facebook', 'brands:linkedin', 'brands:x-twitter', 'brands:youtube', 'brands:tiktok'],
  monetary: ['tag', 'euro-sign', 'dollar-sign', 'sterling-sign', 'coins', 'wallet', 'receipt'],
  date: ['calendar', 'regular:calendar', 'calendar-days', 'calendar-check'],
  datetime: ['clock', 'regular:clock', 'calendar-days', 'hourglass-half'],
  duration: ['clock', 'hourglass-half', 'stopwatch'],
  boolean: ['check', 'circle-check', 'regular:circle-check', 'xmark'],
  percent: ['percent', 'chart-pie', 'chart-simple'],
  rating: ['star', 'regular:star', 'thumbs-up'],
  default: ['location-dot', 'user', 'building', 'tag', 'circle-info', 'star', 'heart', 'house', 'briefcase', 'truck', 'box', 'leaf'],
}
