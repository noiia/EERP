import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@eerp/core-front/server'

const streamCronHistoryLog = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eerp/core-front/server')>()),
  streamCronHistoryLog: (...args: unknown[]) => streamCronHistoryLog(...args),
}))

import { GET } from './route'

const ctx = { params: Promise.resolve({ id: 'h1' }) }

describe('GET /api/cron-history/[id]/log', () => {
  it('streams the log as a download, defaulting type and disposition', async () => {
    // A raw byte body carries no Content-Type, so the route's default applies.
    streamCronHistoryLog.mockResolvedValue(new Response(new TextEncoder().encode('line 1\n')))
    const res = await GET(new Request('http://localhost/api/cron-history/h1/log'), ctx)
    expect(streamCronHistoryLog).toHaveBeenCalledWith('h1')
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe('attachment')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(res.text()).resolves.toBe('line 1\n')
  })

  it('maps a Go error envelope to its status', async () => {
    streamCronHistoryLog.mockRejectedValue(
      new ApiError({ code: 'NOT_FOUND', message: 'gone', status: 404 }),
    )
    expect((await GET(new Request('http://localhost/api/cron-history/h1/log'), ctx)).status).toBe(
      404,
    )
  })
})
