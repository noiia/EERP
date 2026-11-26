import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pdf = vi.hoisted(() => ({ addImage: vi.fn(), text: vi.fn(), save: vi.fn(), rect: vi.fn(), getTextWidth: vi.fn(() => 10), setFillColor: vi.fn() }))
vi.mock('html-to-image', () => ({ toPng: vi.fn(async () => 'data:image/png;base64,AAA'), toSvg: vi.fn(async () => 'data:image/svg+xml,AAA') }))
vi.mock('jspdf', () => ({
  jsPDF: vi.fn(function () {
    return { ...pdf, internal: { pageSize: { getWidth: () => 420, getHeight: () => 297 } } }
  }),
}))

import { toPng, toSvg } from 'html-to-image'
import { diagramToPng, diagramToSvg, elementToPng, elementToSvg, pixelRatioFor, exportPdf, exportPng, pdfColor, pdfFormat, revealClippedText, type DiagramBounds } from './export'

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
  it('renders the viewport at 600 dpi (600/96 image pixels per CSS pixel)', async () => {
    const el = document.createElement('div')
    expect(await diagramToPng(el, bounds)).toBe('data:image/png;base64,AAA')
    expect(vi.mocked(toPng).mock.calls[0][1]).toMatchObject({ pixelRatio: 600 / 96 })
  })

  it('lowers the ratio just enough to fit the side or area limit', () => {
    expect(pixelRatioFor(32000, 400)).toBe(0.5)
    expect(pixelRatioFor(15000, 15000)).toBeCloseTo(Math.sqrt(150_000_000) / 15000)
    expect(pixelRatioFor(300, 200, 4)).toBe(4)
  })

  it('keeps every huge diagram inside the canvas limits', async () => {
    const el = document.createElement('div')
    await diagramToPng(el, { x: 0, y: 0, width: 40000, height: 400 })
    const { width, pixelRatio } = vi.mocked(toPng).mock.calls[0][1]!
    expect(width! * pixelRatio!).toBeLessThanOrEqual(16000)
  })
})

describe('elementToPng', () => {
  it('renders the element at its own size with no transform', async () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollWidth', { value: 300 })
    Object.defineProperty(el, 'scrollHeight', { value: 120 })
    await elementToPng(el, '#000')
    const o = vi.mocked(toPng).mock.calls[0][1]!
    expect(o).toMatchObject({ width: 300, height: 120, pixelRatio: 600 / 96, backgroundColor: '#000' })
    expect(o.style).toBeUndefined()
  })
})

describe('SVG export', () => {
  it('captures the diagram and an element as SVG, with the same framing as PNG', async () => {
    const el = document.createElement('div')
    expect(await diagramToSvg(el, bounds, '#000')).toBe('data:image/svg+xml,AAA')
    expect(vi.mocked(toSvg).mock.calls[0][1]).toMatchObject({ width: 880, height: 480, backgroundColor: '#000' })
    expect(vi.mocked(toSvg).mock.calls[0][1]!.style).toBeDefined()
    Object.defineProperty(el, 'scrollWidth', { value: 300 })
    Object.defineProperty(el, 'scrollHeight', { value: 120 })
    await elementToSvg(el)
    expect(vi.mocked(toSvg).mock.calls[1][1]).toMatchObject({ width: 300, height: 120, backgroundColor: '#ffffff' })
    expect(toPng).not.toHaveBeenCalled()
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

  it('renders the image at 600 dpi of its printed size, small or huge', async () => {
    for (const width of [200, 20000]) {
      vi.mocked(toPng).mockClear()
      pdf.addImage.mockClear()
      const b = { x: 0, y: 0, width, height: 100 }
      await exportPdf(document.createElement('div'), b, { title: 'T', date: new Date(), legend: [] }, 'p')
      const { width: w, pixelRatio } = vi.mocked(toPng).mock.calls[0][1]!
      const printedMm = pdf.addImage.mock.calls[0][4] as number
      expect(w! * pixelRatio!).toBeCloseTo((printedMm / 25.4) * 600)
    }
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

describe('revealClippedText', () => {
  const setup = () => {
    const root = document.createElement('div')
    const box = document.createElement('div')
    box.style.height = '64px'
    box.style.overflow = 'hidden'
    const title = document.createElement('p')
    title.style.whiteSpace = 'nowrap'
    title.style.textOverflow = 'ellipsis'
    title.style.overflow = 'hidden'
    title.textContent = 'A very long title that would be cut'
    box.appendChild(title)
    root.appendChild(box)
    document.body.appendChild(root)
    // jsdom has no layout: the box reports its wrapped title as taller than itself.
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 120 })
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 64 })
    Object.defineProperty(box, 'offsetHeight', { configurable: true, value: 64 })
    return { root, box, title }
  }
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('wraps an ellipsized title and grows the box clipping it, then restores both', () => {
    const { root, box, title } = setup()
    const restore = revealClippedText(root)
    expect(title.style.whiteSpace).toBe('normal')
    expect(title.style.textOverflow).toBe('clip')
    expect(title.style.overflow).toBe('visible')
    expect(box.style.overflow).toBe('visible')
    expect(box.style.height).toBe('auto')
    expect(box.style.minHeight).toBe('64px')
    restore()
    expect(title.style.whiteSpace).toBe('nowrap')
    expect(title.style.textOverflow).toBe('ellipsis')
    expect(title.style.overflow).toBe('hidden')
    expect(box.style.height).toBe('64px')
    expect(box.style.overflow).toBe('hidden')
    expect(box.style.minHeight).toBe('')
  })

  it('applies to every element capture and leaves the element as it was', async () => {
    const { root, title } = setup()
    let during = ''
    vi.mocked(toSvg).mockImplementationOnce(async () => {
      during = title.style.whiteSpace
      return 'data:image/svg+xml,AAA'
    })
    await elementToSvg(root)
    expect(during).toBe('normal')
    expect(title.style.whiteSpace).toBe('nowrap')
  })
})
