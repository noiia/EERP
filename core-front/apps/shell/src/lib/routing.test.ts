import { describe, expect, it } from 'vitest'
import { routeDecision } from './routing'

const erpRoots = new Set(['crm', 'settings', 'invoice', 'contacts'])
// A published site page whose slug collides with an ERP root: the site wins.
const siteSlugs = new Set(['contacts', 'products'])
const path = { mode: 'path' as const }

describe('routeDecision — path mode', () => {
  it.each([
    ['/', { kind: 'next' }],
    ['/products', { kind: 'next' }],
    ['/app/crm/42', { kind: 'next' }],
    // Review Focus #3: old ERP bookmarks keep working.
    ['/crm/42', { kind: 'redirect', location: '/app/crm/42' }],
    ['/settings/users', { kind: 'redirect', location: '/app/settings/users' }],
    ['/api/v1/public/site', { kind: 'next' }],
    ['/print/report/x/1', { kind: 'next' }],
    // Published slug equal to an ERP root: served by the site, not 308'd.
    ['/contacts', { kind: 'next' }],
  ])('%s', (pathname, want) => {
    expect(routeDecision({ pathname, host: 'localhost', erpRoots, siteSlugs, routing: path })).toEqual(want)
  })
})

describe('routeDecision — host mode', () => {
  const routing = { mode: 'host' as const, site_host: 'www.acme.fr', erp_host: 'erp.acme.fr' }
  it.each([
    ['www.acme.fr', '/', { kind: 'next' }],
    ['www.acme.fr', '/products', { kind: 'next' }],
    ['www.acme.fr', '/app/crm', { kind: 'redirect', location: 'https://erp.acme.fr/app/crm' }],
    ['www.acme.fr', '/crm/1', { kind: 'redirect', location: 'https://erp.acme.fr/app/crm/1' }],
    ['www.acme.fr', '/contacts', { kind: 'next' }], // published slug wins over the ERP root
    ['WWW.ACME.FR:443', '/contacts', { kind: 'next' }],
    ['erp.acme.fr', '/', { kind: 'redirect', location: '/app' }],
    ['erp.acme.fr', '/app/crm', { kind: 'next' }],
    ['erp.acme.fr', '/products', { kind: 'redirect', location: 'https://www.acme.fr/products' }],
    ['erp.acme.fr', '/contacts', { kind: 'redirect', location: 'https://www.acme.fr/contacts' }],
    ['erp.acme.fr', '/api/v1/public/site', { kind: 'next' }],
    ['erp.acme.fr:443', '/app', { kind: 'next' }],
    // Unknown host (IP, localhost): behave like path mode so admins are never locked out.
    ['10.0.0.5', '/app/crm', { kind: 'next' }],
    ['10.0.0.5', '/', { kind: 'next' }],
    ['10.0.0.5', '/crm/1', { kind: 'redirect', location: '/app/crm/1' }],
  ])('%s %s', (host, pathname, want) => {
    expect(routeDecision({ pathname, host, erpRoots, siteSlugs, routing })).toEqual(want)
  })

  it('an incomplete host config falls back to path mode', () => {
    expect(routeDecision({ pathname: '/crm', host: 'www.acme.fr', erpRoots, siteSlugs, routing: { mode: 'host', site_host: 'www.acme.fr' } }))
      .toEqual({ kind: 'redirect', location: '/app/crm' })
  })
})
