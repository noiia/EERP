import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './errors'
import { createPictureClient, type PictureAnchor, type PictureMeta } from './pictures-client'

const meta: PictureMeta = {
  id: 'p1',
  table_name: 'contact',
  record_id: 'r1',
  field: 'photo',
  mime: 'image/png',
  size: 3,
}
const anchor: PictureAnchor = { table: 'contact', recordId: 'r1', field: 'photo' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function envelope(code: string, status: number): Response {
  return jsonResponse({ error: { code, message: 'nope', request_id: 'req-1' } }, status)
}

describe('createPictureClient', () => {
  it('find resolves the anchor through the BFF query route', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(meta))
    const client = createPictureClient(fetchImpl)

    await expect(client.find(anchor)).resolves.toEqual(meta)
    expect(fetchImpl).toHaveBeenCalledWith('/api/pictures?table=contact&record=r1&field=photo')
  })

  it('find treats 404 as the empty state, not an error', async () => {
    const client = createPictureClient(vi.fn(async () => envelope('NOT_FOUND', 404)))
    await expect(client.find(anchor)).resolves.toBeNull()
  })

  it('find surfaces other failures as ApiError', async () => {
    const client = createPictureClient(vi.fn(async () => envelope('FORBIDDEN', 403)))
    await expect(client.find(anchor)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it('upload posts a multipart form carrying the anchor and the file', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(meta, 201))
    const client = createPictureClient(fetchImpl)
    const file = new Blob(['png'], { type: 'image/png' })

    await expect(client.upload(anchor, file, 'signature.png')).resolves.toEqual(meta)

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/pictures')
    expect(init.method).toBe('POST')
    const form = init.body as FormData
    expect(form.get('table_name')).toBe('contact')
    expect(form.get('record_id')).toBe('r1')
    expect(form.get('field')).toBe('photo')
    expect((form.get('file') as File).name).toBe('signature.png')
  })

  it('upload surfaces the backend envelope as ApiError', async () => {
    const client = createPictureClient(vi.fn(async () => envelope('VALIDATION_ERROR', 400)))
    await expect(client.upload(anchor, new Blob(['x']))).rejects.toBeInstanceOf(ApiError)
  })

  it('remove deletes by id and throws on failure', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const client = createPictureClient(fetchImpl)
    await client.remove('p1')
    expect(fetchImpl).toHaveBeenCalledWith('/api/pictures/p1', { method: 'DELETE' })

    const failing = createPictureClient(vi.fn(async () => envelope('NOT_FOUND', 404)))
    await expect(failing.remove('p1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('url points at the BFF stream route', () => {
    expect(createPictureClient(vi.fn()).url('p1')).toBe('/api/pictures/p1')
  })
})
