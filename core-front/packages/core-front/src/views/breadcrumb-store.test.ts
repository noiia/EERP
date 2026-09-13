import { beforeEach, describe, expect, it } from 'vitest'
import { nextBreadcrumbTrail, useBreadcrumbStore, type Crumb } from './breadcrumb-store'

const sale: Crumb = { label: 'Sale', href: '/sale' }
const products: Crumb = { label: 'Products', href: '/sale/products' }
const productA: Crumb = { label: 'Widget', href: '/sale/products/a' }
const settings: Crumb = { label: 'Settings', href: '/settings' }

describe('nextBreadcrumbTrail', () => {
  it('resets to empty when the current location is the menu root', () => {
    expect(nextBreadcrumbTrail([sale, products], [])).toEqual([])
  })

  it('seeds the trail from an empty history', () => {
    expect(nextBreadcrumbTrail([], [sale, products])).toEqual([sale, products])
  })

  it('diving deeper in the same section replaces its trailing run', () => {
    const trail = nextBreadcrumbTrail([sale], [sale, products, productA])
    expect(trail).toEqual([sale, products, productA])
  })

  it('jumping to an unrelated section appends after the existing trail', () => {
    const trail = nextBreadcrumbTrail([sale, products, productA], [settings])
    expect(trail).toEqual([sale, products, productA, settings])
  })

  it('returning to a page already in the trail truncates everything after it', () => {
    const trail = nextBreadcrumbTrail([sale, products, productA, settings], [sale])
    expect(trail).toEqual([sale])
  })
})

describe('useBreadcrumbStore', () => {
  beforeEach(() => useBreadcrumbStore.setState({ trail: [] }))

  it('starts empty', () => {
    expect(useBreadcrumbStore.getState().trail).toEqual([])
  })

  it('accumulates across visits and truncates on a revisit', () => {
    useBreadcrumbStore.getState().visit([sale, products])
    useBreadcrumbStore.getState().visit([settings])
    expect(useBreadcrumbStore.getState().trail).toEqual([sale, products, settings])

    useBreadcrumbStore.getState().visit([sale])
    expect(useBreadcrumbStore.getState().trail).toEqual([sale])
  })
})
