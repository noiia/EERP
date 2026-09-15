import { beforeEach, describe, expect, it } from 'vitest'
import { nextBreadcrumbTrail, useBreadcrumbStore, type Crumb } from './breadcrumb-store'

const sale: Crumb = { label: 'Sale', href: '/sale' }
const products: Crumb = { label: 'Products', href: '/sale/products' }
const productA: Crumb = { label: 'Widget', href: '/sale/products/a' }
const settings: Crumb = { label: 'Settings', href: '/settings' }

describe('nextBreadcrumbTrail', () => {
  it('resets to empty when the current location is the menu root', () => {
    expect(nextBreadcrumbTrail([sale, products], null)).toEqual([])
  })

  it('seeds the trail from an empty history', () => {
    expect(nextBreadcrumbTrail([], sale)).toEqual([sale])
  })

  it('appends each newly visited page, one crumb per real navigation', () => {
    const trail = nextBreadcrumbTrail([sale], products)
    expect(trail).toEqual([sale, products])
  })

  it('a page reached without visiting its ancestors first only ever adds its own crumb — no synthesized ancestor chain', () => {
    const trail = nextBreadcrumbTrail([], productA)
    expect(trail).toEqual([productA])
  })

  it('jumping to an unrelated section appends after the existing trail', () => {
    const trail = nextBreadcrumbTrail([sale, products, productA], settings)
    expect(trail).toEqual([sale, products, productA, settings])
  })

  it('returning to a page already in the trail truncates everything after it', () => {
    const trail = nextBreadcrumbTrail([sale, products, productA, settings], sale)
    expect(trail).toEqual([sale])
  })

  it('revisiting the same page refreshes its label (e.g. once record-label-store resolves a real name)', () => {
    const stale: Crumb = { label: 'productA', href: '/sale/products/a' }
    const trail = nextBreadcrumbTrail([sale, products, stale], productA)
    expect(trail).toEqual([sale, products, productA])
  })
})

describe('useBreadcrumbStore', () => {
  beforeEach(() => useBreadcrumbStore.setState({ trail: [] }))

  it('starts empty', () => {
    expect(useBreadcrumbStore.getState().trail).toEqual([])
  })

  it('accumulates across visits and truncates on a revisit', () => {
    useBreadcrumbStore.getState().visit(sale)
    useBreadcrumbStore.getState().visit(products)
    useBreadcrumbStore.getState().visit(settings)
    expect(useBreadcrumbStore.getState().trail).toEqual([sale, products, settings])

    useBreadcrumbStore.getState().visit(sale)
    expect(useBreadcrumbStore.getState().trail).toEqual([sale])
  })

  it('dropLast removes only the trail\'s own last entry', () => {
    useBreadcrumbStore.getState().visit(sale)
    useBreadcrumbStore.getState().visit(products)
    useBreadcrumbStore.getState().dropLast()
    expect(useBreadcrumbStore.getState().trail).toEqual([sale])
  })

  it('dropLast then visiting a new page replaces in place — the chevron-stepper contract', () => {
    useBreadcrumbStore.getState().visit(sale)
    useBreadcrumbStore.getState().visit(productA)
    // FormListNav's goTo: pop the record just left, then visit() the next one.
    useBreadcrumbStore.getState().dropLast()
    useBreadcrumbStore.getState().visit(settings)
    expect(useBreadcrumbStore.getState().trail).toEqual([sale, settings])
  })

  it('dropLast on an empty trail is a no-op', () => {
    useBreadcrumbStore.getState().dropLast()
    expect(useBreadcrumbStore.getState().trail).toEqual([])
  })
})
