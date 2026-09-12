'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Server Actions for Settings -> Global settings -> Integrations: the
// workspace's OpenStreetMap (Nominatim) connector, used to autocomplete
// addresses as the user types into a type: 'address' field. Same shape as
// report-settings.ts: GET/PUT /settings/integrations/osm is a dedicated
// (non-CRUD) backend endpoint reached through the BFF request helper, gated
// by settings:integrations:read|write. Mutations return a result object
// instead of throwing — Next masks errors thrown inside Server Actions in
// production.

export type SaveResult = { ok: true } | { ok: false; message: string }

function failure(e: unknown, fallback: string): SaveResult {
  return { ok: false, message: e instanceof ApiError ? e.message : fallback }
}

export interface OSMConnector {
  enabled: boolean
  base_url: string
  user_agent: string
}

const DISABLED_CONNECTOR: OSMConnector = { enabled: false, base_url: '', user_agent: '' }

/** Read the workspace's OSM connector config — disabled when unconfigured. */
export async function getOSMConnector(): Promise<OSMConnector> {
  try {
    return await apiRequest<OSMConnector>('GET', '/settings/integrations/osm')
  } catch {
    return DISABLED_CONNECTOR
  }
}

/** Save the workspace's OSM connector config. Go authorizes: callers without
 * settings:integrations:write get the error envelope back as a message. */
export async function setOSMConnector(connector: OSMConnector): Promise<SaveResult> {
  try {
    await apiRequest('PUT', '/settings/integrations/osm', connector)
    return { ok: true }
  } catch (e) {
    return failure(e, 'Could not save the OpenStreetMap connector.')
  }
}
