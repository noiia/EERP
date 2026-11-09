import { afterEach, describe, expect, it, vi } from 'vitest'
import { listFiles, TeamsApiError, listMessages, postMessage, setShares } from './client'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
afterEach(() => fetchMock.mockReset())

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('teams client', () => {
  it('posts files as multipart with repeated mentions/files', async () => {
    fetchMock.mockImplementation(async () => ok({ id: 'm' }))
    const f1 = new File(['a'], 'a.txt')
    const f2 = new File(['b'], 'b.txt')
    await postMessage('c1', 'hi', ['u1', 'u2'], [f1, f2])
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/teams/channels/c1/messages')
    const form = init.body as FormData
    expect(form.get('body')).toBe('hi')
    expect(form.getAll('mentions')).toEqual(['u1', 'u2'])
    expect(form.getAll('files')).toHaveLength(2)
    expect(init.headers).toBeUndefined()
  })

  it('posts JSON without files, unwraps lists, builds the query', async () => {
    fetchMock.mockImplementation(async () => ok({ data: [{ id: 'm' }], total: 1 }))
    await postMessage('c1', 'hi')
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ body: 'hi', mentions: [] })
    await expect(listMessages('c1', '2026-01-01T00:00:00Z', 20)).resolves.toEqual([{ id: 'm' }])
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/teams/channels/c1/messages?before=2026-01-01T00%3A00%3A00Z&limit=20')
    fetchMock.mockImplementation(async () => ok({ data: [], total: 0 }))
    await expect(setShares('f', ['u'])).resolves.toEqual([])
  })

  it('throws the Go error message', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Nope.' } }), { status: 403 }))
    await expect(postMessage('c1', 'x')).rejects.toThrow('Nope.')
  })

  it('throws an error carrying the HTTP status, even with no error body or statusText', async () => {
    fetchMock.mockImplementation(async () => new Response('{"message":"Not Found"}', { status: 404 }))
    await expect(listFiles('t1')).rejects.toMatchObject({ status: 404 })
    await expect(listFiles('t1')).rejects.toBeInstanceOf(TeamsApiError)
    await expect(listFiles('t1')).rejects.toMatchObject({ code: undefined })
  })

  it('carries the Go error code', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No such folder.' } }), { status: 404 }))
    await expect(listFiles('t1', 'f9')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'No such folder.' })
  })
})
