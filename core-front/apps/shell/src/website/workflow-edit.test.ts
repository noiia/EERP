import { describe, expect, it } from 'vitest'
import type { Block } from './types'
import { buildWorkflow } from './workflow'
import { addLink, canLinkTo, linkSlots, removable, removeLink } from './workflow-edit'

const block = (id: string, type: Block['type'], config: Record<string, unknown> = {}): Block => ({ id, type, x: 0, y: 0, w: 36, h: 10, config })
const layout: Block[] = [
  block('hero', 'hero', { title: 'Hi' }),
  block('linked', 'hero', { cta_label: 'Go', cta_href: '/about' }),
  block('img', 'image'),
  block('list', 'record_list'),
  block('form', 'form', { after: { kind: 'message', message: 'Thanks' } }),
  block('text', 'text'),
]

describe('linkSlots', () => {
  it('offers every free slot for a slug page, in page order', () => {
    expect(linkSlots(layout, 'page:about').map((s) => `${s.blockId}:${s.key}`)).toEqual(['hero:cta_href', 'img:cta_href', 'img:href', 'list:detail_slug', 'form:after.slug'])
  })
  it('offers only buttons for home and system pages', () => {
    const keys = ['hero:cta_href', 'img:cta_href', 'img:href']
    expect(linkSlots(layout, 'page:').map((s) => `${s.blockId}:${s.key}`)).toEqual(keys)
    expect(linkSlots(layout, 'sys:login').map((s) => `${s.blockId}:${s.key}`)).toEqual(keys)
  })
  it('offers nothing for an external node', () => {
    expect(linkSlots(layout, 'ext:example.com')).toEqual([])
    expect(canLinkTo('ext:example.com', false)).toBe(false)
    expect(canLinkTo('page:gone', true)).toBe(false)
    expect(canLinkTo('sys:account', false)).toBe(true)
  })
  it('skips a form already going to a page', () => {
    expect(linkSlots([block('f', 'form', { after: { kind: 'page', slug: 'x' } })], 'page:about')).toEqual([])
  })
})

describe('addLink', () => {
  it('fills a free button with its label and destination', () => {
    const next = addLink(layout, { slot: { blockId: 'hero', key: 'cta_href' }, to: 'page:contact', label: ' Contact us ' })
    expect(next[0].config).toEqual({ title: 'Hi', cta_href: '/contact', cta_label: 'Contact us' })
    expect(layout[0].config).toEqual({ title: 'Hi' })
  })
  it('a button to Login keeps the after-login page', () => {
    const next = addLink(layout, { slot: { blockId: 'hero', key: 'cta_href' }, to: 'sys:login', label: 'Reserve', next: 'booking' })
    expect(next[0].config).toMatchObject({ cta_href: '/login', cta_label: 'Reserve', cta_next: 'booking' })
    const wf = buildWorkflow([{ id: 'p', slug: 'x', title: 'X', published: true, in_menu: false, layout: next }])
    expect(wf.edges.some((e) => e.from === 'sys:login' && e.to === 'page:booking')).toBe(true)
  })
  it('sets a list detail page and a form after-submit page', () => {
    expect(addLink(layout, { slot: { blockId: 'list', key: 'detail_slug' }, to: 'page:item' })[3].config.detail_slug).toBe('item')
    expect(addLink(layout, { slot: { blockId: 'form', key: 'after.slug' }, to: 'page:thanks' })[4].config.after).toEqual({ kind: 'page', message: 'Thanks', slug: 'thanks' })
  })
  it('adds a new button block at the bottom of the page', () => {
    const next = addLink(layout, { slot: 'new', to: 'sys:account', label: 'My bookings' })
    expect(next).toHaveLength(layout.length + 1)
    const added = next[next.length - 1]
    expect(added).toMatchObject({ type: 'section', x: 0, y: 10, w: 36, h: 8 })
    expect(added.config).toMatchObject({ cta_href: '/account', cta_label: 'My bookings' })
  })
  it('refuses a slot that is taken or gone, and a detail link to home', () => {
    expect(addLink(layout, { slot: { blockId: 'linked', key: 'cta_href' }, to: 'page:x' })).toBe(layout)
    expect(addLink(layout, { slot: { blockId: 'nope', key: 'cta_href' }, to: 'page:x' })).toBe(layout)
    expect(addLink(layout, { slot: { blockId: 'list', key: 'detail_slug' }, to: 'page:' })).toBe(layout)
    expect(addLink(layout, { slot: 'new', to: 'ext:example.com' })).toBe(layout)
  })
})

describe('removeLink', () => {
  it('clears a button, a detail page and a form after-submit page', () => {
    const withNext = [block('b', 'hero', { title: 'T', cta_label: 'Go', cta_href: '/login', cta_next: 'x' })]
    expect(removeLink(withNext, 'b', 'cta_href')[0].config).toEqual({ title: 'T' })
    expect(removeLink([block('l', 'event_list', { detail_slug: 'e' })], 'l', 'detail_slug')[0].config).toEqual({})
    expect(removeLink([block('f', 'form', { after: { kind: 'page', slug: 'x', message: 'Hi' } })], 'f', 'after.slug')[0].config.after).toEqual({ kind: 'message', message: 'Hi' })
    expect(removeLink([block('i', 'image', { href: '/x', href_next: '' })], 'i', 'href')[0].config).toEqual({})
  })
  it('leaves login gates and after-login arrows alone', () => {
    expect(removable('after_login_slug')).toBe(false)
    expect(removable('cta_next')).toBe(false)
    expect(removeLink(layout, 'form', 'after_login_slug')).toBe(layout)
    expect(removeLink(layout, 'nope', 'cta_href')).toBe(layout)
  })
})
