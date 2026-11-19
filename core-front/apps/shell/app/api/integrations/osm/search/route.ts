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
  municipality?: string
  hamlet?: string
  state?: string
  country?: string
}

interface NominatimResult {
  display_name: string
  address?: NominatimAddress
  lat?: string
  lon?: string
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
  lat: number | null
  lon: number | null
}

/**
 * The suggestion's label: only the parts an address field stores — number
 * (with its extension, "12 bis"), street, ONE city, state, country, zip code — instead of Nominatim's
 * `display_name`, which also lists suburb, county, region... Falls back to
 * `display_name` when the result carries none of them (a bare place).
 */
function suggestionLabel(s: Omit<OSMSuggestion, 'label'>, displayName: string): string {
  const street = [s.number ?? '', s.street].filter((p) => p !== '').join(' ')
  const label = [street, s.city, s.state, s.country, s.zip_code].filter((p) => p !== '').join(', ')
  return label || displayName
}

/**
 * Splits Nominatim's free-text `house_number` into the integer the address
 * field stores and its extension: "12bis" / "12 bis" -> {12, "bis"},
 * "4B" -> {4, "B"}. Only a letters-only suffix counts as an extension (bis,
 * ter, quater, A, B...) — a range like "12-14" keeps just its first number.
 */
function parseHouseNumber(raw: string | undefined): { number: number | null; extension: string } {
  const match = /^\s*(\d+)\s*([^\d\s-].*)?$/u.exec(raw ?? '')
  if (!match) {
    const n = Number.parseInt(raw ?? '', 10)
    return { number: Number.isFinite(n) ? n : null, extension: '' }
  }
  const extension = (match[2] ?? '').trim()
  return {
    number: Number(match[1]),
    extension: /^\p{L}+$/u.test(extension) ? extension : '',
  }
}

function toSuggestion(result: NominatimResult): OSMSuggestion {
  const address = result.address ?? {}
  const { number, extension } = parseHouseNumber(address.house_number)
  const road = address.road ?? ''
  const parts = {
    number,
    // The extension rides at the head of the street ("bis Rue X"): the
    // number column is an integer, and AddressWidget's combined "Number and
    // street" input reads number + street back as "12 bis Rue X" — exactly
    // what typing it by hand stores too.
    street: [extension, road].filter((p) => p !== '').join(' '),
    complement: '',
    zip_code: address.postcode ?? '',
    // One city only: the first locality level Nominatim filled in.
    city:
      address.city ??
      address.town ??
      address.village ??
      address.municipality ??
      address.hamlet ??
      '',
    state: address.state ?? '',
    country: address.country ?? '',
    lat: result.lat != null && Number.isFinite(Number(result.lat)) ? Number(result.lat) : null,
    lon: result.lon != null && Number.isFinite(Number(result.lon)) ? Number(result.lon) : null,
  }
  return { label: suggestionLabel(parts, result.display_name), ...parts }
}

/** Shortened labels can collide (two OSM objects at one address): keep the first. */
function uniqueByLabel(suggestions: OSMSuggestion[]): OSMSuggestion[] {
  const seen = new Set<string>()
  return suggestions.filter((s) => !seen.has(s.label) && seen.add(s.label))
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
    return NextResponse.json({ results: uniqueByLabel(raw.map(toSuggestion)) })
  } catch {
    return NextResponse.json({ results: [] })
  }
}
