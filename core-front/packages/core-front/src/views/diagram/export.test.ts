import { beforeEach, describe, expect, it, vi } from 'vitest'

const pdf = vi.hoisted(() => ({ addImage: vi.fn(), text: vi.fn(), save: vi.fn(), rect: vi.fn(), getTextWidth: vi.fn(() => 10), setFillColor: vi.fn() }))
vi.mock('html-to-image', () => ({ toPng: vi.fn(async () => 'data:image/png;base64,AAA') }))
vi.mock('jspdf', () => ({
  jsPDF: vi.fn(function () {
    return { ...pdf, internal: { pageSize: { getWidth: () => 420, getHeight: () => 297 } } }
  }),
}))

import { toPng } from 'html-to-image'
import { diagramToPng, exportPdf, exportPng, pdfColor, pdfFormat } from './export'

const bounds = { x: 10, y: 20, width: 800, height: 400 }

beforeEach(() => vi.clearAllMocks())

describe('pdfFormat', () => {
  it('picks a4 or a3', () => {
    expect(pdfFormat(1000, 800)).toBe('a4')
    expect(pdfFormat(2300, 1000)).toBe('a3')
    expect(pdfFormat(3100, 3000)).toBe('a3')
  })
})

describe('diagramToPng', () => {
  it('renders the viewport at pixelRatio 2', async () => {
    const el = document.createElement('div')
    expect(await diagramToPng(el, bounds)).toBe('data:image/png;base64,AAA')
    expect(vi.mocked(toPng).mock.calls[0][1]).toMatchObject({ pixelRatio: 2 })
  })

  it('drops to pixelRatio 1 past the canvas size limit', async () => {
    const el = document.createElement('div')
    await diagramToPng(el, { x: 0, y: 0, width: 9000, height: 400 })
    await diagramToPng(el, { x: 0, y: 0, width: 400, height: 9000 })
    expect(vi.mocked(toPng).mock.calls.map((c) => c[1]?.pixelRatio)).toEqual([1, 1])
  })
})

describe('pdfColor', () => {
  it('turns CSS colors jsPDF refuses into hex, blending alpha over white', () => {
    expect(pdfColor('#ff0000')).toBe('#ff0000')
    expect(pdfColor('rgb(255, 0, 0)')).toBe('#ff0000')
    expect(pdfColor('rgba(255, 255, 255, 0.3)')).toBe('#ffffff')
    expect(pdfColor('rgba(0, 0, 0, 0.26)')).toBe('#bdbdbd')
  })
})

describe('export background', () => {
  it('paints the image with the given background (dark theme text stays readable)', async () => {
    await diagramToPng(document.createElement('div'), bounds, '#121212')
    expect(vi.mocked(toPng).mock.calls[0][1]).toMatchObject({ backgroundColor: '#121212' })
  })
})

describe('exportPng', () => {
  it('downloads <filename>.png', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await exportPng(document.createElement('div'), bounds, 'wbs')
    expect(click).toHaveBeenCalledOnce()
    click.mockRestore()
  })
})

describe('exportPdf', () => {
  it('writes title, date, image and legend, saved as <filename>.pdf', async () => {
    await exportPdf(
      document.createElement('div'),
      bounds,
      { title: 'Plan', date: new Date(2026, 10, 12), legend: [{ color: '#ff0000', label: 'Critical' }, { color: 'rgba(0, 0, 0, 0.26)', label: 'Closed' }] },
      'plan',
    )
    expect(pdf.addImage).toHaveBeenCalledOnce()
    expect(pdf.text.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['Plan', new Date(2026, 10, 12).toLocaleDateString(), 'Critical']),
    )
    expect(pdf.setFillColor.mock.calls.map((c) => c[0])).toEqual(['#ff0000', '#bdbdbd'])
    expect(pdf.save).toHaveBeenCalledWith('plan.pdf')
  })
})
