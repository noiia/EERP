import { describe, expect, it } from 'vitest'
import type { Block } from './types'
import { buildWorkflow, retarget, type WfPage } from './workflow'

const blk = (id: string, type: Block['type'], config: Record<string, unknown>): Block => ({ id, type, x: 0, y: 0, w: 6, h: 4, config })
const page = (id: string, slug: string, layout: Block[] = [], o: Partial<WfPage> = {}): WfPage => ({ id, slug, title: slug || 'Home', published: true, in_menu: false, layout, ...o })

describe('buildWorkflow', () => {
  it('links a hero button to a page, home and external hosts', () => {
    const w = buildWorkflow([
      page('p1', '', [blk('b1', 'hero', { cta_href: '/about', cta_label: 'Go' }), blk('b2', 'image', { href: 'https://ex.com/x' }), blk('b3', 'section', { cta_href: 'mailto:a@b.org' })]),
      page('p2', 'about'),
    ])
    expect(w.edges.map((e) => [e.id, e.from, e.to, e.label])).toEqual([
      ['p1:b1:cta_href', 'page:', 'page:about', 'Go'],
      ['p1:b2:href', 'page:', 'ext:ex.com', 'Button'],
      ['p1:b3:cta_href', 'page:', 'ext:b.org', 'Button'],
    ])
    expect(w.problems).toEqual([])
  })

  it('splits a login button with next into two edges', () => {
    const w = buildWorkflow([page('p1', '', [blk('b1', 'hero', { cta_href: '/login', cta_label: 'Sign in', cta_next: 'shop' })]), page('p2', 'shop')])
    expect(w.edges).toEqual([
      { id: 'p1:b1:cta_href', from: 'page:', to: 'sys:login', label: 'Sign in', pageId: 'p1', blockId: 'b1', key: 'cta_href' },
      { id: 'p1:b1:cta_href:next', from: 'sys:login', to: 'page:shop', label: 'after login', pageId: 'p1', blockId: 'b1', key: 'cta_next' },
    ])
  })

  it('sends a login button without next to the account page', () => {
    const w = buildWorkflow([page('p1', '', [blk('b1', 'hero', { cta_href: '/signup' })])])
    expect(w.edges[1]).toMatchObject({ from: 'sys:signup', to: 'sys:account', key: 'cta_next' })
  })

  it('draws login-required bookings and forms through the login node', () => {
    const w = buildWorkflow([
      page('p1', 'book', [blk('b1', 'event_booking', { login_required: true, after_login_slug: 'thanks' }), blk('b2', 'form', { login_required: true, after: { kind: 'page', slug: 'thanks' } })]),
      page('p2', 'thanks'),
    ])
    expect(w.edges.map((e) => [e.id, e.from, e.to, e.label])).toEqual([
      ['p1:b1:after_login_slug', 'page:book', 'sys:login', 'Event booking'],
      ['p1:b1:after_login_slug:next', 'sys:login', 'page:thanks', 'after login'],
      ['p1:b2:after.slug', 'page:book', 'page:thanks', 'Form'],
      ['p1:b2:after_login_slug', 'page:book', 'sys:login', 'Form'],
      ['p1:b2:after_login_slug:next', 'sys:login', 'page:book', 'after login'],
    ])
  })

  it('marks a missing target and reports an error', () => {
    const w = buildWorkflow([page('p1', '', [blk('b1', 'hero', { cta_href: '/nowhere' })])])
    expect(w.nodes.find((n) => n.id === 'page:nowhere')).toMatchObject({ missing: true })
    expect(w.problems).toEqual([{ level: 'error', message: "Link to a page that doesn't exist", nodeId: 'page:nowhere', edgeId: 'p1:b1:cta_href' }])
  })

  it('warns when a published page links to an unpublished one, and for unpublished menu pages', () => {
    const w = buildWorkflow([page('p1', '', [blk('b1', 'hero', { cta_href: '/draft' })]), page('p2', 'draft', [], { published: false, in_menu: true })])
    expect(w.problems).toEqual([
      { level: 'warning', message: 'Unpublished page in the menu', nodeId: 'page:draft' },
      { level: 'warning', message: 'A published page links to an unpublished page', nodeId: 'page:draft', edgeId: 'p1:b1:cta_href' },
    ])
  })

  it('warns when a detail page has no detail or booking block', () => {
    const bad = buildWorkflow([page('p1', '', [blk('b1', 'record_list', { detail_slug: 'item' })]), page('p2', 'item', [blk('x', 'text', {})])])
    expect(bad.problems).toEqual([{ level: 'warning', message: 'Detail page has no detail or booking block', nodeId: 'page:item', edgeId: 'p1:b1:detail_slug' }])
    const ok = buildWorkflow([page('p1', '', [blk('b1', 'event_list', { detail_slug: 'item' })]), page('p2', 'item', [blk('x', 'event_booking', {})])])
    expect(ok.problems).toEqual([])
  })
})

describe('retarget', () => {
  const layout = [blk('b1', 'hero', { cta_href: '/login', cta_next: 'shop', title: 'T' }), blk('b2', 'record_list', { detail_slug: 'a' }), blk('b3', 'form', { after: { kind: 'page', slug: 'a' }, after_login_slug: '' })]

  it('changes only the named block and key', () => {
    const out = retarget(layout, 'b2', 'detail_slug', 'page:z')
    expect(out[1].config).toEqual({ detail_slug: 'z' })
    expect(out[0]).toEqual(layout[0])
    expect(out[2]).toEqual(layout[2])
    expect(layout[1].config).toEqual({ detail_slug: 'a' })
  })

  it('uses slash form for button links and bare form for slug keys', () => {
    expect(retarget(layout, 'b1', 'cta_href', 'page:about')[0].config).toMatchObject({ cta_href: '/about', cta_next: 'shop' })
    expect(retarget(layout, 'b1', 'cta_next', 'page:other')[0].config).toMatchObject({ cta_next: 'other' })
    expect(retarget(layout, 'b3', 'after.slug', 'page:b')[2].config.after).toEqual({ kind: 'page', slug: 'b' })
    expect(retarget(layout, 'b1', 'cta_href', 'page:')[0].config).toMatchObject({ cta_href: '/' })
  })

  it('keeps cta_next when moving a button to a system page', () => {
    expect(retarget(layout, 'b1', 'cta_href', 'sys:signup')[0].config).toEqual({ cta_href: '/signup', cta_next: 'shop', title: 'T' })
  })

  it('refuses system and external targets for slug-only keys', () => {
    expect(retarget(layout, 'b2', 'detail_slug', 'sys:login')).toBe(layout)
    expect(retarget(layout, 'b3', 'after_login_slug', 'ext:x.com')).toBe(layout)
    expect(retarget(layout, 'b1', 'cta_href', 'ext:x.com')).toBe(layout)
    expect(retarget(layout, 'nope', 'cta_href', 'sys:login')).toBe(layout)
  })

  it('refuses the home node for every slug-only key', () => {
    const l = [blk('b1', 'hero', { cta_next: 'a' }), blk('b2', 'image', { href_next: 'a' }), blk('b3', 'record_list', { detail_slug: 'a' }), blk('b4', 'form', { after: { kind: 'page', slug: 'a' }, after_login_slug: 'a' })]
    expect(retarget(l, 'b1', 'cta_next', 'page:')).toBe(l)
    expect(retarget(l, 'b2', 'href_next', 'page:')).toBe(l)
    expect(retarget(l, 'b3', 'detail_slug', 'page:')).toBe(l)
    expect(retarget(l, 'b4', 'after.slug', 'page:')).toBe(l)
    expect(retarget(l, 'b4', 'after_login_slug', 'page:')).toBe(l)
  })
})

describe('buildWorkflow unsafe hrefs', () => {
  it('ignores unparseable or unsafe stored links', () => {
    const w = buildWorkflow([page('p1', '', [blk('b1', 'hero', { cta_href: 'javascript:alert(1)' }), blk('b2', 'image', { href: 'not a link' })])])
    expect(w.edges).toEqual([])
    expect(w.problems).toEqual([])
  })
})
