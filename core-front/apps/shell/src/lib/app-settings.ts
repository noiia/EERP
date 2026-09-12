'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Server Actions for Settings -> Apps: the boolean/picture widget's box size,
// either the workspace-wide Base default (module: 'base') or one specific
// app's own override. Same shape as view-fields.ts: GET/PUT
// /settings/apps/:module/picture-size is a dedicated (non-CRUD) backend
// endpoint reached through the BFF request helper, gated by
// settings:apps:read|write. Mutations return a result object instead of
// throwing — Next masks errors thrown inside Server Actions in production.

export type SaveResult = { ok: true } | { ok: false; message: string }

function failure(e: unknown, fallback: string): SaveResult {
  return { ok: false, message: e instanceof ApiError ? e.message : fallback }
}

export interface PictureSize {
  width: number
  height: number
}

/**
 * Read one module's OWN picture-size setting — `null` means "not configured
 * at this level" (inherits Base, or, for module: 'base' itself, the
 * frontend's hardcoded default). Degrades to null on any failure (missing
 * settings:apps:read, session hiccup) rather than throwing.
 */
export async function getModulePictureSize(module: string): Promise<PictureSize | null> {
  try {
    const raw = await apiRequest<{ size: PictureSize | null }>('GET', `/settings/apps/${module}/picture-size`)
    return raw.size
  } catch {
    return null
  }
}

/**
 * Save (or, with `size: null`, clear) one module's own picture-size setting.
 * Go authorizes: callers without settings:apps:write get the error envelope
 * back as a message.
 */
export async function setModulePictureSize(module: string, size: PictureSize | null): Promise<SaveResult> {
  try {
    await apiRequest('PUT', `/settings/apps/${module}/picture-size`, { size })
    return { ok: true }
  } catch (e) {
    return failure(e, 'Could not save the picture size.')
  }
}
