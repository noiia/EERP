import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LineChart } from './line-chart'
import { setViewportWidth } from '../../test/viewport'

// A plain two-series time axis (the insights mode's shared chart primitive):
// one date per x, hours per y — the same shape the /metrics points give.
const SERIES = [
  { key: 'a', label: 'Alpha', points: [{ x: '2026-11-01', y: 0 }, { x: '2026-11-02', y: 4.4 }, { x: '2026-11-03', y: 2 }] },
  { key: 'b', label: 'Beta', points: [{ x: '2026-11-01', y: 1 }, { x: '2026-11-02', y: 2.2 }, { x: '2026-11-03', y: 4.4 }], dashed: true },
]

afterEach(() => {
  cleanup()
})

describe('LineChart', () => {
  it('draws the nice gridlines, one line per series and the legend', () => {
    const { container } = render(<LineChart series={SERIES} yLabel="Hours" height={280} />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    // niceRange(0, 4.4) → 0, 2, 4, 6 (1/2/5 × 10^n steps, last tick ≥ max):
    // the axis starts at 0 and the last tick reaches past the data's max.
    expect(screen.getByText('0', { selector: 'text' })).toBeTruthy()
    expect(screen.getByText('6', { selector: 'text' })).toBeTruthy()
    // One <path> line per series (the tooltip hit areas are <rect>s).
    expect(container.querySelectorAll('path').length).toBe(2)
    // The dashed series is drawn with a dash pattern.
    expect(container.querySelector('path[stroke-dasharray]')).toBeTruthy()
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.getByText('Hours')).toBeTruthy()
  })

  it('lists every series at the nearest date in the hover tooltip', async () => {
    const { container } = render(<LineChart series={SERIES} yLabel="Hours" height={280} />)
    const hit = container.querySelector('[data-lc-hit="2026-11-02"]') as HTMLElement
    expect(hit).toBeTruthy()
    fireEvent.mouseEnter(hit)
    expect(await screen.findByText(/Alpha: 4\.4/)).toBeTruthy()
    expect(screen.getByText(/Beta: 2\.2/)).toBeTruthy()
  })

  it('fills its container width and wraps the legend below at 390px', () => {
    setViewportWidth(390)
    const { container } = render(<LineChart series={SERIES} yLabel="Hours" height={280} />)
    const svg = container.querySelector('svg')!
    expect(svg.style.width).toBe('100%')
    const legend = screen.getByTestId('line-legend')
    // The legend sits below the plot (document order after the SVG)…
    expect(svg.compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // …and wraps instead of squeezing one line per entry.
    expect(getComputedStyle(legend).flexWrap || legend.style.flexWrap).toBe('wrap')
  })
})
