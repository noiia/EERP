import { getViewportForBounds } from '@xyflow/react'
import { toPng } from 'html-to-image'
import { jsPDF } from 'jspdf'

export interface DiagramBounds { x: number; y: number; width: number; height: number }
export interface LegendEntry { color: string; label: string }

const PAD = 40
// Browsers refuse canvases past about 16384 px a side, or a total area past roughly 2^28
// pixels (less on some): a bigger image exports at whatever lower ratio still fits.
const MAX_CANVAS_SIDE = 16000
const MAX_CANVAS_AREA = 150_000_000
/** Export resolution: a PNG holds 150 pixels per inch of the diagram at its natural size (a CSS
 * pixel is 1/96 in), a PDF 150 pixels per inch of the printed page, whatever the diagram's size. */
export const EXPORT_DPI = 150
const CSS_DPI = 96
const MM_PER_INCH = 25.4
/** The pixel ratio for an image of w × h CSS pixels: the wanted one (150 dpi by default),
 * lowered as far as needed to fit the canvas limits. */
export const pixelRatioFor = (w: number, h: number, wanted = EXPORT_DPI / CSS_DPI) =>
  Math.min(wanted, MAX_CANVAS_SIDE / Math.max(w, h), Math.sqrt(MAX_CANVAS_AREA / (w * h)))
const WHITE = '#ffffff'
const size = (b: DiagramBounds) => ({ w: Math.ceil(b.width) + PAD * 2, h: Math.ceil(b.height) + PAD * 2 })

export function pdfFormat(width: number, height: number): 'a4' | 'a3' {
  return width / height > 2.2 || width > 3000 ? 'a3' : 'a4'
}

/** Makes the React Flow edge layer self-contained for a standalone capture, and returns
 * the restore. The layer (one svg per edge + the arrowhead `<marker>` defs) depends on the
 * `.react-flow` root's stylesheet — the stroke is a CSS custom property set there, the
 * arrowheads are `url(#…)` refs and the edge svgs have no size of their own — none of which
 * survives html-to-image serializing the captured node alone, so a viewport-only export
 * would lose every line, dash and arrowhead. The values the canvas shows (the computed
 * stroke, width and dash with the variables resolved, the marker colors, explicit sizes)
 * are inlined on the edge elements for the duration of the capture and restored by the
 * returned function, which also removes a marker copied in from the document. No-op, with
 * a no-op restore, when the node has no edge layer. */
export function prepareEdgesForCapture(node: HTMLElement, bounds: DiagramBounds): () => void {
  const layer = node.querySelector<HTMLElement>('.react-flow__edges')
  if (!layer) return () => {}
  const restores: Array<() => void> = []
  // Inline a value for the capture, restoring the element's own (possibly absent)
  // declaration afterwards: no property is left added or emptied.
  const prepare = (el: SVGElement) => {
    const style = el.style
    const saved: Array<[string, string]> = []
    restores.push(() => {
      for (const [prop, old] of saved) {
        if (old) style.setProperty(prop, old)
        else style.removeProperty(prop)
      }
    })
    const set = (prop: string, value: string) => {
      saved.push([prop, style.getPropertyValue(prop)])
      style.setProperty(prop, value)
    }
    return {
      set,
      cs: getComputedStyle(el),
    }
  }
  // The edge svgs have no size of their own: a zero-size svg can be dropped from the
  // serialized image. Size them to the diagram's extent (their content is in flow
  // coordinates from the viewport's origin).
  const w = Math.max(1, Math.ceil(bounds.x + bounds.width))
  const h = Math.max(1, Math.ceil(bounds.y + bounds.height))
  for (const svg of Array.from(layer.querySelectorAll<SVGElement>('svg'))) {
    const prev = { w: svg.getAttribute('width'), h: svg.getAttribute('height') }
    svg.setAttribute('width', String(w))
    svg.setAttribute('height', String(h))
    restores.push(() => {
      if (prev.w === null) svg.removeAttribute('width')
      else svg.setAttribute('width', prev.w)
      if (prev.h === null) svg.removeAttribute('height')
      else svg.setAttribute('height', prev.h)
    })
  }
  // The lines: the computed stroke / width / dash (the CSS variables already resolved)
  // become the explicit inline values the serialized clone keeps. The line is stroked,
  // never filled (React Flow renders fill="none" on every edge path).
  for (const path of Array.from(layer.querySelectorAll<SVGElement>('.react-flow__edge path'))) {
    const { set, cs } = prepare(path)
    set('stroke', cs.stroke || 'none')
    set('stroke-width', cs.strokeWidth || '1')
    if (cs.strokeDasharray && cs.strokeDasharray !== 'none') set('stroke-dasharray', cs.strokeDasharray)
    set('fill', 'none')
  }
  // The arrowheads: every marker the lines reference must be inside the captured node,
  // and its shapes must carry the explicit colors the canvas shows.
  const markerIds = new Set<string>()
  for (const path of Array.from(layer.querySelectorAll<SVGElement>('.react-flow__edge path'))) {
    const m = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)$/.exec(path.getAttribute('marker-end') ?? '')
    if (m) markerIds.add(m[1])
  }
  for (const id of markerIds) {
    const ref = `marker[id="${id.replace(/["\\]/g, '\\$&')}"]`
    let marker = node.querySelector<SVGElement>(ref)
    if (!marker && typeof document !== 'undefined') {
      // A ref whose defs live outside the captured subtree: copy the marker in.
      const outside = document.querySelector<SVGElement>(ref)
      if (!outside) continue
      const clone = outside.cloneNode(true) as SVGElement
      const host = layer.querySelector<SVGElement>('svg.react-flow__marker') ?? layer
      let defs = host.querySelector('defs')
      let createdDefs = false
      if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
        host.appendChild(defs)
        createdDefs = true
      }
      defs.appendChild(clone)
      restores.push(() => {
        clone.remove()
        if (createdDefs && defs.parentNode && !defs.hasChildNodes()) defs.remove()
      })
      marker = clone
    }
    if (!marker) continue
    // A marker's children are its SVG shapes (xyflow's Marker renders a polyline).
    for (const shape of Array.from(marker.children) as SVGElement[]) {
      const { set, cs } = prepare(shape)
      if (cs.stroke) set('stroke', cs.stroke)
      if (cs.strokeWidth) set('stroke-width', cs.strokeWidth)
      if (cs.fill) set('fill', cs.fill)
    }
  }
  return () => {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  }
}

/** PNG data URL of the whole diagram (not just the visible part), via the xyflow export recipe;
 * at `ratio` image pixels per CSS pixel (default 150 dpi), capped by the canvas limits (pixelRatioFor). */
export async function diagramToPng(viewport: HTMLElement, bounds: DiagramBounds, background = WHITE, ratio?: number): Promise<string> {
  const { w, h } = size(bounds)
  const v = getViewportForBounds(bounds, w, h, 0.1, 4, 0.05)
  const restore = prepareEdgesForCapture(viewport, bounds)
  try {
    return await toPng(viewport, {
      backgroundColor: background,
      width: w,
      height: h,
      pixelRatio: pixelRatioFor(w, h, ratio),
      style: { width: `${w}px`, height: `${h}px`, transform: `translate(${v.x}px, ${v.y}px) scale(${v.zoom})` },
    })
  } finally {
    restore()
  }
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
  await writePdf((ratio) => diagramToPng(viewport, bounds, meta.background, ratio), w, h, meta, filename)
}

/** Lays the page out first, so the image is rendered at EXPORT_DPI of the size it is printed at:
 * a small diagram stays sharp when enlarged onto the page, a huge one never needs an oversized canvas. */
async function writePdf(
  render: (ratio: number) => Promise<string>,
  w: number,
  h: number,
  meta: { title: string; date: Date; legend: LegendEntry[] },
  filename: string,
): Promise<void> {
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
  // scale is mm per CSS pixel: image pixels per CSS pixel = printed inches per CSS pixel × dpi.
  const image = await render((scale / MM_PER_INCH) * EXPORT_DPI)
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

/** PNG data URL of a plain element at its natural size (no viewport transform: for HTML/SVG content that is
 * not an xyflow canvas); same pixel-ratio rule as diagramToPng. The edge preparation applies too — a no-op
 * for the mind-map and Ishikawa elements, whose lines are plain SVG with explicit attributes. */
export async function elementToPng(el: HTMLElement, background = WHITE, ratio?: number): Promise<string> {
  const width = Math.ceil(el.scrollWidth)
  const height = Math.ceil(el.scrollHeight)
  const restore = prepareEdgesForCapture(el, { x: 0, y: 0, width: el.scrollWidth, height: el.scrollHeight })
  try {
    return await toPng(el, { backgroundColor: background, width, height, pixelRatio: pixelRatioFor(width, height, ratio) })
  } finally {
    restore()
  }
}

export async function exportElementPng(el: HTMLElement, filename: string, background?: string): Promise<void> {
  const a = document.createElement('a')
  a.download = `${filename}.png`
  a.href = await elementToPng(el, background)
  a.click()
}

export async function exportElementPdf(
  el: HTMLElement,
  meta: { title: string; date: Date; legend: LegendEntry[]; background?: string },
  filename: string,
): Promise<void> {
  await writePdf((ratio) => elementToPng(el, meta.background, ratio), Math.ceil(el.scrollWidth), Math.ceil(el.scrollHeight), meta, filename)
}
