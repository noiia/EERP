import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fake Leaflet: records handlers so tests can "click" the map and "drag" a marker.
const handlers: Record<string, (e: { latlng: { lat: number; lng: number } }) => void> = {}
const markers: {
  latlng: { lat: number; lng: number }
  on: Record<string, () => void>
  removed: boolean
}[] = []
const polygons: { latlngs: unknown; removed: boolean }[] = []
vi.mock('leaflet', () => {
  const map = {
    setView: vi.fn().mockReturnThis(),
    fitBounds: vi.fn(),
    on: (evt: string, fn: (e: { latlng: { lat: number; lng: number } }) => void) => {
      handlers[evt] = fn
    },
    remove: vi.fn(),
  }
  const L = {
    map: vi.fn(() => map),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    divIcon: vi.fn(() => ({})),
    marker: vi.fn((latlng: [number, number]) => {
      const m = {
        latlng: { lat: latlng[0], lng: latlng[1] },
        on: {} as Record<string, () => void>,
        removed: false,
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
    await waitFor(() => expect(markers).toHaveLength(0))
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
})
