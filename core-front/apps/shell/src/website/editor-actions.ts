'use server'
import type { ReactNode } from 'react'
import { ApiError, unwrapActionResult } from '@eerp/core-front/server'
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
  if (!id && block.type === 'record_detail' && typeof block.config.table === 'string' && block.config.table) {
    const first = await serverPublicSource.list(block.config.table, { page_size: 1 })
    id = first?.records[0]?.id as string | undefined
  }
  try {
    return await BlockView({ block, source: serverPublicSource, params: { id } })
  } catch {
    return null // a half-configured block (e.g. a table not published yet) previews as empty
  }
}

/** Saves the page layout; returns Go's validation message on failure, null on success. */
export async function saveLayout(id: string, layout: Block[]): Promise<string | null> {
  try {
    unwrapActionResult(await updateRecord('website_page', id, { layout }))
    return null
  } catch (e) {
    return e instanceof ApiError ? e.message : 'Could not save.'
  }
}
