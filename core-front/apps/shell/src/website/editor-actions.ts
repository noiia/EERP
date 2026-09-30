'use server'
import type { ReactNode } from 'react'
import { ApiError, apiRequest, unwrapActionResult } from '@eerp/core-front/server'
import { updateRecord } from '../../app/app/[...module]/actions'
import { getIdentity } from '@/lib/session'
import { BlockView } from './blocks/BlockView'
import { serverPublicSource } from './public-api'
import type { Block } from './types'

// Server Actions behind the page editor (app/app/website/pages/[id]/design).

/** Live preview: the SAME BlockView the public site renders, over the same public
 * API, returned as RSC. A record_detail block has no URL id in the editor, so it
 * previews the table's first published record. */
export async function previewBlock(block: Block, params: { id?: string }): Promise<ReactNode> {
  if (!(await getIdentity())) return null
  let id = params.id
  if (!id && block.type === 'record_detail' && !block.config.record && typeof block.config.table === 'string' && block.config.table) {
    const first = await serverPublicSource.list(block.config.table, { page_size: 1 })
    id = first?.records[0]?.id as string | undefined
  }
  try {
    return await BlockView({ block, source: serverPublicSource, params: { id } })
  } catch {
    return null // a half-configured block (e.g. a table not published yet) previews as empty
  }
}

/** Saves the page layout; returns null on success, Go's validation message on failure,
 * or '' for a failure without one (the editor shows its translated fallback). */
export async function saveLayout(id: string, layout: Block[]): Promise<string | null> {
  try {
    unwrapActionResult(await updateRecord('website_page', id, { layout }))
    return null
  } catch (e) {
    return e instanceof ApiError ? e.message : ''
  }
}

/** Events a booking block can point at (staff view: published or not — the
 * block renders nothing until the event is published). */
export async function listEditorEvents(kind: 'sessions' | 'appointment'): Promise<{ id: string; name: string }[]> {
  try {
    const q = new URLSearchParams({ page_size: '200', 'filter[kind]': kind })
    return (await apiRequest<{ data: { id: string; name: string }[] }>('GET', `/event?${q}`)).data ?? []
  } catch {
    return []
  }
}

/** Records a block can point at, for the editor's record picker (staff view, so
 * unpublished rows are offered too — the site shows only published ones).
 * `q` searches the label column; `ids` fetches the labels of already-picked rows. */
export async function listEditorRecords(table: string, labelField: string, q: { search?: string; ids?: string[] }): Promise<{ id: string; label: string }[]> {
  if (!table) return []
  const col = labelField || 'id'
  const params = new URLSearchParams({ page_size: '20' })
  if (q.ids?.length) params.set('in[id]', q.ids.join(','))
  else if (q.search && col !== 'id') params.set(`search[${col}]`, q.search)
  try {
    const res = await apiRequest<{ data: Record<string, unknown>[] }>('GET', `/${encodeURIComponent(table)}?${params}`)
    return (res.data ?? []).map((r) => ({ id: String(r.id), label: String(r[col] ?? r.id) }))
  } catch {
    return []
  }
}
