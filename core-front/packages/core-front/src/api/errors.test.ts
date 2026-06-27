import { describe, expect, it } from 'vitest'
import { ApiError, codeFromStatus, parseError } from './errors'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('codeFromStatus', () => {
  it('maps documented statuses', () => {
    expect(codeFromStatus(400)).toBe('VALIDATION_ERROR')
    expect(codeFromStatus(401)).toBe('UNAUTHENTICATED')
    expect(codeFromStatus(403)).toBe('FORBIDDEN')
    expect(codeFromStatus(404)).toBe('NOT_FOUND')
    expect(codeFromStatus(409)).toBe('CONFLICT')
  })

  it('falls back to INTERNAL_ERROR for unmapped statuses', () => {
    expect(codeFromStatus(500)).toBe('INTERNAL_ERROR')
    expect(codeFromStatus(503)).toBe('INTERNAL_ERROR')
  })
})

describe('parseError', () => {
  it('reads the {error:{...}} envelope including request_id', async () => {
    const err = await parseError(
      jsonResponse(404, {
        error: { code: 'CONTACT_NOT_FOUND', message: 'no such contact', request_id: '01J-abc' },
      }),
    )
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('CONTACT_NOT_FOUND')
    expect(err.message).toBe('no such contact')
    expect(err.requestId).toBe('01J-abc')
    expect(err.status).toBe(404)
  })

  it('synthesizes the code from status when the body is not the envelope', async () => {
    const err = await parseError(jsonResponse(500, { unexpected: true }))
    expect(err.code).toBe('INTERNAL_ERROR')
    expect(err.status).toBe(500)
    expect(err.requestId).toBeUndefined()
  })

  it('tolerates a non-JSON body', async () => {
    const err = await parseError(new Response('not json', { status: 502 }))
    expect(err.code).toBe('INTERNAL_ERROR')
    expect(err.status).toBe(502)
  })
})
