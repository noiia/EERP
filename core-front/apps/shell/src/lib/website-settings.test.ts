import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiRequestMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return { ...actual, apiRequest: (...a: unknown[]) => apiRequestMock(...a) }
})
const revalidateTag = vi.fn()
vi.mock('next/cache', () => ({ revalidateTag: (...a: unknown[]) => revalidateTag(...a) }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'erp.acme.fr' }),
}))

import { ApiError } from '@eerp/core-front/server'
import {
  getLegal,
  getPublished,
  getRobotsExtra,
  getRouting,
  getSecurityTxt,
  getWebsiteLocalization,
  listOutbox,
  listWebsiteUsers,
  previewSiteFile,
  retryOutbox,
  saveLegal,
  savePublished,
  saveRobotsExtra,
  saveRouting,
  saveSecurityTxt,
  saveWebsiteLocalization,
  updateWebsiteUser,
} from './website-settings'

beforeEach(() => {
  apiRequestMock.mockReset()
  revalidateTag.mockReset()
})

describe('website-settings actions', () => {
  it('saveRouting PUTs with the browser Host in X-EERP-Request-Host', async () => {
    apiRequestMock.mockResolvedValue(undefined)
    const r = { mode: 'host' as const, site_host: 'www.acme.fr', erp_host: 'erp.acme.fr' }
    await expect(saveRouting(r)).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/settings/website/routing', r, {
      'X-EERP-Request-Host': 'erp.acme.fr',
    })
  })

  it('returns Go\'s message on a rejected save', async () => {
    apiRequestMock.mockImplementation(() =>
      Promise.reject(new ApiError({ code: 'BAD', message: 'nope', status: 400 })),
    )
    await expect(saveRouting({ mode: 'path', site_host: '', erp_host: '' })).resolves.toEqual({
      ok: false,
      message: 'nope',
    })
  })

  it('an unexpected failure returns an empty message (the form translates its fallback)', async () => {
    apiRequestMock.mockImplementation(() => Promise.reject(new Error('boom')))
    await expect(saveRouting({ mode: 'path', site_host: '', erp_host: '' })).resolves.toEqual({ ok: false, message: '' })
  })

  it('savePublished expires the site caches immediately, only on success', async () => {
    apiRequestMock.mockResolvedValue(undefined)
    await savePublished('product', { fields: [], filter: {} })
    expect(revalidateTag).toHaveBeenCalledWith('product', { expire: 0 })
    expect(revalidateTag).toHaveBeenCalledWith('website_page', { expire: 0 })

    revalidateTag.mockReset()
    apiRequestMock.mockImplementation(() => Promise.reject(new Error('boom')))
    await savePublished('product', { fields: [], filter: {} })
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('reads and writes published data and users', async () => {
    apiRequestMock.mockResolvedValue([])
    await getPublished()
    expect(apiRequestMock).toHaveBeenLastCalledWith('GET', '/settings/website/public')
    await getRouting()
    expect(apiRequestMock).toHaveBeenLastCalledWith('GET', '/settings/website/routing')
    await listWebsiteUsers()
    expect(apiRequestMock).toHaveBeenLastCalledWith('GET', '/website_admin/users')
    await savePublished('product', { fields: ['name'], filter: { active: 'true' } })
    expect(apiRequestMock).toHaveBeenLastCalledWith('PUT', '/settings/website/public/product', {
      fields: ['name'],
      filter: { active: 'true' },
    })
    await updateWebsiteUser('u1', { disabled: true })
    expect(apiRequestMock).toHaveBeenLastCalledWith('PUT', '/website_admin/users/u1', { disabled: true })
  })
})

describe('outbox, site files and localization', () => {
  const rejected = () => apiRequestMock.mockRejectedValue(new ApiError({ code: 'BAD_REQUEST', message: 'nope', status: 400 }))

  it('lists the outbox, filtered by status, and empty on a failure', async () => {
    apiRequestMock.mockResolvedValueOnce({ data: [{ id: 'm1' }] })
    expect(await listOutbox('failed')).toEqual([{ id: 'm1' }])
    expect(apiRequestMock).toHaveBeenLastCalledWith('GET', '/mail_outbox?page_size=200&status=failed')
    apiRequestMock.mockResolvedValueOnce({})
    expect(await listOutbox()).toEqual([])
    expect(apiRequestMock).toHaveBeenLastCalledWith('GET', '/mail_outbox?page_size=200')
    rejected()
    expect(await listOutbox()).toEqual([])
  })

  it('retries an outbox row, returning Go\'s refusal', async () => {
    apiRequestMock.mockResolvedValueOnce(undefined)
    expect(await retryOutbox('a/b')).toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenLastCalledWith('POST', '/mail_outbox/a%2Fb/retry')
    rejected()
    expect(await retryOutbox('x')).toEqual({ ok: false, message: 'nope' })
  })

  it('reads the legal notice over empty defaults; saving expires the site copy only on success', async () => {
    apiRequestMock.mockResolvedValueOnce({ company_name: 'Acme' })
    const legal = await getLegal()
    expect(legal.company_name).toBe('Acme')
    expect(legal.host_name).toBe('')
    rejected()
    expect((await getLegal()).company_name).toBe('')
    expect(await saveLegal(legal)).toEqual({ ok: false, message: 'nope' })
    expect(revalidateTag).not.toHaveBeenCalled()
    apiRequestMock.mockReset().mockResolvedValue(undefined)
    expect(await saveLegal(legal)).toEqual({ ok: true })
    expect(revalidateTag).toHaveBeenCalledWith('site_legal', { expire: 0 })
  })

  it('reads security.txt with a contacts list always present, and saves it', async () => {
    apiRequestMock.mockResolvedValueOnce({ expires: '2027-01-01T00:00:00Z' })
    expect(await getSecurityTxt()).toMatchObject({ contacts: [], expires: '2027-01-01T00:00:00Z', policy: '' })
    rejected()
    expect((await getSecurityTxt()).contacts).toEqual([])
    apiRequestMock.mockReset().mockResolvedValue(undefined)
    const s = { contacts: ['mailto:a@b.io'], expires: 'x', policy: '', acknowledgments: '', encryption: '', preferred_languages: '' }
    expect(await saveSecurityTxt(s)).toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenLastCalledWith('PUT', '/settings/website/security', s)
  })

  it('reads and saves the extra robots.txt lines', async () => {
    apiRequestMock.mockResolvedValueOnce({ extra: 'Disallow: /x' })
    expect(await getRobotsExtra()).toBe('Disallow: /x')
    apiRequestMock.mockResolvedValueOnce({})
    expect(await getRobotsExtra()).toBe('')
    rejected()
    expect(await getRobotsExtra()).toBe('')
    apiRequestMock.mockReset().mockResolvedValue(undefined)
    expect(await saveRobotsExtra('Disallow: /y')).toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenLastCalledWith('PUT', '/settings/website/robots', { extra: 'Disallow: /y' })
  })

  it('previews a site file from Go\'s public route, robots.txt for this host', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('API_BASE', 'http://go')
    try {
      fetchMock.mockResolvedValueOnce(new Response('User-agent: *'))
      expect(await previewSiteFile('robots.txt')).toBe('User-agent: *')
      expect(fetchMock.mock.calls[0][0]).toBe('http://go/api/v1/public/robots.txt?host=erp.acme.fr')
      fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
      expect(await previewSiteFile('security.txt')).toBe('')
      expect(fetchMock.mock.calls[1][0]).toBe('http://go/api/v1/public/security.txt')
      fetchMock.mockRejectedValueOnce(new Error('down'))
      expect(await previewSiteFile('security.txt')).toBe('')
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it('reads the website localization over empty defaults; saving expires the site copy only on success', async () => {
    apiRequestMock.mockResolvedValueOnce({ base: 'EUR', currencies: ['USD'] })
    expect(await getWebsiteLocalization()).toMatchObject({ base: 'EUR', currencies: ['USD'], overrides: {}, live: {} })
    rejected()
    expect((await getWebsiteLocalization()).base).toBe('')
    const l = { default_locale: 'fr', default_currency: 'EUR', currencies: [], overrides: {} }
    expect((await saveWebsiteLocalization(l)).ok).toBe(false)
    expect(revalidateTag).not.toHaveBeenCalled()
    apiRequestMock.mockReset().mockResolvedValue(undefined)
    expect(await saveWebsiteLocalization(l)).toEqual({ ok: true })
    expect(revalidateTag).toHaveBeenCalledWith('site_localization', { expire: 0 })
  })
})
