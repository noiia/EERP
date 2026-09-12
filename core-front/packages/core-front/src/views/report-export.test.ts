import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportReportPDF, fetchReportPDF } from './report-export'

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

describe('fetchReportPDF', () => {
  it('POSTs, then GETs the download_url, returning the PDF bytes', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/reports/propertymanagement.rentReceipt/r1') {
        return new Response(JSON.stringify({ download_url: '/api/reports/pdf?key=x' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('%PDF-1.4', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const blob = await fetchReportPDF('propertymanagement.rentReceipt', 'r1')

    expect(fetchMock).toHaveBeenCalledWith('/api/reports/propertymanagement.rentReceipt/r1', { method: 'POST' })
    expect(fetchMock).toHaveBeenCalledWith('/api/reports/pdf?key=x')
    expect(await blob.text()).toBe('%PDF-1.4')
  })

  it('throws when the generation POST fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 502 })))
    await expect(fetchReportPDF('sale.invoice', 'r1')).rejects.toThrow('export failed')
  })

  it('throws when the download GET fails', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith('/api/reports/pdf')
        ? new Response(null, { status: 502 })
        : new Response(JSON.stringify({ download_url: '/api/reports/pdf?key=x' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchReportPDF('sale.invoice', 'r1')).rejects.toThrow('report download failed')
  })
})
