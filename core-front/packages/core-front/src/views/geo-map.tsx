'use client'
import { useEffect, useState, type RefObject } from 'react'
import type * as Leaflet from 'leaflet'

type L = typeof Leaflet

/** OpenStreetMap tiles (no key). Their usage policy forbids heavy use: fine for
 * an ERP's form maps; a busy public site should point this at its own tiles. */
export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '&copy; OpenStreetMap contributors'
/** Whole-world view for a map with nothing on it yet. */
export const WORLD: [number, number] = [20, 0]

/** A pin with no image assets (bundlers mangle Leaflet's default icon paths). */
export function pinIcon(L: L): Leaflet.DivIcon {
  return L.divIcon({
    className: 'eerp-geo-pin',
    html: '<div style="width:16px;height:16px;border-radius:50%;background:#1976d2;border:2px solid #fff;box-shadow:0 0 2px #0008"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  })
}

/**
 * Mounts a Leaflet map in `container` (client-only: Leaflet touches `window`
 * at import, so it is imported lazily here, never at module top level).
 * Non-interactive maps can't be dragged or zoomed — read-only forms.
 */
export function useLeafletMap(container: RefObject<HTMLDivElement | null>, interactive: boolean) {
  const [state, setState] = useState<{ L: L | null; map: Leaflet.Map | null }>({
    L: null,
    map: null,
  })
  useEffect(() => {
    let map: Leaflet.Map | null = null
    let cancelled = false
    void import('leaflet').then((mod) => {
      const L = ((mod as unknown as { default?: L }).default ?? mod) as L
      if (cancelled || !container.current) return
      map = L.map(container.current, {
        dragging: interactive,
        scrollWheelZoom: interactive,
        doubleClickZoom: interactive,
        boxZoom: interactive,
        keyboard: interactive,
        zoomControl: interactive,
      }).setView(WORLD, 2)
      L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map)
      setState({ L, map })
    })
    return () => {
      cancelled = true
      map?.remove()
    }
  }, [container, interactive])
  return state
}
