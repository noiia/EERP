'use server'
import { apiRequest } from '@eerp/core-front/server'
import type { ChatterMessageRecord } from '@eerp/core-front'

// Entity-generic Server Actions backing the engine's ChatterOps: how the form
// chatter panel (client) lists/posts a RECORD'S OWN activity feed. Always
// through the BFF apiRequest helper — never the generic entity ApiClient,
// since chatter_message is a dedicated, anchor-scoped resource off the
// generic CRUD surface (permission derives from the /chatter_messages route).
// Mounted once app-wide by the root layout's ChatterOpsProvider, mirroring
// NotebookOps.

interface ChatterMessageDTO {
  id: string
  table_name: string
  record_id: string
  author_id: string
  author_email: string
  kind: 'message' | 'log'
  body: string
  created_at: string
}

function fromDTO(dto: ChatterMessageDTO): ChatterMessageRecord {
  return { id: dto.id, author: dto.author_email, kind: dto.kind, body: dto.body, createdAt: dto.created_at }
}

export async function listChatterMessages(
  table: string,
  recordId: string,
): Promise<ChatterMessageRecord[]> {
  const res = await apiRequest<{ data: ChatterMessageDTO[] }>(
    'GET',
    `/chatter_messages?table=${encodeURIComponent(table)}&record=${encodeURIComponent(recordId)}`,
  )
  return res.data.map(fromDTO)
}

export async function createChatterMessage(
  table: string,
  recordId: string,
  kind: ChatterMessageRecord['kind'],
  body: string,
): Promise<ChatterMessageRecord> {
  const dto = await apiRequest<ChatterMessageDTO>('POST', '/chatter_messages', {
    table_name: table,
    record_id: recordId,
    kind,
    body,
  })
  return fromDTO(dto)
}
