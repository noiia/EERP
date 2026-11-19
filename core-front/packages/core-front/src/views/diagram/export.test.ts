import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pdf = vi.hoisted(() => ({ addImage: vi.fn(), text: vi.fn(), save: vi.fn(), rect: vi.fn(), getTextWidth: vi.fn(() => 10), setFillColor: vi.fn() }))
vi.mock('html-to-image', () => ({ toPng: vi.fn(async () => 'data:image/png;base64,AAA') }))
vi.mock('jspdf', () => ({
  jsPDF: vi.fn(function () {
    return { ...pdf, internal: { pageSize: { getWidth: () => 420, getHeight: () => 297 } } }
  }),
}))

import { toPng } from 'html-to-image'
import { diagramToPng, elementToPng, pixelRatioFor, exportPdf, exportPng, pdfColor, pdfFormat, type DiagramBounds } from './export'

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
  it('renders the viewport at pixelRatio 3', async () => {
    const el = document.createElement('div')
    expect(await diagramToPng(el, bounds)).toBe('data:image/png;base64,AAA')
    expect(vi.mocked(toPng).mock.calls[0][1]).toMatchObject({ pixelRatio: 3 })
  })

  it('steps down to 2 when 3 would pass the side or area limit', () => {
    expect(pixelRatioFor(6000, 400)).toBe(2)
    expect(pixelRatioFor(5000, 5000)).toBe(2)
    expect(pixelRatioFor(7000, 7000)).toBe(1)
  })

  it('drops to pixelRatio 1 past the canvas size limit', async () => {
    const el = document.createElement('div')
    await diagramToPng(el, { x: 0, y: 0, width: 9000, height: 400 })
    await diagramToPng(el, { x: 0, y: 0, width: 400, height: 9000 })
    expect(vi.mocked(toPng).mock.calls.map((c) => c[1]?.pixelRatio)).toEqual([1, 1])
  })
})

describe('elementToPng', () => {
  it('renders the element at its own size with no transform', async () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollWidth', { value: 300 })
    Object.defineProperty(el, 'scrollHeight', { value: 120 })
    await elementToPng(el, '#000')
    const o = vi.mocked(toPng).mock.calls[0][1]!
    expect(o).toMatchObject({ width: 300, height: 120, pixelRatio: 3, backgroundColor: '#000' })
    expect(o.style).toBeUndefined()
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

// The React Flow edge layer as the canvas shows it (React Flow 12.12): the
// `.react-flow__edges` div (one svg per edge + the arrowhead marker defs) sits
// inside the viewport; the default stroke/width are CSS custom properties set on
// the .react-flow root (here inline, as the library's style.css sets them). html-to-image
// serializes the captured node without that stylesheet, so the export must make the
// edge layer self-contained before the capture.
const SVGNS = 'http://www.w3.org/2000/svg'
const EDGE_STROKE = 'var(--xy-edge-stroke, var(--xy-edge-stroke-default))'
const EDGE_WIDTH = 'var(--xy-edge-stroke-width, var(--xy-edge-stroke-width-default))'

function edgeFixture({ dark = false }: { dark?: boolean } = {}) {
  const root = document.createElement('div')
  root.className = dark ? 'react-flow dark' : 'react-flow'
  root.style.setProperty('--xy-edge-stroke-default', dark ? '#3e3e3e' : '#b1b1b7')
  root.style.setProperty('--xy-edge-stroke-width-default', '1')
  const viewport = document.createElement('div')
  viewport.className = 'react-flow__viewport'
  const layer = document.createElement('div')
  layer.className = 'react-flow__edges'
  const mk = (id: string, color?: string) => {
    const marker = document.createElementNS(SVGNS, 'marker')
    marker.setAttribute('id', id)
    marker.setAttribute('class', 'react-flow__arrowhead')
    marker.setAttribute('viewBox', '-10 -10 20 20')
    const pl = document.createElementNS(SVGNS, 'polyline')
    pl.setAttribute('class', 'arrowclosed')
    pl.setAttribute('points', '-5,-4 0,0 -5,4 -5,-4')
    pl.style.cssText = color
      ? `stroke-width: 1; stroke: ${color}; fill: ${color}`
      : `stroke: ${EDGE_STROKE}; fill: ${EDGE_STROKE}; stroke-width: 1`
    marker.appendChild(pl)
    return marker
  }
  const markers = document.createElementNS(SVGNS, 'svg')
  markers.setAttribute('class', 'react-flow__marker')
  markers.setAttribute('aria-hidden', 'true')
  const defs = document.createElementNS(SVGNS, 'defs')
  defs.append(mk('m-default'), mk('m-crit', '#ff0000'))
  markers.appendChild(defs)
  layer.appendChild(markers)
  const path = (id: string, style: string, marker?: string) => {
    const p = document.createElementNS(SVGNS, 'path')
    p.setAttribute('class', 'react-flow__edge-path')
    p.setAttribute('d', `M 0 0 L 100 ${id === 'e3' ? 80 : 50}`)
    p.setAttribute('fill', 'none')
    p.style.cssText = style
    if (marker) p.setAttribute('marker-end', `url(#${marker})`)
    return p
  }
  const edge = (id: string, children: SVGElement[]) => {
    const svg = document.createElementNS(SVGNS, 'svg')
    const g = document.createElementNS(SVGNS, 'g')
    g.setAttribute('class', 'react-flow__edge react-flow__edge-default')
    g.setAttribute('data-id', id)
    g.append(...children)
    svg.appendChild(g)
    layer.appendChild(svg)
    return svg
  }
  // e1: the default line (stroke from the root's custom properties) + its invisible
  // interaction path, arrowheaded. e2: the highlighted line (explicit color/width)
  // with a colored arrowhead. e3: the dashed note link, no marker.
  const interaction = document.createElementNS(SVGNS, 'path')
  interaction.setAttribute('class', 'react-flow__edge-interaction')
  interaction.setAttribute('d', 'M 0 0 L 100 50')
  interaction.setAttribute('fill', 'none')
  interaction.style.cssText = 'stroke-opacity: 0; stroke-width: 20'
  edge('e1', [path('e1', `stroke: ${EDGE_STROKE}; stroke-width: ${EDGE_WIDTH}`, 'm-default'), interaction])
  edge('e2', [path('e2', 'stroke: #ff0000; stroke-width: 2', 'm-crit')])
  edge('e3', [path('e3', `stroke: ${EDGE_STROKE}; stroke-width: ${EDGE_WIDTH}; stroke-dasharray: 4 4`)])
  viewport.appendChild(layer)
  root.appendChild(viewport)
  document.body.appendChild(root)
  return { root, viewport }
}

/** diagramToPng with a toPng that snapshots the node it is handed (synchronously,
 * before the export's restore runs). */
async function capturedOf(el: HTMLElement, b: DiagramBounds): Promise<HTMLElement> {
  let captured: HTMLElement | null = null
  vi.mocked(toPng).mockImplementationOnce(async (node) => {
    captured = node.cloneNode(true) as HTMLElement
    return 'data:image/png;base64,AAA'
  })
  await diagramToPng(el, b)
  expect(captured).not.toBeNull()
  return captured!
}

describe('diagramToPng keeps every line, dash and arrowhead the canvas shows', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('hands toPng every edge path with an explicit resolved stroke, width and fill (light)', async () => {
    const { viewport } = edgeFixture()
    const captured = await capturedOf(viewport, bounds)
    const paths = Array.from(captured.querySelectorAll<SVGElement>('.react-flow__edge path'))
    expect(paths).toHaveLength(4)
    for (const p of paths) {
      const style = p.getAttribute('style') ?? ''
      expect(style).not.toContain('var(')
      expect(style).toContain('stroke:')
      expect(style).toContain('stroke-width:')
      expect(style).toContain('fill: none')
    }
    // The default stroke resolved against the light value set on .react-flow.
    expect(paths[0].getAttribute('style')).toContain('rgb(177, 177, 183)')
    // The highlighted line keeps its own color and width.
    expect(paths[2].getAttribute('style')).toContain('rgb(255, 0, 0)')
    // The dashed note link keeps its dash.
    expect(paths[3].getAttribute('style')).toContain('stroke-dasharray: 4 4')
  })

  it('resolves the dark theme values the same way', async () => {
    const { viewport } = edgeFixture({ dark: true })
    const captured = await capturedOf(viewport, bounds)
    const paths = Array.from(captured.querySelectorAll<SVGElement>('.react-flow__edge path'))
    expect(paths[0].getAttribute('style')).toContain('rgb(62, 62, 62)')
    expect(paths[2].getAttribute('style')).toContain('rgb(255, 0, 0)')
    for (const p of paths) expect(p.getAttribute('style')).not.toContain('var(')
  })

  it('resolves every marker-end to a <marker> inside the captured node, arrowheads explicit', async () => {
    const { viewport } = edgeFixture()
    const captured = await capturedOf(viewport, bounds)
    const refs = Array.from(captured.querySelectorAll<SVGElement>('.react-flow__edge path'))
      .map((p) => /^url\(\s*#([^)]+)\)$/.exec(p.getAttribute('marker-end') ?? ''))
      .filter((m): m is RegExpExecArray => !!m)
    expect(refs.map((m) => m[1])).toEqual(['m-default', 'm-crit'])
    for (const m of refs) {
      const marker = captured.querySelector(`marker[id="${m[1]}"]`)
      expect(marker).not.toBeNull()
      const style = marker!.querySelector('polyline')!.getAttribute('style') ?? ''
      expect(style).not.toContain('var(')
      expect(style).toContain('stroke:')
    }
    // The colored arrowhead keeps its color.
    expect(captured.querySelector('marker[id="m-crit"] polyline')!.getAttribute('style')).toContain('rgb(255, 0, 0)')
  })

  it('gives the edges svg a non-zero size', async () => {
    const { viewport } = edgeFixture()
    const captured = await capturedOf(viewport, bounds)
    const svgs = Array.from(captured.querySelectorAll<SVGElement>('.react-flow__edges svg'))
    expect(svgs).toHaveLength(4)
    for (const s of svgs) {
      expect(Number(s.getAttribute('width'))).toBeGreaterThan(0)
      expect(Number(s.getAttribute('height'))).toBeGreaterThan(0)
    }
  })

  it('leaves the canvas exactly as it was, after a success and after a failure', async () => {
    const { viewport } = edgeFixture()
    const before = viewport.outerHTML
    await capturedOf(viewport, bounds)
    expect(viewport.outerHTML).toBe(before)
    vi.mocked(toPng).mockRejectedValueOnce(new Error('boom'))
    await expect(diagramToPng(viewport, bounds)).rejects.toThrow('boom')
    expect(viewport.outerHTML).toBe(before)
  })

  it('copies a marker whose defs live outside the captured subtree into the capture, and removes the copy after', async () => {
    const { root, viewport } = edgeFixture()
    // Move the arrowhead defs out of the captured viewport (a sibling of it).
    root.appendChild(viewport.querySelector<SVGElement>('svg.react-flow__marker')!)
    const before = viewport.outerHTML
    const captured = await capturedOf(viewport, bounds)
    expect(captured.querySelector('marker[id="m-default"]')).not.toBeNull()
    expect(captured.querySelector('marker[id="m-crit"] polyline')!.getAttribute('style')).toContain('rgb(255, 0, 0)')
    // The copy is gone from the captured subtree; the original (moved by the test) is untouched.
    expect(viewport.querySelector('marker')).toBeNull()
    expect(root.querySelector('marker[id="m-default"]')).not.toBeNull()
    expect(viewport.outerHTML).toBe(before)
  })
})
