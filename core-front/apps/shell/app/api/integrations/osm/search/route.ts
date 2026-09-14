import { NextResponse } from 'next/server'
import { getOSMConnector } from '@/lib/osm-settings'

// BFF proxy for address autocomplete: the browser never calls Nominatim (or
// any OSM-compatible endpoint) directly — this route reads the workspace's
// stored connector config SERVER-SIDE (Settings -> Global settings ->
// Integrations) and forwards the search with the configured User-Agent
// (Nominatim's usage policy requires a real, identifying one on every
// request). Disabled/unconfigured/upstream-failure all degrade to an empty
// result list rather than an error — the AddressWidget's autocomplete is
// optional sugar over plain manual entry, never a hard dependency.

interface NominatimAddress {
  house_number?: string
  road?: string
  postcode?: string
  city?: string
  town?: string
  village?: string
  state?: string
  country?: string
}

interface NominatimResult {
  display_name: string
  address?: NominatimAddress
}

export interface OSMSuggestion {
  label: string
  number: number | null
  street: string
  complement: string
  zip_code: string
  city: string
  state: string
  country: string
}

function toSuggestion(result: NominatimResult): OSMSuggestion {
  const address = result.address ?? {}
  const number = address.house_number ? Number.parseInt(address.house_number, 10) : NaN
  return {
    label: result.display_name,
    number: Number.isFinite(number) ? number : null,
    street: address.road ?? '',
    complement: '',
    zip_code: address.postcode ?? '',
    city: address.city ?? address.town ?? address.village ?? '',
    state: address.state ?? '',
    country: address.country ?? '',
  }
}

// GET /api/integrations/osm/search?q=... -> { results: OSMSuggestion[] }
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get('q')?.trim() ?? ''
  if (q === '') return NextResponse.json({ results: [] })

  const connector = await getOSMConnector()
  if (!connector.enabled || connector.base_url === '') {
    return NextResponse.json({ results: [] })
  }

  const upstream = new URL('/search', connector.base_url)
  upstream.searchParams.set('q', q)
  upstream.searchParams.set('format', 'jsonv2')
  upstream.searchParams.set('addressdetails', '1')
  upstream.searchParams.set('limit', '5')

  try {
    const res = await fetch(upstream.toString(), {
      headers: connector.user_agent ? { 'User-Agent': connector.user_agent } : {},
    })
    if (!res.ok) return NextResponse.json({ results: [] })
    const raw = (await res.json()) as NominatimResult[]
    return NextResponse.json({ results: raw.map(toSuggestion) })
  } catch {
    return NextResponse.json({ results: [] })
  }
}
