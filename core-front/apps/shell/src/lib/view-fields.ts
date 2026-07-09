'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'
import { EMPTY_VIEW_FIELDS, type ViewFieldsConfig } from '@eerp/core-front'

// Server Actions for the Kanban/Calendar field config an admin sets per entity
// from Settings -> Views (docs/roadmaps/list-view-modes.md, ADR-006). Same
// shape as preferences.ts: GET/PUT /settings/views/:entity/fields is a
// dedicated (non-CRUD) backend endpoint reached through the BFF request
// helper, gated by settings:views:read|write. Mutations return a result
// object instead of throwing — Next masks errors thrown inside Server Actions
// in production, so the envelope message would never reach the settings UI
// otherwise.

export type SaveResult = { ok: true } | { ok: false; message: string }

function failure(e: unknown, fallback: string): SaveResult {
  return { ok: false, message: e instanceof ApiError ? e.message : fallback }
}

interface RawViewFields {
  kanban_status_field: string | null
  calendar_date_field: string | null
}

/**
 * Read one entity's Kanban/Calendar field config. Degrades to the empty
 * config on any failure (missing settings:views:read, session hiccup) rather
 * than throwing — Settings -> Views then just shows it as unconfigured.
 */
export async function getEntityViewFields(entity: string): Promise<ViewFieldsConfig> {
  try {
    const raw = await apiRequest<RawViewFields>('GET', `/settings/views/${entity}/fields`)
    return { kanbanStatusField: raw.kanban_status_field, calendarDateField: raw.calendar_date_field }
  } catch {
    return EMPTY_VIEW_FIELDS
  }
}

/**
 * Save one entity's Kanban/Calendar field config. Go authorizes: callers
 * without settings:views:write get the error envelope back as a message.
 */
export async function setEntityViewFields(
  entity: string,
  config: ViewFieldsConfig,
): Promise<SaveResult> {
  try {
    await apiRequest('PUT', `/settings/views/${entity}/fields`, {
      kanban_status_field: config.kanbanStatusField,
      calendar_date_field: config.calendarDateField,
    })
    return { ok: true }
  } catch (e) {
    return failure(e, 'Could not save the view field configuration.')
  }
}
