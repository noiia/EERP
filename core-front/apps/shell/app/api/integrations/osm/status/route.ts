import { NextResponse } from 'next/server'
import { getOSMConnector } from '@/lib/osm-settings'

// GET /api/integrations/osm/status -> { enabled } — whether address search can
// work at all, so the geo point widget shows its search and "Locate from
// address" only when the workspace's OSM connector is on. Same server-side
// read as the search route (the connector config never reaches the browser).
export async function GET() {
  const connector = await getOSMConnector()
  return NextResponse.json({ enabled: connector.enabled && connector.base_url !== '' })
}
