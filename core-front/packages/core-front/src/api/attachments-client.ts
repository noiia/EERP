import { parseError } from './errors'

// Browser-side client for the attachment service — the non-image sibling of
// pictures-client.ts, for `boolean/file` fields storing an arbitrary file
// (a purchase invoice, a generated rent-receipt PDF). Same BFF discipline:
// widgets never talk to Go directly, uploads/reads go browser → Next (the
// /api/attachments BFF routes) → Go → S3. This module is client-safe; the
// server half lives in ApiClient.ts behind the server barrel.

/** One attachment's metadata, as the service returns it (object keys never leave Go). */
export interface AttachmentMeta {
  id: string
  table_name: string
  record_id: string
  field: string
  /** The uploader's original filename — round-tripped as the download's
   * Content-Disposition, unlike pictures (never offered as a named download). */
  filename: string
  mime: string
  size: number
}

/**
 * Where an attachment hangs off a record: the Go table (= descriptor
 * entity), the record id, and the field name. One attachment exists per
 * anchor — the invariant file-backed boolean fields rely on (field true ⇔
 * attachment exists). Same shape as PictureAnchor.
 */
export interface AttachmentAnchor {
  table: string
  recordId: string
  field: string
}

export interface AttachmentClient {
  /** Resolve an anchor to its attachment, or null when the field has none. */
  find(anchor: AttachmentAnchor): Promise<AttachmentMeta | null>
  /** Upload (or replace — the service keeps one attachment per anchor). */
  upload(anchor: AttachmentAnchor, file: Blob, filename: string): Promise<AttachmentMeta>
  remove(id: string): Promise<void>
  /** The browser-facing URL that streams (and downloads) the file. */
  url(id: string): string
}

/**
 * Build the client against the Next BFF routes. `fetchImpl` is injectable
 * for tests; widgets consume the client through AttachmentClientProvider,
 * so stubbing the whole client is usually simpler still.
 */
export function createAttachmentClient(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  base = '/api/attachments',
): AttachmentClient {
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
      return (await res.json()) as AttachmentMeta
    },

    async upload(anchor, file, filename) {
      const form = new FormData()
      form.set('table_name', anchor.table)
      form.set('record_id', anchor.recordId)
      form.set('field', anchor.field)
      form.set('file', file, filename)
      const res = await fetchImpl(base, { method: 'POST', body: form })
      if (!res.ok) throw await parseError(res)
      return (await res.json()) as AttachmentMeta
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
