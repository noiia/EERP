'use server'
import { apiRequest } from '@eerp/core-front/server'
import type { NotebookPageRecord } from '@eerp/core-front'

// Entity-generic Server Actions backing the engine's NotebookOps: how the
// notebook renderer (client) lists/creates/updates/removes a RECORD'S OWN
// runtime pages (docs/roadmaps/responsive-displays.md, Phase 5). Always
// through the BFF apiRequest helper — never the generic entity ApiClient,
// since notebook_page is a dedicated, anchor-scoped resource off the generic
// CRUD surface (permission derives from the /notebook_pages route). Mounted
// once app-wide by the root layout's NotebookOpsProvider, mirroring GraphOps.

interface NotebookPageDTO {
  id: string
  table_name: string
  record_id: string
  title: string
  position: number
  content: string
}

function fromDTO(dto: NotebookPageDTO): NotebookPageRecord {
  return { id: dto.id, title: dto.title, content: dto.content, position: dto.position }
}

export async function listNotebookPages(table: string, recordId: string): Promise<NotebookPageRecord[]> {
  const res = await apiRequest<{ data: NotebookPageDTO[] }>(
    'GET',
    `/notebook_pages?table=${encodeURIComponent(table)}&record=${encodeURIComponent(recordId)}`,
  )
  return res.data.map(fromDTO)
}

export async function createNotebookPage(
  table: string,
  recordId: string,
  title: string,
): Promise<NotebookPageRecord> {
  const dto = await apiRequest<NotebookPageDTO>('POST', '/notebook_pages', {
    table_name: table,
    record_id: recordId,
    title,
  })
  return fromDTO(dto)
}

export async function updateNotebookPage(
  id: string,
  patch: { title: string; content: string },
): Promise<NotebookPageRecord> {
  const dto = await apiRequest<NotebookPageDTO>('PUT', `/notebook_pages/${id}`, patch)
  return fromDTO(dto)
}

export async function removeNotebookPage(id: string): Promise<void> {
  await apiRequest<void>('DELETE', `/notebook_pages/${id}`)
}
