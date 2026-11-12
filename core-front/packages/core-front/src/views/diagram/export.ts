import { getViewportForBounds } from '@xyflow/react'
import { toPng } from 'html-to-image'
import { jsPDF } from 'jspdf'

export interface DiagramBounds { x: number; y: number; width: number; height: number }
export interface LegendEntry { color: string; label: string }

const PAD = 40
// Browsers refuse canvases past about 16384 px a side: a huge diagram exports at 1×.
const MAX_CANVAS_SIDE = 16000
const WHITE = '#ffffff'
const size = (b: DiagramBounds) => ({ w: Math.ceil(b.width) + PAD * 2, h: Math.ceil(b.height) + PAD * 2 })

export function pdfFormat(width: number, height: number): 'a4' | 'a3' {
  return width / height > 2.2 || width > 3000 ? 'a3' : 'a4'
}

/** PNG data URL of the whole diagram (not just the visible part), via the xyflow export recipe;
 * at 2× unless that would pass the browsers' canvas size limit. */
export async function diagramToPng(viewport: HTMLElement, bounds: DiagramBounds, background = WHITE): Promise<string> {
  const { w, h } = size(bounds)
  const v = getViewportForBounds(bounds, w, h, 0.1, 4, 0.05)
  return toPng(viewport, {
    backgroundColor: background,
    width: w,
    height: h,
    pixelRatio: Math.max(w, h) * 2 > MAX_CANVAS_SIDE ? 1 : 2,
    style: { width: `${w}px`, height: `${h}px`, transform: `translate(${v.x}px, ${v.y}px) scale(${v.zoom})` },
  })
}

/** jsPDF only takes hex (or names): an `rgb()`/`rgba()` theme color becomes hex, its alpha blended over white. */
export function pdfColor(css: string): string {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(css.trim())
  if (!m) return css
  const a = m[4] === undefined ? 1 : Number(m[4])
  const hex = (c: string) => Math.round(Number(c) * a + 255 * (1 - a)).toString(16).padStart(2, '0')
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`
}

export async function exportPng(viewport: HTMLElement, bounds: DiagramBounds, filename: string, background?: string): Promise<void> {
  const a = document.createElement('a')
  a.download = `${filename}.png`
  a.href = await diagramToPng(viewport, bounds, background)
  a.click()
}

export async function exportPdf(
  viewport: HTMLElement,
  bounds: DiagramBounds,
  meta: { title: string; date: Date; legend: LegendEntry[]; background?: string },
  filename: string,
): Promise<void> {
  const { w, h } = size(bounds)
  const image = await diagramToPng(viewport, bounds, meta.background)
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: pdfFormat(w, h) })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const margin = 10
  const headerH = 14
  const legendH = 10
  doc.text(meta.title, margin, margin + 4)
  doc.text(meta.date.toLocaleDateString(), pageW - margin, margin + 4, { align: 'right' })
  const maxW = pageW - margin * 2
  const maxH = pageH - margin * 2 - headerH - legendH
  const scale = Math.min(maxW / w, maxH / h)
  doc.addImage(image, 'PNG', margin, margin + headerH, w * scale, h * scale)
  let x = margin
  const y = pageH - margin
  for (const { color, label } of meta.legend) {
    doc.setFillColor(pdfColor(color))
    doc.rect(x, y - 3, 3, 3, 'F')
    doc.text(label, x + 5, y)
    x += 10 + doc.getTextWidth(label)
  }
  doc.save(`${filename}.pdf`)
}
