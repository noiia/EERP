import { describe, expect, it } from 'vitest'
import { ApiError } from '@eerp/core-front/server'
import { errorResponse } from './route-errors'

describe('errorResponse', () => {
  it('passes a Go error envelope through with its own status', async () => {
    const res = errorResponse(
      new ApiError({ code: 'NOT_FOUND', message: 'gone', status: 404, requestId: 'rq1' }),
    )
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({
      error: { code: 'NOT_FOUND', message: 'gone', request_id: 'rq1' },
    })
  })

  it('rethrows anything else so Next reports a real 500', () => {
    const boom = new TypeError('fetch failed')
    expect(() => errorResponse(boom)).toThrow(boom)
  })
})
