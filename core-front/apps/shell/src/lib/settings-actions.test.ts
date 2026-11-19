import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@eerp/core-front/server'

const apiRequestMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return { ...actual, apiRequest: (...args: unknown[]) => apiRequestMock(...args) }
})

import { getTaxSettings, setTaxSettings } from './tax-settings'
import { getOSMConnector, setOSMConnector } from './osm-settings'
import { getEntityChatterVisibility, setEntityChatterVisibility } from './chatter-visibility'
import { getUnitSettings, setUnitSettings } from './unit-settings'

beforeEach(() => {
  apiRequestMock.mockReset()
})

const forbidden = () =>
  new ApiError({ code: 'FORBIDDEN', message: 'Missing permission', status: 403 })

// Every settings action shares one contract: reads degrade to a default instead
// of throwing, writes return { ok } / { ok:false, message } instead of throwing.
const cases = [
  {
    name: 'units',
    read: () => getUnitSettings(),
    readCall: ['GET', '/settings/units'],
    stored: { system: 'imperial' },
    fallback: { system: 'metric' },
    write: () => setUnitSettings({ system: 'imperial' }),
    writeCall: ['PUT', '/settings/units', { system: 'imperial' }],
    genericMessage: 'Could not save the unit system.',
  },
  {
    name: 'tax',
    read: () => getTaxSettings(),
    readCall: ['GET', '/settings/tax'],
    stored: { price_mode: 'tax_included' },
    fallback: { price_mode: 'tax_excluded' },
    write: () => setTaxSettings({ price_mode: 'tax_included' }),
    writeCall: ['PUT', '/settings/tax', { price_mode: 'tax_included' }],
    genericMessage: 'Could not save the tax price mode.',
  },
  {
    name: 'osm',
    read: () => getOSMConnector(),
    readCall: ['GET', '/settings/integrations/osm'],
    stored: { enabled: true, base_url: 'https://nominatim.test', user_agent: 'eerp' },
    fallback: { enabled: false, base_url: '', user_agent: '' },
    write: () => setOSMConnector({ enabled: true, base_url: 'https://n.test', user_agent: 'eerp' }),
    writeCall: [
      'PUT',
      '/settings/integrations/osm',
      { enabled: true, base_url: 'https://n.test', user_agent: 'eerp' },
    ],
    genericMessage: 'Could not save the OpenStreetMap connector.',
  },
  {
    name: 'chatter visibility',
    read: () => getEntityChatterVisibility('crm'),
    readCall: ['GET', '/settings/views/crm/chatter'],
    stored: { enabled: false },
    fallback: { enabled: null },
    write: () => setEntityChatterVisibility('crm', null),
    writeCall: ['PUT', '/settings/views/crm/chatter', { enabled: null }],
    genericMessage: 'Could not save the chatter visibility setting.',
  },
]

describe.each(cases)('$name settings actions', (c) => {
  it('reads the stored value', async () => {
    apiRequestMock.mockResolvedValue(c.stored)
    await expect(c.read()).resolves.toEqual(c.stored)
    expect(apiRequestMock).toHaveBeenCalledWith(...c.readCall)
  })

  it('degrades to the default when the read fails', async () => {
    apiRequestMock.mockRejectedValue(forbidden())
    await expect(c.read()).resolves.toEqual(c.fallback)
  })

  it('saves and reports ok', async () => {
    apiRequestMock.mockResolvedValue(undefined)
    await expect(c.write()).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith(...c.writeCall)
  })

  it('surfaces the Go envelope message on a failed save', async () => {
    apiRequestMock.mockRejectedValue(forbidden())
    await expect(c.write()).resolves.toEqual({ ok: false, message: 'Missing permission' })
  })

  it('falls back to a generic message on non-API failures', async () => {
    apiRequestMock.mockRejectedValue(new TypeError('fetch failed'))
    await expect(c.write()).resolves.toEqual({ ok: false, message: c.genericMessage })
  })
})
