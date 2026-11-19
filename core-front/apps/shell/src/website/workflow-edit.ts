import { addBlock } from './layout-ops'
import type { Block } from './types'
import { retarget, type LinkKey, type NodeId } from './workflow'

// Pure layout edits behind the workflow map's "new link" and "remove link"
// (app/app/website/workflows). A link always belongs to a block, so a new arrow
// either fills a block that has no link of that kind yet, or adds a new button
// block (a small section with a button) at the bottom of the page.

/** The link keys a map arrow can be created on or removed from. Login-gate and
 * "after login" arrows are derived from other settings and are edited by drag only. */
export type SlotKey = 'cta_href' | 'href' | 'detail_slug' | 'after.slug'

/** A block of the source page able to take the new link. `button`: the link is a
 * labelled button (the label is asked for); otherwise the block's own setting. */
export interface LinkSlot { blockId: string; blockType: Block['type']; key: SlotKey; button: boolean }

const LIST_BLOCKS = new Set(['record_list', 'record_carousel', 'image_carousel', 'event_list'])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Whether a map arrow can be drawn to `to` at all: a site page that exists, or a
 * system page. External sites have no URL on the map (only their host). */
export const canLinkTo = (to: NodeId, missing: boolean) => !missing && !to.startsWith('ext:')

/** The blocks of `layout` that can take a new link to `to`, in page order. Buttons
 * (hero, section, image) go to a page or a system page; card lists and a form's
 * "after submit" only to a site page other than home (they need a slug). */
export function linkSlots(layout: Block[], to: NodeId): LinkSlot[] {
  const out: LinkSlot[] = []
  if (to.startsWith('ext:')) return out
  const slugPage = to.startsWith('page:') && to.length > 'page:'.length
  for (const b of layout) {
    const c = b.config ?? {}
    if ((b.type === 'hero' || b.type === 'section' || b.type === 'image') && !str(c.cta_href)) out.push({ blockId: b.id, blockType: b.type, key: 'cta_href', button: true })
    if (b.type === 'image' && !str(c.href)) out.push({ blockId: b.id, blockType: b.type, key: 'href', button: false })
    if (slugPage && LIST_BLOCKS.has(b.type) && !str(c.detail_slug)) out.push({ blockId: b.id, blockType: b.type, key: 'detail_slug', button: false })
    if (slugPage && b.type === 'form' && (c.after as { kind?: string } | undefined)?.kind !== 'page') out.push({ blockId: b.id, blockType: b.type, key: 'after.slug', button: false })
  }
  return out
}

export interface NewLink {
  /** A slot from `linkSlots`, or 'new' for a new button block. */
  slot: { blockId: string; key: SlotKey } | 'new'
  to: NodeId
  /** Button text (buttons only; blank keeps the block's current label). */
  label?: string
  /** Login/Sign up only: bare slug of the page to go to after login ('' = My account). */
  next?: string
}

/** Adds the link, returning a new layout; `layout` itself unchanged when the slot is
 * gone or taken (the page changed since the map loaded) or `to` can't be its target. */
export function addLink(layout: Block[], link: NewLink): Block[] {
  let base = layout
  let blockId: string
  let key: SlotKey
  if (link.slot === 'new') {
    if (link.to.startsWith('ext:')) return layout
    base = addBlock(layout, 'section')
    const added = base[base.length - 1]
    base = [...base.slice(0, -1), { ...added, h: 8 }]
    blockId = added.id
    key = 'cta_href'
  } else {
    ;({ blockId, key } = link.slot)
    if (!linkSlots(layout, link.to).some((s) => s.blockId === blockId && s.key === key)) return layout
  }
  const next = retarget(base, blockId, key as LinkKey, link.to)
  if (next === base) return layout
  return next.map((b) => {
    if (b.id !== blockId) return b
    const config = { ...b.config }
    const label = link.label?.trim()
    if (key === 'cta_href' && label) config.cta_label = label
    if ((key === 'cta_href' || key === 'href') && (link.to === 'sys:login' || link.to === 'sys:signup')) {
      const nextKey = key === 'cta_href' ? 'cta_next' : 'href_next'
      if (link.next) config[nextKey] = link.next
      else delete config[nextKey]
    }
    return { ...b, config }
  })
}

/** Whether the arrow for `key` can be removed from the map. */
export const removable = (key: LinkKey): key is SlotKey => key === 'cta_href' || key === 'href' || key === 'detail_slug' || key === 'after.slug'

/** Removes one link from a block, returning a new layout: a button loses its text and
 * destination (the block stays), a list its detail page, a form goes back to showing
 * its message after submit. Unknown block or a non-removable key → `layout` unchanged. */
export function removeLink(layout: Block[], blockId: string, key: LinkKey): Block[] {
  const idx = layout.findIndex((b) => b.id === blockId)
  if (idx < 0 || !removable(key)) return layout
  const config = { ...layout[idx].config }
  if (key === 'cta_href') { delete config.cta_href; delete config.cta_label; delete config.cta_next }
  if (key === 'href') { delete config.href; delete config.href_next }
  if (key === 'detail_slug') delete config.detail_slug
  if (key === 'after.slug') config.after = { kind: 'message', message: str((config.after as { message?: unknown } | undefined)?.message) }
  return layout.map((b, i) => (i === idx ? { ...b, config } : b))
}
