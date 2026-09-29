import { describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  codeFromStatus,
  parseError,
  settleAction,
  unwrapActionResult,
  unwrapActions,
} from './errors'

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

  it('reads a validation error whose envelope also nests a fields array', async () => {
    // core/orm's generic CRUD create/update (orm/internal/handler/generic_handler.go)
    // used to respond with error as a bare string, which this function never read —
    // the message silently fell back to the status text. Now it matches every other
    // handler's {error:{code,message,request_id}} shape, plus a fields array.
    const err = await parseError(
      jsonResponse(422, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'missing required fields: name, price_cents',
          request_id: '01J-def',
          fields: ['name', 'price_cents'],
        },
      }),
    )
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.message).toBe('missing required fields: name, price_cents')
    expect(err.requestId).toBe('01J-def')
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

describe('parseError fields', () => {
  it('keeps the missing field names a VALIDATION_ERROR carries', async () => {
    const err = await parseError(
      jsonResponse(422, {
        error: { code: 'VALIDATION_ERROR', message: 'missing', request_id: 'r1', fields: ['issuer_name', 7] },
      }),
    )
    expect(err.fields).toEqual(['issuer_name'])
  })
})

describe('Server Action boundary', () => {
  it('round-trips an ApiError as a value, then throws it back on the client', async () => {
    const settled = await settleAction(async () => {
      throw new ApiError({ code: 'VALIDATION_ERROR', message: 'm', status: 422, requestId: 'r1', fields: ['a'] })
    })
    // Survives serialization, like a real Server Action result.
    const wire = JSON.parse(JSON.stringify(settled)) as unknown
    expect(() => unwrapActionResult(wire)).toThrow(ApiError)
    try {
      unwrapActionResult(wire)
    } catch (e) {
      expect(e).toMatchObject({ code: 'VALIDATION_ERROR', message: 'm', status: 422, requestId: 'r1', fields: ['a'] })
    }
  })

  it('hides a non-ApiError message behind a generic INTERNAL_ERROR', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const settled = await settleAction(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.3:8080')
    })
    spy.mockRestore()
    expect(() => unwrapActionResult(settled)).toThrow(/contact your administrator/)
  })

  it('passes successful values through untouched', async () => {
    const value = { id: '1', ok: false }
    expect(unwrapActionResult(await settleAction(async () => value))).toBe(value)
  })

  it('unwrapActions wraps every function, async or not, and leaves other members alone', async () => {
    const settledError = await settleAction(async () => {
      throw new ApiError({ code: 'NOT_FOUND', message: 'gone', status: 404 })
    })
    const actions = unwrapActions({
      ok: async (n: number) => n + 1,
      fails: async () => settledError,
      sync: () => 'plain',
      label: 'kept',
    })
    await expect(actions.ok(1)).resolves.toBe(2)
    await expect(actions.fails()).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'gone' })
    expect(actions.sync()).toBe('plain')
    expect(actions.label).toBe('kept')
  })
})
