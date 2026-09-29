import { describe, expect, it } from 'vitest'
import websiteModule from './WebsiteViews'

describe('website views', () => {
  it('registers the pages list and form with a Design button', () => {
    expect(websiteModule.name).toBe('website')
    const paths = websiteModule.routes.map((r) => r.path)
    expect(paths).toEqual(expect.arrayContaining(['/website', '/website/pages', '/website/pages/:id']))
    const form = websiteModule.routes.find((r) => r.path === '/website/pages/:id')!.descriptor
    expect(form.entity).toBe('website_page')
    expect(form.headerButtons?.map((b) => b.name)).toContain('website.design')
    expect(form.fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(['title', 'slug', 'published', 'in_menu', 'menu_sequence', 'seo_description']),
    )
  })
})
