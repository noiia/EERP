import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportReportPDF } from './report-export'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('exportReportPDF', () => {
  it('POSTs to the BFF route and opens the returned download_url', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ download_url: '/api/reports/pdf?key=x' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const openMock = vi.fn()
    vi.stubGlobal('open', openMock)

    await exportReportPDF('sale.invoice', 'r1')

    expect(fetchMock).toHaveBeenCalledWith('/api/reports/sale.invoice/r1', { method: 'POST' })
    expect(openMock).toHaveBeenCalledWith('/api/reports/pdf?key=x', '_blank')
  })

  it('throws when the BFF route fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 502 })))
    await expect(exportReportPDF('sale.invoice', 'r1')).rejects.toThrow('export failed')
  })
})
