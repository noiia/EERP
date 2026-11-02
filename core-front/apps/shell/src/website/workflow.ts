import { SYSTEM_PAGES } from './links'
import type { Block } from './types'

export type NodeId = `page:${string}` | 'sys:login' | 'sys:signup' | 'sys:account' | `ext:${string}`
export type LinkKey = 'cta_href' | 'href' | 'detail_slug' | 'after.slug' | 'after_login_slug' | 'cta_next' | 'href_next'

export interface WfNode { id: NodeId; label: string; slug?: string; pageId?: string; published?: boolean; inMenu?: boolean; missing?: boolean }
export interface WfEdge { id: string; from: NodeId; to: NodeId; label: string; pageId: string; blockId: string; key: LinkKey }
export interface WfProblem { level: 'error' | 'warning'; message: string; nodeId?: NodeId; edgeId?: string }
export interface WfPage { id: string; slug: string; title: string; published: boolean; in_menu: boolean; layout: Block[] }

/** English msgids the map translates. */
export const BLOCK_LABELS: Record<string, string> = {
  text: 'Text', image: 'Image', hero: 'Hero', record_list: 'Record list', record_detail: 'Record detail',
  record_carousel: 'Record carousel', image_carousel: 'Image carousel', event_booking: 'Event booking',
  appointment_booking: 'Appointment booking', event_list: 'Event list', section: 'Section', form: 'Form',
}
const SYS_NODES = { '/login': 'sys:login', '/signup': 'sys:signup', '/account': 'sys:account' } as const
const SYS_LABELS = { 'sys:login': 'Login', 'sys:signup': 'Sign up', 'sys:account': 'Account' } as const
const DETAIL_BLOCKS = new Set(['record_detail', 'event_booking', 'appointment_booking'])
const SLUG_KEYS = new Set<LinkKey>(['detail_slug', 'after.slug', 'after_login_slug', 'cta_next', 'href_next'])

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const pageNode = (slug: string): NodeId => `page:${slug}`

/** The node a stored href points at; null when it is none of a page, a system page or http(s)/mailto. */
function hrefNode(href: string): NodeId | null {
  if (href.startsWith('/') && !href.startsWith('//')) {
    const path = href.split(/[?#]/)[0]
    if (path === '/') return pageNode('')
    if (path in SYS_NODES) return SYS_NODES[path as keyof typeof SYS_NODES]
    return pageNode(path.slice(1).split('/')[0])
  }
  try {
    const u = new URL(href)
    if (u.protocol === 'http:' || u.protocol === 'https:') return `ext:${u.host}`
    if (u.protocol === 'mailto:') return `ext:${u.pathname.split('@')[1] || 'mailto'}`
  } catch { /* not a URL */ }
  return null
}

export function buildWorkflow(pages: WfPage[]): { nodes: WfNode[]; edges: WfEdge[]; problems: WfProblem[] } {
  const nodes = new Map<NodeId, WfNode>()
  const edges: WfEdge[] = []
  const problems: WfProblem[] = []
  const bySlug = new Map(pages.map((p) => [p.slug, p]))
  for (const p of pages) {
    nodes.set(pageNode(p.slug), { id: pageNode(p.slug), label: p.title || `/${p.slug}`, slug: p.slug, pageId: p.id, published: p.published, inMenu: p.in_menu })
    if (p.in_menu && !p.published) problems.push({ level: 'warning', message: 'Unpublished page in the menu', nodeId: pageNode(p.slug) })
  }
  const ensure = (id: NodeId) => {
    if (nodes.has(id)) return
    if (id.startsWith('page:')) nodes.set(id, { id, label: `/${id.slice(5)}`, slug: id.slice(5), missing: true })
    else if (id.startsWith('ext:')) nodes.set(id, { id, label: id.slice(4) })
    else nodes.set(id, { id, label: SYS_LABELS[id as keyof typeof SYS_LABELS] })
  }

  for (const page of pages) {
    const add = (id: string, from: NodeId, to: NodeId, label: string, blockId: string, key: LinkKey, kind?: string) => {
      ensure(from); ensure(to)
      edges.push({ id, from, to, label, pageId: page.id, blockId, key })
      const target = to.startsWith('page:') ? bySlug.get(to.slice(5)) : undefined
      if (to.startsWith('page:') && !target) problems.push({ level: 'error', message: "Link to a page that doesn't exist", nodeId: to, edgeId: id })
      if (target && page.published && !target.published) problems.push({ level: 'warning', message: 'A published page links to an unpublished page', nodeId: to, edgeId: id })
      if (target && kind === 'detail' && !target.layout.some((b) => DETAIL_BLOCKS.has(b.type))) problems.push({ level: 'warning', message: 'Detail page has no detail or booking block', nodeId: to, edgeId: id })
    }
    const here = pageNode(page.slug)
    for (const b of page.layout) {
      const c = b.config ?? {}
      const base = (key: LinkKey) => `${page.id}:${b.id}:${key}`
      const blockLabel = BLOCK_LABELS[b.type] ?? b.type
      const slugEdge = (key: LinkKey, slug: string, kind?: string) => {
        if (slug) add(base(key), here, pageNode(slug), blockLabel, b.id, key, kind)
      }
      const link = (key: 'cta_href' | 'href', nextKey: 'cta_next' | 'href_next') => {
        const target = hrefNode(str(c[key]))
        if (!target) return
        const label = str(c.cta_label) || 'Button'
        add(base(key), here, target, label, b.id, key)
        if (target === 'sys:login' || target === 'sys:signup') {
          const next = str(c[nextKey])
          add(`${base(key)}:next`, target, next ? pageNode(next) : 'sys:account', 'after login', b.id, nextKey)
        }
      }
      const loginGate = (slug: string) => {
        add(base('after_login_slug'), here, 'sys:login', blockLabel, b.id, 'after_login_slug')
        add(`${base('after_login_slug')}:next`, 'sys:login', slug ? pageNode(slug) : here, 'after login', b.id, 'after_login_slug')
      }

      if (b.type === 'hero' || b.type === 'section') link('cta_href', 'cta_next')
      if (b.type === 'image') { link('cta_href', 'cta_next'); link('href', 'href_next') }
      if (b.type === 'record_list' || b.type === 'record_carousel' || b.type === 'image_carousel' || b.type === 'event_list') slugEdge('detail_slug', str(c.detail_slug), 'detail')
      if (b.type === 'event_booking' || b.type === 'appointment_booking') {
        if (c.login_required) loginGate(str(c.after_login_slug))
      }
      if (b.type === 'form') {
        const after = (c.after ?? {}) as { kind?: string; slug?: string }
        if (after.kind === 'page') slugEdge('after.slug', str(after.slug))
        if (c.login_required) loginGate(str(c.after_login_slug))
      }
    }
  }
  return { nodes: [...nodes.values()], edges, problems }
}

/** Re-point one link of one block at `to`, returning a new layout (the input is never
 * mutated). Slug-only keys cannot target system/external nodes, nor can anything target
 * an external node: those return `layout` unchanged. */
export function retarget(layout: Block[], blockId: string, key: LinkKey, to: NodeId): Block[] {
  const idx = layout.findIndex((b) => b.id === blockId)
  if (idx < 0 || to.startsWith('ext:')) return layout
  const config = { ...layout[idx].config }
  if (to.startsWith('page:')) {
    const slug = to.slice(5)
    // '' means unset / back to this page / /account for a slug key: never write it.
    if (!slug && SLUG_KEYS.has(key)) return layout
    if (key === 'after.slug') config.after = { ...((config.after as object) ?? {}), kind: 'page', slug }
    else config[key] = key === 'cta_href' || key === 'href' ? `/${slug}` : slug
  } else {
    if (SLUG_KEYS.has(key) || key === 'after.slug') return layout
    config[key] = SYSTEM_PAGES[to.slice(4) as keyof typeof SYSTEM_PAGES]
  }
  return layout.map((b, i) => (i === idx ? { ...b, config } : b))
}
