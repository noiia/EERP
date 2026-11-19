import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

let pages: Record<string, unknown> = {}
const allPages: Record<string, unknown> = {
  '': { id: 'h', slug: '', title: 'Home', layout: [{ id: 'a', type: 'text', x: 0, y: 0, w: 12, h: 1, config: { body: 'Welcome' } }] },
  products: { id: 'p', slug: 'products', title: 'Products', layout: [] },
}
vi.mock('@/website/public-api', () => ({
  getSitePage: async (slug: string) => pages[slug] ?? null,
  serverPublicSource: { list: async () => null, get: async () => null },
}))
const { notFound, redirect } = vi.hoisted(() => ({
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
  redirect: vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) }),
}))
vi.mock('next/navigation', () => ({ notFound, redirect }))

import Page, { generateMetadata } from './page'

describe('site page', () => {
  beforeEach(() => { notFound.mockClear(); pages = { ...allPages } })

  it('renders the home page at /', async () => {
    render(await Page({ params: Promise.resolve({}) }))
    expect(screen.getByText('Welcome')).toBeTruthy()
  })

  it('no published home page (fresh upgrade): / redirects to the ERP', async () => {
    delete pages['']
    await expect(Page({ params: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT /app')
  })

  it('404s an unknown slug', async () => {
    await expect(Page({ params: Promise.resolve({ slug: ['nope'] }) })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('404s more than two segments', async () => {
    await expect(Page({ params: Promise.resolve({ slug: ['products', '1', 'x'] }) })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('metadata comes from the page', async () => {
    expect((await generateMetadata({ params: Promise.resolve({ slug: ['products'] }) })).title).toBe('Products')
  })
})
