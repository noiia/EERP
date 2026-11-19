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
 * previews the table's first published record (a URL-driven booking block: the first
 * published event of its kind). */
export async function previewBlock(block: Block, params: { id?: string }): Promise<ReactNode> {
  if (!(await getIdentity())) return null
  let id = params.id
  if (!id && block.type === 'record_detail' && !block.config.record && typeof block.config.table === 'string' && block.config.table) {
    const first = await serverPublicSource.list(block.config.table, { page_size: 1 })
    id = first?.records[0]?.id as string | undefined
  }
  // Same for a booking block left on "the event in the URL": the first published event of its kind.
  const bookingKind = block.type === 'event_booking' ? 'sessions' : block.type === 'appointment_booking' ? 'appointment' : null
  if (!id && bookingKind && !block.config.event_id) {
    const first = await serverPublicSource.list('event', { filter: { kind: bookingKind }, page_size: 1 })
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

/** The page's layout as stored right now (staff read, never cached), or null when it
 * can't be read. The workflow map re-reads it just before re-targeting a link, so a
 * save never overwrites blocks added since the map was loaded. */
export async function getPageLayout(id: string): Promise<Block[] | null> {
  try {
    const page = await apiRequest<{ layout: Block[] | null }>('GET', `/website_page/${encodeURIComponent(id)}`)
    return page.layout ?? []
  } catch {
    return null
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

/** Pages a list/carousel can link its cards to (`/<slug>/<id>`); the home page
 * can't take an id, so it's left out. Staff view: unpublished pages too. */
export async function listEditorPages(): Promise<{ slug: string; title: string; published: boolean }[]> {
  try {
    const res = await apiRequest<{ data: { slug: string; title: string; published: boolean | null }[] }>('GET', '/website_page?page_size=200')
    return (res.data ?? []).filter((p) => p.slug).map((p) => ({ slug: p.slug, title: p.title, published: !!p.published }))
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

/** Tables (with their columns) a Form block may write — the ones modules register
 * in Go, active modules only (ADR-033). Empty on failure: the editor then offers none. */
export async function listFormTargets(): Promise<{ table: string; columns: string[] }[]> {
  try {
    return (await apiRequest<{ data: { table: string; columns: string[] }[] }>('GET', '/settings/website/form_targets')).data ?? []
  } catch {
    return []
  }
}

export type WorkflowPositions = Record<string, { x: number; y: number }>

/** Where staff placed the workflow map's boxes, shared by the team (Go
 * `website.workflow_layout`). Empty when nothing is saved or it can't be read: the
 * map then lays every box out automatically. */
export async function getWorkflowPositions(): Promise<WorkflowPositions> {
  try {
    return (await apiRequest<{ positions?: WorkflowPositions }>('GET', '/settings/website/workflow_layout')).positions ?? {}
  } catch {
    return {}
  }
}

/** Replaces every saved box position; null on success, else Go's message ('' without one). */
export async function saveWorkflowPositions(positions: WorkflowPositions): Promise<string | null> {
  try {
    await apiRequest('PUT', '/settings/website/workflow_layout', { positions })
    return null
  } catch (e) {
    return e instanceof ApiError ? e.message : ''
  }
}
