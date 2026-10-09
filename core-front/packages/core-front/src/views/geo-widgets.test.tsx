import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fake Leaflet: records handlers so tests can "click" the map and "drag" a marker.
const handlers: Record<string, (e: { latlng: { lat: number; lng: number } }) => void> = {}
const markers: {
  latlng: { lat: number; lng: number }
  on: Record<string, () => void>
  removed: boolean
  draggable: boolean
}[] = []
const polygons: { latlngs: unknown; removed: boolean }[] = []
vi.mock('leaflet', () => {
  const makeMap = () => ({
    setView: vi.fn().mockReturnThis(),
    fitBounds: vi.fn(),
    on: (evt: string, fn: (e: { latlng: { lat: number; lng: number } }) => void) => {
      handlers[evt] = fn
    },
    off: (evt: string, fn: unknown) => {
      if (handlers[evt] === fn) delete handlers[evt]
    },
    remove: vi.fn(),
  })
  const L = {
    map: vi.fn((_el: unknown, _opts?: Record<string, unknown>) => makeMap()),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    divIcon: vi.fn(() => ({})),
    marker: vi.fn((latlng: [number, number], opts?: { draggable?: boolean }) => {
      const m = {
        latlng: { lat: latlng[0], lng: latlng[1] },
        on: {} as Record<string, () => void>,
        removed: false,
        draggable: !!opts?.draggable,
      }
      markers.push(m)
      return {
        addTo: vi.fn().mockReturnThis(),
        on: (evt: string, fn: () => void) => {
          m.on[evt] = fn
          return undefined
        },
        getLatLng: () => m.latlng,
        setLatLng: (ll: [number, number]) => {
          m.latlng = { lat: ll[0], lng: ll[1] }
        },
        remove: () => {
          m.removed = true
        },
      }
    }),
    polygon: vi.fn((latlngs: unknown) => {
      const p = { latlngs, removed: false }
      polygons.push(p)
      return {
        addTo: vi.fn().mockReturnThis(),
        remove: () => {
          p.removed = true
        },
        getBounds: () => ({}),
      }
    }),
    polyline: vi.fn(() => ({
      addTo: vi.fn().mockReturnThis(),
      remove: vi.fn(),
      getBounds: () => ({}),
    })),
  }
  return { default: L, ...L }
})

import { GeoPointWidget, GeoShapeWidget } from './geo-widgets'
import * as Leaflet from 'leaflet'

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k]
  markers.length = 0
  polygons.length = 0
})

describe('GeoPointWidget', () => {
  it('places the point where the map is clicked', async () => {
    const onChange = vi.fn()
    render(
      <GeoPointWidget
        field={{ name: 'geo_location', type: 'geo' }}
        value={null}
        onChange={onChange}
      />,
    )
    await waitFor(() => expect(handlers.click).toBeDefined())
    act(() => handlers.click({ latlng: { lat: 48.85, lng: 2.35 } }))
    expect(onChange).toHaveBeenCalledWith({ type: 'Point', coordinates: [2.35, 48.85] })
  })

  it('renders an empty map for a record with no location (Review Focus 2)', async () => {
    render(
      <GeoPointWidget
        field={{ name: 'geo_location', type: 'geo' }}
        value={null}
        onChange={vi.fn()}
      />,
    )
    await waitFor(() => expect(handlers.click).toBeDefined())
    expect(markers).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull()
  })

  it('clears the point', async () => {
    const onChange = vi.fn()
    render(
      <GeoPointWidget
        field={{ name: 'geo_location', type: 'geo' }}
        value={{ type: 'Point', coordinates: [2.35, 48.85] }}
        onChange={onChange}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /clear/i }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('locates from the sibling address through the geocoder', async () => {
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ results: [{ label: 'x', lat: 45.76, lon: 4.83 }] })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const onChange = vi.fn()
    render(
      <GeoPointWidget
        field={{ name: 'geo_location', type: 'geo', widgetOptions: { address: 'address' } }}
        value={null}
        onChange={onChange}
        draft={{
          address_number: 1,
          address_street: 'Rue X',
          address_zip_code: '69001',
          address_city: 'Lyon',
          address_country: 'France',
        }}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /locate from address/i }))
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ type: 'Point', coordinates: [4.83, 45.76] }),
    )
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      encodeURIComponent('1 Rue X, 69001 Lyon, France'),
    )
    vi.unstubAllGlobals()
  })

  it('creates a marker for the initial value and recreates it after disabled -> enabled', async () => {
    const field = { name: 'geo_location', type: 'geo' as const }
    const value = { type: 'Point' as const, coordinates: [2.35, 48.85] as [number, number] }
    const { rerender } = render(
      <GeoPointWidget field={field} value={value} onChange={vi.fn()} disabled />,
    )
    await waitFor(() => expect(markers).toHaveLength(1))
    expect(markers[0].draggable).toBe(false)
    rerender(<GeoPointWidget field={field} value={value} onChange={vi.fn()} />)
    await waitFor(() => expect(markers).toHaveLength(2))
    expect(markers[1].draggable).toBe(true)
    expect(markers[1].removed).toBe(false)
  })

  it('emits the new coordinates when the marker is dragged', async () => {
    const onChange = vi.fn()
    render(
      <GeoPointWidget
        field={{ name: 'geo_location', type: 'geo' }}
        value={{ type: 'Point', coordinates: [2.35, 48.85] }}
        onChange={onChange}
      />,
    )
    await waitFor(() => expect(markers).toHaveLength(1))
    markers[0].latlng = { lat: 10, lng: 20 }
    act(() => markers[0].on.dragend())
    expect(onChange).toHaveBeenLastCalledWith({ type: 'Point', coordinates: [20, 10] })
  })

  it('is inert when disabled', async () => {
    const onChange = vi.fn()
    render(
      <GeoPointWidget
        field={{ name: 'geo_location', type: 'geo' }}
        value={null}
        onChange={onChange}
        disabled
      />,
    )
    await waitFor(() => expect(Leaflet.map).toHaveBeenCalled())
    expect(vi.mocked(Leaflet.map).mock.calls.at(-1)?.[1]).toMatchObject({ dragging: false })
    expect(markers).toHaveLength(0)
    expect(handlers.click).toBeUndefined()
  })
})

describe('GeoShapeWidget', () => {
  it('adds vertices on click and emits a closed polygon from 3 vertices', async () => {
    const onChange = vi.fn()
    render(
      <GeoShapeWidget
        field={{ name: 'service_zone', type: 'geo', widget: 'shape' }}
        value={null}
        onChange={onChange}
      />,
    )
    await waitFor(() => expect(handlers.click).toBeDefined())
    act(() => handlers.click({ latlng: { lat: 48, lng: 2 } }))
    act(() => handlers.click({ latlng: { lat: 48, lng: 3 } }))
    expect(onChange).not.toHaveBeenCalled() // 2 vertices: not a polygon yet
    act(() => handlers.click({ latlng: { lat: 49, lng: 3 } }))
    expect(onChange).toHaveBeenLastCalledWith({
      type: 'Polygon',
      coordinates: [
        [
          [2, 48],
          [3, 48],
          [3, 49],
          [2, 48],
        ],
      ],
    })
  })

  const shapeField = { name: 'service_zone', type: 'geo' as const, widget: 'shape' }
  const tri = (pts: [number, number][]) => ({
    type: 'Polygon' as const,
    coordinates: [[...pts, pts[0]]],
  })

  it('resyncs vertices on an external value change', async () => {
    const onChange = vi.fn()
    const a = tri([
      [0, 0],
      [1, 0],
      [1, 1],
    ])
    const b = tri([
      [5, 5],
      [6, 5],
      [6, 6],
    ])
    const { rerender } = render(<GeoShapeWidget field={shapeField} value={a} onChange={onChange} />)
    await waitFor(() => expect(markers).toHaveLength(3))
    rerender(<GeoShapeWidget field={shapeField} value={b} onChange={onChange} />)
    await waitFor(() =>
      expect(markers.filter((m) => !m.removed).map((m) => [m.latlng.lng, m.latlng.lat])).toEqual([
        [5, 5],
        [6, 5],
        [6, 6],
      ]),
    )
    act(() => handlers.click({ latlng: { lat: 7, lng: 7 } }))
    expect(onChange).toHaveBeenLastCalledWith(
      tri([
        [5, 5],
        [6, 5],
        [6, 6],
        [7, 7],
      ]),
    )
  })

  it('emits null when a vertex removal leaves fewer than 3', async () => {
    const onChange = vi.fn()
    render(
      <GeoShapeWidget
        field={shapeField}
        value={tri([
          [0, 0],
          [1, 0],
          [1, 1],
        ])}
        onChange={onChange}
      />,
    )
    await waitFor(() => expect(markers).toHaveLength(3))
    act(() => markers[0].on.click())
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('emits the moved polygon when a vertex is dragged', async () => {
    const onChange = vi.fn()
    render(
      <GeoShapeWidget
        field={shapeField}
        value={tri([
          [0, 0],
          [1, 0],
          [1, 1],
        ])}
        onChange={onChange}
      />,
    )
    await waitFor(() => expect(markers).toHaveLength(3))
    markers[1].latlng = { lat: 3, lng: 4 }
    act(() => markers[1].on.dragend())
    expect(onChange).toHaveBeenLastCalledWith(
      tri([
        [0, 0],
        [4, 3],
        [1, 1],
      ]),
    )
  })
})
