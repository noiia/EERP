import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@eerp/core-front/server'

// The small Settings Server Actions all share one shape: a read that degrades to
// a fallback, and writes that map Go's error envelope to { ok:false, message }.

const apiRequestMock = vi.fn()
const createMock = vi.fn()
const listMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => apiRequestMock(...args),
    createServerApiClient: () => ({ create: createMock, list: listMock }),
  }
})
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'erp.test' }), cookies: async () => ({ get: () => undefined }) }))
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }))

import { createMyEventFeed, getEventSettings, getMyEventFeed, revokeMyEventFeed, saveEventSettings } from './event-settings'
import { getMailTemplates, resetMailTemplate, saveMailTemplate } from './mail-templates'
import { getStripeStatus, saveStripeSettings } from './stripe-settings'
import { activeModuleNames } from './module-state'
import { listOutbox, retryOutbox } from './website-settings'
import { setUsernameAtFormat } from './preferences'
import { createPageFormatForCompany } from './report-settings'

const goError = new ApiError({ code: 'FORBIDDEN', message: 'nope', status: 403 })

beforeEach(() => {
  apiRequestMock.mockReset()
  createMock.mockReset()
  listMock.mockReset()
})

describe('event settings', () => {
  it('reads, saves and degrades', async () => {
    apiRequestMock.mockResolvedValueOnce({ reminder_hours: 24, waitlist_claim_hours: 12 })
    expect(await getEventSettings()).toEqual({ reminder_hours: 24, waitlist_claim_hours: 12 })
    apiRequestMock.mockRejectedValueOnce(goError)
    expect(await getEventSettings()).toBeNull()

    apiRequestMock.mockResolvedValueOnce(undefined)
    expect(await saveEventSettings({ reminder_hours: 2, waitlist_claim_hours: 1 })).toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenLastCalledWith('PUT', '/settings/events', { reminder_hours: 2, waitlist_claim_hours: 1 })
    apiRequestMock.mockRejectedValueOnce(goError)
    expect(await saveEventSettings({ reminder_hours: 2, waitlist_claim_hours: 1 })).toEqual({ ok: false, message: 'nope' })
    apiRequestMock.mockRejectedValueOnce(new Error('boom'))
    expect(await saveEventSettings({ reminder_hours: 2, waitlist_claim_hours: 1 })).toEqual({ ok: false, message: '' })
  })

  it('manages the staff calendar feed', async () => {
    apiRequestMock.mockResolvedValueOnce({ enabled: true })
    expect(await getMyEventFeed()).toEqual({ enabled: true })
    apiRequestMock.mockRejectedValueOnce(goError)
    expect(await getMyEventFeed()).toBeNull()

    apiRequestMock.mockResolvedValueOnce({ path: '/api/v1/calendar/t.ics' })
    expect(await createMyEventFeed()).toEqual({ ok: true, path: '/api/v1/calendar/t.ics' })
    apiRequestMock.mockRejectedValueOnce(goError)
    expect(await createMyEventFeed()).toEqual({ ok: false, message: 'nope' })
    apiRequestMock.mockRejectedValueOnce(new Error('x'))
    expect(await createMyEventFeed()).toEqual({ ok: false, message: '' })

    apiRequestMock.mockResolvedValueOnce(undefined)
    expect(await revokeMyEventFeed()).toBe(true)
    apiRequestMock.mockRejectedValueOnce(goError)
    expect(await revokeMyEventFeed()).toBe(false)
  })
})

describe('mail templates', () => {
  it('lists, saves and resets with url-encoded keys', async () => {
    apiRequestMock.mockResolvedValueOnce({ data: [{ key: 'k' }] })
    expect(await getMailTemplates()).toEqual([{ key: 'k' }])
    apiRequestMock.mockResolvedValueOnce({})
    expect(await getMailTemplates()).toEqual([])
    apiRequestMock.mockRejectedValueOnce(goError)
    expect(await getMailTemplates()).toEqual([])

    apiRequestMock.mockResolvedValueOnce(undefined)
    expect(await saveMailTemplate('event.booking confirmed', 'fr', { subject: 's', html: 'h' })).toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenLastCalledWith('PUT', '/settings/mail_templates/event.booking%20confirmed/fr', { subject: 's', html: 'h' })
    apiRequestMock.mockRejectedValueOnce(goError)
    expect(await resetMailTemplate('k', 'fr')).toEqual({ ok: false, message: 'nope' })
    expect(apiRequestMock).toHaveBeenLastCalledWith('DELETE', '/settings/mail_templates/k/fr')
    apiRequestMock.mockRejectedValueOnce(new Error('x'))
    expect(await resetMailTemplate('k', 'fr')).toEqual({ ok: false, message: '' })
  })
})

describe('stripe settings', () => {
  it('reads and saves', async () => {
    apiRequestMock.mockResolvedValueOnce({ enabled: true })
    expect(await getStripeStatus()).toEqual({ enabled: true })
    apiRequestMock.mockRejectedValueOnce(goError)
    expect(await getStripeStatus()).toBeNull()
    const s = { enabled: true, secret_key: 'sk', webhook_secret: '' }
    apiRequestMock.mockResolvedValueOnce(undefined)
    expect(await saveStripeSettings(s)).toEqual({ ok: true })
    apiRequestMock.mockRejectedValueOnce(goError)
    expect(await saveStripeSettings(s)).toEqual({ ok: false, message: 'nope' })
    apiRequestMock.mockRejectedValueOnce(new Error('x'))
    expect(await saveStripeSettings(s)).toEqual({ ok: false, message: '' })
  })
})

describe('activeModuleNames', () => {
  it('keeps only active modules and always includes the App Store', async () => {
    listMock.mockResolvedValue([{ name: 'crm', active: true }, { name: 'sale', active: false }])
    expect([...(await activeModuleNames())].sort()).toEqual(['appstore', 'crm'])
  })
})

describe('mail outbox', () => {
  it('lists by status and retries', async () => {
    apiRequestMock.mockResolvedValueOnce({ data: [{ id: 'm1' }] })
    expect(await listOutbox('failed')).toEqual([{ id: 'm1' }])
    expect(apiRequestMock).toHaveBeenLastCalledWith('GET', '/mail_outbox?page_size=200&status=failed')
    apiRequestMock.mockResolvedValueOnce({})
    expect(await listOutbox()).toEqual([])
    apiRequestMock.mockRejectedValueOnce(goError)
    expect(await listOutbox()).toEqual([])

    apiRequestMock.mockResolvedValueOnce(undefined)
    expect(await retryOutbox('m 1')).toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenLastCalledWith('POST', '/mail_outbox/m%201/retry')
    apiRequestMock.mockRejectedValueOnce(goError)
    expect(await retryOutbox('m1')).toEqual({ ok: false, message: 'nope' })
  })
})

describe('setUsernameAtFormat', () => {
  it('saves and maps failures', async () => {
    apiRequestMock.mockResolvedValueOnce(undefined)
    expect(await setUsernameAtFormat(true)).toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenLastCalledWith('PUT', '/settings/accounts', { username_at_format: true })
    apiRequestMock.mockRejectedValueOnce(goError)
    expect((await setUsernameAtFormat(false)).ok).toBe(false)
  })
})

describe('createPageFormatForCompany', () => {
  it('tags the row with the company', async () => {
    createMock.mockResolvedValue({ id: 'p1' })
    await createPageFormatForCompany('c1', { name: 'A4' })
    expect(createMock).toHaveBeenCalledWith('report_page_format', { name: 'A4', company_id: 'c1' })
  })
})
