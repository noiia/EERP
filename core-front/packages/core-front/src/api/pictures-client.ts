import { parseError } from './errors'

// Browser-side client for the picture service. Widgets never talk to Go: uploads
// and reads go browser → Next (the /api/pictures BFF routes) → Go → S3, per the
// BFF rule (docs/roadmaps/field-widgets.md, Phase 3). This module is client-safe;
// the server half (the Go-facing helpers the BFF routes use) lives in
// ApiClient.ts behind the server barrel.

/** One picture's metadata, as the service returns it (object keys never leave Go). */
export interface PictureMeta {
  id: string
  table_name: string
  record_id: string
  field: string
  mime: string
  size: number
}

/**
 * Where a picture hangs off a record: the Go table (= descriptor entity), the
 * record id, and the field name. One picture exists per anchor — the invariant
 * picture-backed boolean fields rely on (field true ⇔ picture exists).
 */
export interface PictureAnchor {
  table: string
  recordId: string
  field: string
}

export interface PictureClient {
  /** Resolve an anchor to its picture, or null when the field has none. */
  find(anchor: PictureAnchor): Promise<PictureMeta | null>
  /** Upload (or replace — the service keeps one picture per anchor). */
  upload(anchor: PictureAnchor, file: Blob, filename?: string): Promise<PictureMeta>
  remove(id: string): Promise<void>
  /** The browser-facing URL streaming the image (for <img src>). */
  url(id: string): string
}

/**
 * Build the client against the Next BFF routes. `fetchImpl` is injectable for
 * tests; widgets consume the client through PictureClientProvider, so stubbing
 * the whole client is usually simpler still.
 */
export function createPictureClient(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  base = '/api/pictures',
): PictureClient {
  return {
    async find(anchor) {
      const query = new URLSearchParams({
        table: anchor.table,
        record: anchor.recordId,
        field: anchor.field,
      })
      const res = await fetchImpl(`${base}?${query}`)
      // 404 is the anchor's normal empty state, not a failure.
      if (res.status === 404) return null
      if (!res.ok) throw await parseError(res)
      return (await res.json()) as PictureMeta
    },

    async upload(anchor, file, filename = 'upload.png') {
      const form = new FormData()
      form.set('table_name', anchor.table)
      form.set('record_id', anchor.recordId)
      form.set('field', anchor.field)
      form.set('file', file, filename)
      const res = await fetchImpl(base, { method: 'POST', body: form })
      if (!res.ok) throw await parseError(res)
      return (await res.json()) as PictureMeta
    },

    async remove(id) {
      const res = await fetchImpl(`${base}/${id}`, { method: 'DELETE' })
      if (!res.ok) throw await parseError(res)
    },

    url(id) {
      return `${base}/${id}`
    },
  }
}
