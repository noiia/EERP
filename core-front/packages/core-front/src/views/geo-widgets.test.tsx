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
    getCenter: () => ({ lat: 46.5, lng: 2.5 }),
  })
  const L = {
    map: vi.fn<(el: unknown, opts?: Record<string, unknown>) => ReturnType<typeof makeMap>>(() => makeMap()),
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

import { AUTO_LOCATE_DEBOUNCE_MS, GeoPointWidget, GeoShapeWidget } from './geo-widgets'
import { useRecentAddressStore } from './recent-addresses'
import * as Leaflet from 'leaflet'

beforeEach(() => {
  useRecentAddressStore.setState({ addresses: [] })
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

  // The OSM connector status route says on/off; every other call is the geocoder.
  function stubOSM(enabled: boolean, search: () => Response) {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/osm/status') ? new Response(JSON.stringify({ enabled })) : search(),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  const addressField = {
    name: 'geo_location',
    type: 'geo' as const,
    widgetOptions: { address: 'address' },
  }

  it('hides the address search and "Locate from address" while the OSM connector is off', async () => {
    stubOSM(false, () => new Response('{}'))
    render(
      <GeoPointWidget
        field={addressField}
        value={{ type: 'Point', coordinates: [2.35, 48.85] }}
        onChange={vi.fn()}
      />,
    )
    await screen.findByRole('button', { name: /clear/i })
    await act(async () => {})
    expect(screen.queryByLabelText(/search an address/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /locate from address/i })).toBeNull()
    vi.unstubAllGlobals()
  })

  it('says "Address not found" when the geocoder finds nothing', async () => {
    stubOSM(true, () => new Response(JSON.stringify({ results: [] })))
    const onChange = vi.fn()
    render(<GeoPointWidget field={addressField} value={null} onChange={onChange} />)
    fireEvent.click(await screen.findByRole('button', { name: /locate from address/i }))
    expect(await screen.findByText('Address not found')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('re-enables "Locate from address" when the geocoder answers garbage', async () => {
    stubOSM(true, () => new Response('not json'))
    render(<GeoPointWidget field={addressField} value={null} onChange={vi.fn()} />)
    const button = await screen.findByRole('button', { name: /locate from address/i })
    fireEvent.click(button)
    expect(await screen.findByText('Address not found')).toBeInTheDocument()
    expect(button).not.toBeDisabled()
    vi.unstubAllGlobals()
  })

  it('locates from the sibling address through the geocoder', async () => {
    const fetchMock = stubOSM(
      true,
      () => new Response(JSON.stringify({ results: [{ label: 'x', lat: 45.76, lon: 4.83 }] })),
    )
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
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
      encodeURIComponent('1 Rue X, 69001 Lyon, France'),
    )
    vi.unstubAllGlobals()
  })

  it('hides the place search when widgetOptions.search is false', async () => {
    stubOSM(true, () => new Response('{}'))
    render(
      <GeoPointWidget
        field={{ ...addressField, widgetOptions: { address: 'address', search: false } }}
        value={null}
        onChange={vi.fn()}
      />,
    )
    await screen.findByRole('button', { name: /locate from address/i })
    expect(screen.queryByLabelText(/search an address/i)).toBeNull()
    vi.unstubAllGlobals()
  })

  describe('"Create…" in the address search', () => {
    // Types into the search, picks its last row and fills the dialog.
    async function createByHand(street: string, city: string) {
      const input = await screen.findByLabelText(/search an address/i)
      fireEvent.change(input, { target: { value: street } })
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.click(await screen.findByText('Create…'))
      expect(await screen.findByText('Create an address')).toBeInTheDocument()
      // The typed text seeds the street.
      expect(screen.getByLabelText('Number and street')).toHaveValue(street)
      fireEvent.change(screen.getByLabelText('City'), { target: { value: city } })
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    }

    it('geocodes the hand-typed address and places the point there', async () => {
      const fetchMock = stubOSM(
        true,
        () => new Response(JSON.stringify({ results: [{ label: 'x', lat: 43.6, lon: 1.44 }] })),
      )
      const onChange = vi.fn()
      render(<GeoPointWidget field={{ name: 'geo_location', type: 'geo' }} value={null} onChange={onChange} />)
      await createByHand('3 Impasse Y', 'Toulouse')
      await waitFor(() =>
        expect(onChange).toHaveBeenCalledWith({ type: 'Point', coordinates: [1.44, 43.6] }),
      )
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
        encodeURIComponent('3 Impasse Y, Toulouse'),
      )
      await waitFor(() => expect(screen.queryByText('Create an address')).toBeNull())
      vi.unstubAllGlobals()
    })

    const toulouse = {
      label: '3 Impasse Y, Toulouse, France',
      number: 3,
      street: 'Impasse Y',
      complement: '',
      zip_code: '31000',
      city: 'Toulouse',
      state: 'Occitanie',
      country: 'France',
      lat: 43.6,
      lon: 1.44,
    }

    it('autocompletes the street, fills every field and places the pin without geocoding again', async () => {
      const fetchMock = stubOSM(true, () => new Response(JSON.stringify({ results: [toulouse] })))
      const onChange = vi.fn()
      render(<GeoPointWidget field={{ name: 'geo_location', type: 'geo' }} value={null} onChange={onChange} />)
      const search = await screen.findByLabelText(/search an address/i)
      fireEvent.change(search, { target: { value: 'nowhere' } })
      fireEvent.keyDown(search, { key: 'ArrowDown' })
      fireEvent.click(await screen.findByText('Create…'))
      const street = await screen.findByLabelText('Number and street')
      fireEvent.change(street, { target: { value: '3 Impasse' } })
      fireEvent.click(await screen.findByText(toulouse.label, {}, { timeout: 2000 }))
      expect(screen.getByLabelText('Number and street')).toHaveValue('3 Impasse Y')
      expect(screen.getByLabelText('Zip code')).toHaveValue('31000')
      expect(screen.getByLabelText('City')).toHaveValue('Toulouse')
      expect(screen.getByLabelText('State')).toHaveValue('Occitanie')
      expect(screen.getByLabelText('Country')).toHaveValue('France')
      const searches = fetchMock.mock.calls.length
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
      await waitFor(() =>
        expect(onChange).toHaveBeenCalledWith({ type: 'Point', coordinates: [1.44, 43.6] }),
      )
      expect(fetchMock.mock.calls.length).toBe(searches)
      // The completed address is kept on the device, with where it is.
      expect(useRecentAddressStore.getState().addresses[0]).toMatchObject({
        street: '3 Impasse Y',
        city: 'Toulouse',
        lat: 43.6,
        lon: 1.44,
      })
      vi.unstubAllGlobals()
    })

    it('remembers a hand-typed address once it is created', async () => {
      stubOSM(true, () => new Response(JSON.stringify({ results: [{ label: 'x', lat: 43.6, lon: 1.44 }] })))
      render(<GeoPointWidget field={{ name: 'geo_location', type: 'geo' }} value={null} onChange={vi.fn()} />)
      await createByHand('3 Impasse Y', 'Toulouse')
      await waitFor(() =>
        expect(useRecentAddressStore.getState().addresses[0]).toMatchObject({
          label: '3 Impasse Y, Toulouse',
          lat: 43.6,
          lon: 1.44,
        }),
      )
      vi.unstubAllGlobals()
    })

    it('offers the recent addresses while nothing is typed, and places a picked one', async () => {
      const fetchMock = stubOSM(true, () => new Response(JSON.stringify({ results: [] })))
      useRecentAddressStore.getState().remember({
        label: '1 Rue X, 69001 Lyon',
        street: '1 Rue X',
        zip_code: '69001',
        city: 'Lyon',
        state: '',
        country: '',
        lat: 45.75,
        lon: 4.85,
      })
      const onChange = vi.fn()
      render(<GeoPointWidget field={{ name: 'geo_location', type: 'geo' }} value={null} onChange={onChange} />)
      const search = await screen.findByLabelText(/search an address/i)
      fireEvent.keyDown(search, { key: 'ArrowDown' })
      fireEvent.click(await screen.findByText('1 Rue X, 69001 Lyon'))
      await waitFor(() =>
        expect(onChange).toHaveBeenCalledWith({ type: 'Point', coordinates: [4.85, 45.75] }),
      )
      // Its stored position is used: no geocoding.
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/osm/search'))).toBe(false)
      vi.unstubAllGlobals()
    })

    it("drops the pin at the map's center when the address can't be found", async () => {
      stubOSM(true, () => new Response(JSON.stringify({ results: [] })))
      const onChange = vi.fn()
      render(<GeoPointWidget field={{ name: 'geo_location', type: 'geo' }} value={null} onChange={onChange} />)
      await createByHand('Nowhere', 'Atlantis')
      await waitFor(() =>
        expect(onChange).toHaveBeenCalledWith({ type: 'Point', coordinates: [2.5, 46.5] }),
      )
      expect(await screen.findByText('Address not found')).toBeInTheDocument()
      vi.unstubAllGlobals()
    })
  })

  describe('autoLocate', () => {
    const autoField = {
      name: 'geo_location',
      type: 'geo' as const,
      widgetOptions: { address: 'address', autoLocate: true },
    }
    const lyon = {
      id: 'p1',
      address_number: 1,
      address_street: 'Rue X',
      address_zip_code: '69001',
      address_city: 'Lyon',
      address_country: 'France',
    }
    const geocodeCalls = (fetchMock: ReturnType<typeof stubOSM>) =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/osm/search'))

    it('geocodes the address once it is edited and moves the point there', async () => {
      const fetchMock = stubOSM(
        true,
        () => new Response(JSON.stringify({ results: [{ label: 'x', lat: 45.75, lon: 4.85 }] })),
      )
      const onChange = vi.fn()
      const { rerender } = render(
        <GeoPointWidget field={autoField} value={null} onChange={onChange} draft={lyon} />,
      )
      await act(async () => {})
      rerender(
        <GeoPointWidget
          field={autoField}
          value={null}
          onChange={onChange}
          draft={{ ...lyon, address_number: 2 }}
        />,
      )
      await waitFor(
        () => expect(onChange).toHaveBeenCalledWith({ type: 'Point', coordinates: [4.85, 45.75] }),
        { timeout: 2000 },
      )
      expect(geocodeCalls(fetchMock)).toHaveLength(1)
      expect(String(geocodeCalls(fetchMock)[0][0])).toContain(
        encodeURIComponent('2 Rue X, 69001 Lyon, France'),
      )
      vi.unstubAllGlobals()
    })

    it('never geocodes on load or when switching records', async () => {
      const fetchMock = stubOSM(true, () => new Response(JSON.stringify({ results: [] })))
      const onChange = vi.fn()
      const { rerender } = render(
        <GeoPointWidget field={autoField} value={null} onChange={onChange} draft={lyon} />,
      )
      await act(async () => {})
      rerender(
        <GeoPointWidget
          field={autoField}
          value={null}
          onChange={onChange}
          draft={{ ...lyon, id: 'p2', address_city: 'Paris' }}
        />,
      )
      await act(async () => {
        await new Promise((r) => setTimeout(r, AUTO_LOCATE_DEBOUNCE_MS + 100))
      })
      expect(geocodeCalls(fetchMock)).toHaveLength(0)
      expect(onChange).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })
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
