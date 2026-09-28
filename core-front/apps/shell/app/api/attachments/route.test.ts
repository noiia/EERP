import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@eerp/core-front/server'

const server = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  findAttachment: vi.fn(),
  streamAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}))
vi.mock('@eerp/core-front/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eerp/core-front/server')>()),
  ...server,
}))

import { GET, POST } from './route'
import { DELETE, GET as GET_ONE } from './[id]/route'

const meta = {
  id: 'a1',
  table_name: 'invoice',
  record_id: 'r1',
  field: 'pdf',
  filename: 'x.pdf',
  mime: 'application/pdf',
  size: 3,
}
const ctx = { params: Promise.resolve({ id: 'a1' }) }
const denied = new ApiError({ code: 'FORBIDDEN', message: 'no', status: 403 })

beforeEach(() => {
  Object.values(server).forEach((m) => m.mockReset())
})

describe('/api/attachments', () => {
  it('POST forwards the multipart form and answers 201', async () => {
    server.uploadAttachment.mockResolvedValue(meta)
    const form = new FormData()
    form.set('file', new Blob(['pdf']), 'x.pdf')
    const res = await POST(
      new Request('http://localhost/api/attachments', { method: 'POST', body: form }),
    )
    expect(res.status).toBe(201)
    await expect(res.json()).resolves.toEqual(meta)
  })

  it('POST passes a Go error through', async () => {
    server.uploadAttachment.mockRejectedValue(denied)
    const res = await POST(
      new Request('http://localhost/api/attachments', { method: 'POST', body: new FormData() }),
    )
    expect(res.status).toBe(403)
  })

  it('GET looks the anchor up from the query string', async () => {
    server.findAttachment.mockResolvedValue(meta)
    const res = await GET(
      new Request('http://localhost/api/attachments?table=invoice&record=r1&field=pdf'),
    )
    expect(res.status).toBe(200)
    expect(server.findAttachment).toHaveBeenCalledWith({
      table: 'invoice',
      recordId: 'r1',
      field: 'pdf',
    })
  })

  it('GET answers 404 when the field holds nothing, and maps Go errors', async () => {
    server.findAttachment.mockResolvedValueOnce(null)
    expect((await GET(new Request('http://localhost/api/attachments'))).status).toBe(404)
    server.findAttachment.mockRejectedValueOnce(denied)
    expect((await GET(new Request('http://localhost/api/attachments'))).status).toBe(403)
  })
})

describe('/api/attachments/[id]', () => {
  it('GET streams the bytes with the upstream type and filename, never cached', async () => {
    server.streamAttachment.mockResolvedValue(
      new Response('pdf', {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="x.pdf"',
        },
      }),
    )
    const res = await GET_ONE(new Request('http://localhost/api/attachments/a1'), ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="x.pdf"')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(res.text()).resolves.toBe('pdf')
  })

  it('GET defaults the content type and omits a missing disposition', async () => {
    server.streamAttachment.mockResolvedValue(new Response('bytes'))
    const res = await GET_ONE(new Request('http://localhost/api/attachments/a1'), ctx)
    expect(res.headers.get('Content-Disposition')).toBeNull()
  })

  it('DELETE answers 204, and maps Go errors', async () => {
    server.deleteAttachment.mockResolvedValueOnce(undefined)
    expect((await DELETE(new Request('http://localhost/api/attachments/a1'), ctx)).status).toBe(204)
    expect(server.deleteAttachment).toHaveBeenCalledWith('a1')
    server.deleteAttachment.mockRejectedValueOnce(denied)
    expect((await DELETE(new Request('http://localhost/api/attachments/a1'), ctx)).status).toBe(403)
    server.streamAttachment.mockRejectedValueOnce(denied)
    expect((await GET_ONE(new Request('http://localhost/api/attachments/a1'), ctx)).status).toBe(
      403,
    )
  })
})
