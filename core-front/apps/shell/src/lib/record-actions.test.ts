import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiRequestMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return { ...actual, apiRequest: (...args: unknown[]) => apiRequestMock(...args) }
})

import { createChatterMessage, listChatterMessages } from './chatter-actions'
import {
  createNotebookPage,
  listNotebookPages,
  removeNotebookPage,
  updateNotebookPage,
} from './notebook-actions'
import {
  createSavedFilter,
  listSavedFilters,
  removeSavedFilter,
  updateSavedFilter,
} from './saved-filter-actions'

beforeEach(() => {
  apiRequestMock.mockReset()
})

describe('chatter actions', () => {
  const dto = {
    id: 'm1',
    table_name: 'crm',
    record_id: 'r 1',
    author_id: 'u1',
    author_email: 'a@x.test',
    kind: 'message',
    body: 'hi',
    created_at: '2026-01-01T00:00:00Z',
  }
  const record = {
    id: 'm1',
    author: 'a@x.test',
    authorId: 'u1',
    kind: 'message',
    body: 'hi',
    createdAt: '2026-01-01T00:00:00Z',
  }

  it('lists a record feed, URL-encoding the anchor', async () => {
    apiRequestMock.mockResolvedValue({ data: [dto] })
    await expect(listChatterMessages('crm', 'r 1')).resolves.toEqual([record])
    expect(apiRequestMock).toHaveBeenCalledWith('GET', '/chatter_messages?table=crm&record=r%201')
  })

  it('posts a message with the backend field names', async () => {
    apiRequestMock.mockResolvedValue(dto)
    await expect(createChatterMessage('crm', 'r 1', 'message', 'hi')).resolves.toEqual(record)
    expect(apiRequestMock).toHaveBeenCalledWith('POST', '/chatter_messages', {
      table_name: 'crm',
      record_id: 'r 1',
      kind: 'message',
      body: 'hi',
    })
  })
})

describe('notebook actions', () => {
  const dto = {
    id: 'p1',
    table_name: 'crm',
    record_id: 'r1',
    title: 'Notes',
    position: 2,
    content: 'x',
  }
  const page = { id: 'p1', title: 'Notes', content: 'x', position: 2 }

  it('lists, creates, updates and removes pages', async () => {
    apiRequestMock.mockResolvedValueOnce({ data: [dto] })
    await expect(listNotebookPages('crm', 'r1')).resolves.toEqual([page])
    expect(apiRequestMock).toHaveBeenLastCalledWith('GET', '/notebook_pages?table=crm&record=r1')

    apiRequestMock.mockResolvedValueOnce(dto)
    await expect(createNotebookPage('crm', 'r1', 'Notes')).resolves.toEqual(page)
    expect(apiRequestMock).toHaveBeenLastCalledWith('POST', '/notebook_pages', {
      table_name: 'crm',
      record_id: 'r1',
      title: 'Notes',
    })

    apiRequestMock.mockResolvedValueOnce(dto)
    await expect(updateNotebookPage('p1', { title: 'Notes', content: 'x' })).resolves.toEqual(page)
    expect(apiRequestMock).toHaveBeenLastCalledWith('PUT', '/notebook_pages/p1', {
      title: 'Notes',
      content: 'x',
    })

    apiRequestMock.mockResolvedValueOnce(undefined)
    await removeNotebookPage('p1')
    expect(apiRequestMock).toHaveBeenLastCalledWith('DELETE', '/notebook_pages/p1')
  })
})

describe('saved filter actions', () => {
  const config = { filters: [{ field: 'status', op: 'eq', value: 'lead' }] }
  const dto = {
    id: 'f1',
    entity: 'crm',
    name: 'Leads',
    shared: true,
    mine: true,
    config: JSON.stringify(config),
  }

  it('parses the stored config JSON', async () => {
    apiRequestMock.mockResolvedValue({ data: [dto] })
    const [filter] = await listSavedFilters('crm')
    expect(filter).toEqual({
      id: 'f1',
      entity: 'crm',
      name: 'Leads',
      shared: true,
      mine: true,
      config,
    })
    expect(apiRequestMock).toHaveBeenCalledWith('GET', '/saved_filters?entity=crm')
  })

  it('falls back to an empty config when the stored JSON is corrupt', async () => {
    apiRequestMock.mockResolvedValue({ data: [{ ...dto, config: '{not json' }] })
    const [filter] = await listSavedFilters('crm')
    expect(filter.config).toEqual({ filters: [] })
  })

  it('serializes the config on create and update, and deletes by id', async () => {
    apiRequestMock.mockResolvedValue(dto)
    await createSavedFilter('crm', 'Leads', true, config as never)
    expect(apiRequestMock).toHaveBeenLastCalledWith('POST', '/saved_filters', {
      entity: 'crm',
      name: 'Leads',
      shared: true,
      config: JSON.stringify(config),
    })
    await updateSavedFilter('f1', { name: 'Leads 2', shared: false, config: config as never })
    expect(apiRequestMock).toHaveBeenLastCalledWith('PUT', '/saved_filters/f1', {
      name: 'Leads 2',
      shared: false,
      config: JSON.stringify(config),
    })
    await removeSavedFilter('f1')
    expect(apiRequestMock).toHaveBeenLastCalledWith('DELETE', '/saved_filters/f1')
  })
})
