'use client'
import { useEffect, useRef, useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type * as Leaflet from 'leaflet'
import { useT } from '../i18n/translate'
import { useOSMSuggestions, type OSMSuggestion } from './address-widget'
import { ADDRESS_SUFFIXES, type GeoJSONGeometry } from './descriptor'
import { pinIcon, useLeafletMap } from './geo-map'
import type { WidgetProps } from './widgets'

type LonLat = [number, number]
const MAP_SX = {
  height: 280,
  borderRadius: 1,
  overflow: 'hidden',
  border: 1,
  borderColor: 'divider',
}

function asPoint(value: unknown): LonLat | null {
  const v = value as GeoJSONGeometry | null
  return v && v.type === 'Point' ? v.coordinates : null
}

/** "12 Rue X, 75001 Paris, France" from an address field's sibling columns. */
function addressLine(draft: Record<string, unknown> | undefined, prefix: string): string {
  const get = (s: (typeof ADDRESS_SUFFIXES)[number]) =>
    String(draft?.[`${prefix}_${s}`] ?? '').trim()
  const street = [get('number'), get('street')].filter(Boolean).join(' ')
  const city = [get('zip_code'), get('city')].filter(Boolean).join(' ')
  return [street, get('complement'), city, get('state'), get('country')].filter(Boolean).join(', ')
}

async function geocode(q: string): Promise<LonLat | null> {
  const res = await fetch(`/api/integrations/osm/search?q=${encodeURIComponent(q)}`).catch(
    () => null,
  )
  if (!res?.ok) return null
  const body = (await res.json().catch(() => ({}))) as { results?: OSMSuggestion[] }
  const hit = body.results?.find((r) => r.lat != null && r.lon != null)
  return hit ? [hit.lon as number, hit.lat as number] : null
}

/** Whether the workspace's OSM connector is on (BFF status route) — address
 * search and "Locate from address" can't work without it. False until known
 * and on any error. */
function useOSMEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let live = true
    fetch('/api/integrations/osm/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { enabled?: boolean } | null) => live && setEnabled(body?.enabled === true))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return enabled
}

/** geo/point — a draggable marker; click to place; address search; locate. */
export function GeoPointWidget({ field, value, onChange, disabled, draft }: WidgetProps) {
  const t = useT()
  const container = useRef<HTMLDivElement | null>(null)
  const { L, map } = useLeafletMap(container, !disabled)
  const marker = useRef<Leaflet.Marker | null>(null)
  const point = asPoint(value)
  const { options, search } = useOSMSuggestions()
  const [locating, setLocating] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const osmEnabled = useOSMEnabled()
  const addressPrefix =
    typeof field.widgetOptions?.address === 'string' ? field.widgetOptions.address : null

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const set = (ll: LonLat | null) =>
    onChangeRef.current(ll ? { type: 'Point', coordinates: ll } : null)
  const setRef = useRef(set)
  setRef.current = set

  // Map clicks place the point (editable maps only).
  useEffect(() => {
    if (!map || disabled) return
    const onClick = (e: Leaflet.LeafletMouseEvent) => setRef.current([e.latlng.lng, e.latlng.lat])
    map.on('click', onClick)
    return () => {
      map.off('click', onClick)
    }
  }, [map, disabled])

  // A new map (disabled toggled, remount) starts without our old marker.
  useEffect(
    () => () => {
      marker.current?.remove()
      marker.current = null
    },
    [map],
  )

  // Keep the marker in sync with the value.
  useEffect(() => {
    if (!L || !map) return
    if (!point) {
      marker.current?.remove()
      marker.current = null
      return
    }
    const latlng: [number, number] = [point[1], point[0]]
    if (marker.current) marker.current.setLatLng(latlng)
    else {
      marker.current = L.marker(latlng, { icon: pinIcon(L), draggable: !disabled }).addTo(map)
      marker.current.on('dragend', () => {
        const ll = marker.current?.getLatLng()
        if (ll) setRef.current([ll.lng, ll.lat])
      })
    }
    map.setView(latlng, Math.max(map.getZoom?.() ?? 13, 13))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L, map, point?.[0], point?.[1], disabled])

  const locate = async () => {
    if (!addressPrefix) return
    setLocating(true)
    setNotFound(false)
    try {
      const found = await geocode(
        addressLine(draft as Record<string, unknown> | undefined, addressPrefix),
      )
      if (found) set(found)
      else setNotFound(true)
    } finally {
      setLocating(false)
    }
  }

  return (
    <Stack spacing={1}>
      {!disabled && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          {osmEnabled && (
            <Autocomplete
              sx={{ flex: 1 }}
              size="small"
              options={options}
              filterOptions={(o) => o}
              getOptionLabel={(o) => (typeof o === 'string' ? o : o.label)}
              onInputChange={(_, q, reason) => reason === 'input' && search(q)}
              onChange={(_, o) =>
                o && typeof o !== 'string' && o.lat != null && o.lon != null && set([o.lon, o.lat])
              }
              renderInput={(params) => <TextField {...params} label={t('Search an address')} />}
            />
          )}
          {osmEnabled && addressPrefix && (
            <Button
              variant="outlined"
              size="small"
              onClick={() => void locate()}
              disabled={locating}
            >
              {t('Locate from address')}
            </Button>
          )}
          {point && (
            <Button size="small" onClick={() => set(null)}>
              {t('Clear')}
            </Button>
          )}
        </Stack>
      )}
      {notFound && (
        <Typography variant="caption" color="error">
          {t('Address not found')}
        </Typography>
      )}
      <Box ref={container} sx={MAP_SX} data-testid="geo-map" />
      {point && (
        <Typography variant="caption" color="text.secondary">
          {point[1].toFixed(6)}, {point[0].toFixed(6)}
        </Typography>
      )}
    </Stack>
  )
}

/** The outer ring of a Polygon value, without its closing repeat. */
function ringOf(value: unknown): LonLat[] {
  const v = value as GeoJSONGeometry | null
  if (!v || v.type !== 'Polygon') return []
  const ring = v.coordinates[0] ?? []
  return ring.slice(0, Math.max(ring.length - 1, 0))
}

/** geo/shape — a minimal polygon editor: click adds a vertex, drag moves one,
 * clicking a vertex removes it. Stored lines/multipolygons show read-only. */
export function GeoShapeWidget({ value, onChange, disabled }: WidgetProps) {
  const t = useT()
  const container = useRef<HTMLDivElement | null>(null)
  const { L, map } = useLeafletMap(container, !disabled)
  const [vertices, setVertices] = useState<LonLat[]>(() => ringOf(value))
  const verticesRef = useRef<LonLat[]>(vertices)
  const lastEmitted = useRef<string>(JSON.stringify(value ?? null))
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const layers = useRef<{ remove: () => void }[]>([])
  const editable = !disabled && (value == null || (value as GeoJSONGeometry).type === 'Polygon')

  const emit = (next: LonLat[]) => {
    verticesRef.current = next
    setVertices(next)
    // Fewer than 3 vertices is no polygon: clear a previously emitted one.
    // In-progress 1-2 vertices stay local.
    const out: GeoJSONGeometry | null =
      next.length >= 3 ? { type: 'Polygon', coordinates: [[...next, next[0]]] } : null
    const key = JSON.stringify(out)
    if (out === null && lastEmitted.current === key) return
    lastEmitted.current = key
    onChangeRef.current(out)
  }
  const emitRef = useRef(emit)
  emitRef.current = emit

  // External change (cancel, revert, reload): adopt the new value's ring.
  useEffect(() => {
    const key = JSON.stringify(value ?? null)
    if (key === lastEmitted.current) return
    lastEmitted.current = key
    const ring = ringOf(value)
    verticesRef.current = ring
    setVertices(ring)
  }, [value])

  useEffect(() => {
    if (!map || !editable) return
    const onClick = (e: Leaflet.LeafletMouseEvent) =>
      emitRef.current([...verticesRef.current, [e.latlng.lng, e.latlng.lat]])
    map.on('click', onClick)
    return () => {
      map.off('click', onClick)
    }
  }, [map, editable])

  // A new map starts without our old layers.
  useEffect(
    () => () => {
      for (const layer of layers.current) layer.remove()
      layers.current = []
    },
    [map],
  )

  // Redraw the polygon and its vertex handles.
  useEffect(() => {
    if (!L || !map) return
    for (const layer of layers.current) layer.remove()
    layers.current = []
    const v = value as GeoJSONGeometry | null
    if (v && v.type !== 'Polygon') {
      const shape =
        v.type === 'LineString'
          ? L.polyline(v.coordinates.map(([lon, lat]) => [lat, lon] as [number, number])).addTo(map)
          : v.type === 'MultiPolygon'
            ? L.polygon(
                v.coordinates.map((poly) =>
                  poly.map((ring) => ring.map(([lon, lat]) => [lat, lon] as [number, number])),
                ),
              ).addTo(map)
            : null
      if (shape) {
        layers.current.push(shape)
        map.fitBounds(shape.getBounds())
      }
      return
    }
    if (vertices.length >= 2) {
      const poly = L.polygon(vertices.map(([lon, lat]) => [lat, lon] as [number, number])).addTo(
        map,
      )
      layers.current.push(poly)
    }
    if (editable) {
      vertices.forEach(([lon, lat], i) => {
        const handle = L.marker([lat, lon], { icon: pinIcon(L), draggable: true }).addTo(map)
        handle.on('dragend', () => {
          const ll = handle.getLatLng()
          emitRef.current(verticesRef.current.map((p, j) => (j === i ? [ll.lng, ll.lat] : p)))
        })
        handle.on('click', () => emitRef.current(verticesRef.current.filter((_, j) => j !== i)))
        layers.current.push(handle)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L, map, vertices, editable, value])

  return (
    <Stack spacing={1}>
      {editable && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            {t('Click the map to add points; click a point to remove it.')}
          </Typography>
          {vertices.length > 0 && (
            <Button size="small" onClick={() => emit([])}>
              {t('Clear')}
            </Button>
          )}
        </Stack>
      )}
      <Box ref={container} sx={MAP_SX} data-testid="geo-map" />
    </Stack>
  )
}
