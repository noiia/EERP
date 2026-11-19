import { afterEach, describe, expect, it, vi } from 'vitest'
import { officeSession } from '@eerp/core-front/server'
import { GET } from './route'

vi.mock('@eerp/core-front/server', () => ({ officeSession: vi.fn() }))
afterEach(() => vi.clearAllMocks())
const id = 'f9dfe723-2e2d-45e0-9cec-aa51cf36d83c'
const context = (source = 'team-file', file = id) => ({
  params: Promise.resolve({ source, id: file }),
})

describe('Office session BFF', () => {
  it.each(['team-file', 'team-attachment', 'attachment'])(
    'requests a %s session through the authenticated API client',
    async (source) => {
      vi.mocked(officeSession).mockResolvedValue(new Response('{"editable":false}'))
      const response = await GET(
        new Request(`http://local/api/office/${source}/${id}/session?lang=fr`),
        context(source),
      )
      expect(officeSession).toHaveBeenCalledWith(source, id, 'fr')
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(await response.json()).toEqual({ editable: false })
    },
  )

  it.each([
    ['unexpected', id],
    ['team-file', '../secret'],
    ['team-file', 'not-an-id'],
  ])('rejects invalid references without calling Go', async (source, file) => {
    const response = await GET(
      new Request('http://local/api/office/session'),
      context(source, file),
    )
    expect(response.status).toBe(404)
    expect(officeSession).not.toHaveBeenCalled()
  })

  it('preserves the service-unavailable error and avoids caching it', async () => {
    vi.mocked(officeSession).mockResolvedValue(
      new Response('{"error":{"code":"OFFICE_UNAVAILABLE"}}', { status: 503 }),
    )
    const response = await GET(new Request('http://local/api/office/session'), context())
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: { code: 'OFFICE_UNAVAILABLE' } })
  })
})
