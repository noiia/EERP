import { getViewportForBounds } from '@xyflow/react'
import { toPng } from 'html-to-image'
import { jsPDF } from 'jspdf'

export interface DiagramBounds { x: number; y: number; width: number; height: number }
export interface LegendEntry { color: string; label: string }

const PAD = 40
const BACKGROUND = '#ffffff'
const size = (b: DiagramBounds) => ({ w: Math.ceil(b.width) + PAD * 2, h: Math.ceil(b.height) + PAD * 2 })

export function pdfFormat(width: number, height: number): 'a4' | 'a3' {
  return width / height > 2.2 || width > 3000 ? 'a3' : 'a4'
}

/** PNG data URL of the whole diagram (not just the visible part), via the xyflow export recipe. */
export async function diagramToPng(viewport: HTMLElement, bounds: DiagramBounds): Promise<string> {
  const { w, h } = size(bounds)
  const v = getViewportForBounds(bounds, w, h, 0.1, 4, 0.05)
  return toPng(viewport, {
    backgroundColor: BACKGROUND,
    width: w,
    height: h,
    pixelRatio: 2,
    style: { width: `${w}px`, height: `${h}px`, transform: `translate(${v.x}px, ${v.y}px) scale(${v.zoom})` },
  })
}

export async function exportPng(viewport: HTMLElement, bounds: DiagramBounds, filename: string): Promise<void> {
  const a = document.createElement('a')
  a.download = `${filename}.png`
  a.href = await diagramToPng(viewport, bounds)
  a.click()
}

export async function exportPdf(
  viewport: HTMLElement,
  bounds: DiagramBounds,
  meta: { title: string; date: Date; legend: LegendEntry[] },
  filename: string,
): Promise<void> {
  const { w, h } = size(bounds)
  const image = await diagramToPng(viewport, bounds)
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
    doc.setFillColor(color)
    doc.rect(x, y - 3, 3, 3, 'F')
    doc.text(label, x + 5, y)
    x += 10 + doc.getTextWidth(label)
  }
  doc.save(`${filename}.pdf`)
}
