import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@eerp/core-front/server'

const apiRequestMock = vi.fn()
const updateMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return { ...actual, apiRequest: (...a: unknown[]) => apiRequestMock(...a), createServerApiClient: () => ({ update: updateMock }) }
})
const identity = vi.hoisted(() => ({ value: { userId: 'u' } as unknown }))
vi.mock('@/lib/session', () => ({ getIdentity: async () => identity.value }))
const listMock = vi.hoisted(() => vi.fn())
vi.mock('./public-api', () => ({ serverPublicSource: { list: listMock, get: vi.fn() } }))
const blockViewMock = vi.hoisted(() => vi.fn())
vi.mock('./blocks/BlockView', () => ({ BlockView: blockViewMock }))

import { listEditorEvents, listEditorPages, listEditorRecords, previewBlock, saveLayout } from './editor-actions'
import type { Block } from './types'

const block = (type: Block['type'], config: Record<string, unknown> = {}): Block => ({ id: 'b', type, x: 0, y: 0, w: 1, h: 1, config })

beforeEach(() => {
  apiRequestMock.mockReset()
  updateMock.mockReset()
  listMock.mockReset()
  blockViewMock.mockReset().mockResolvedValue('rendered')
  identity.value = { userId: 'u' }
})

describe('previewBlock', () => {
  it('renders nothing for an anonymous caller', async () => {
    identity.value = null
    expect(await previewBlock(block('text'), {})).toBeNull()
    expect(blockViewMock).not.toHaveBeenCalled()
  })

  it("previews a record_detail on the table's first published record", async () => {
    listMock.mockResolvedValue({ records: [{ id: 'r1' }] })
    expect(await previewBlock(block('record_detail', { table: 'product' }), {})).toBe('rendered')
    expect(listMock).toHaveBeenCalledWith('product', { page_size: 1 })
    expect(blockViewMock.mock.calls[0][0].params).toEqual({ id: 'r1' })
  })

  it('previews a booking block on the first published event of its kind', async () => {
    listMock.mockResolvedValue({ records: [{ id: 'e1' }] })
    await previewBlock(block('appointment_booking'), {})
    expect(listMock).toHaveBeenCalledWith('event', { filter: { kind: 'appointment' }, page_size: 1 })
    listMock.mockResolvedValue(null)
    await previewBlock(block('event_booking'), {})
    expect(listMock).toHaveBeenLastCalledWith('event', { filter: { kind: 'sessions' }, page_size: 1 })
    expect(blockViewMock.mock.calls[1][0].params).toEqual({ id: undefined })
  })

  it('keeps an explicit id and swallows a half-configured block', async () => {
    blockViewMock.mockRejectedValue(new Error('not published'))
    expect(await previewBlock(block('record_detail', { table: 'product' }), { id: 'x' })).toBeNull()
    expect(listMock).not.toHaveBeenCalled()
  })
})

describe('saveLayout', () => {
  it("returns null on success, Go's message or '' on failure", async () => {
    updateMock.mockResolvedValueOnce({})
    expect(await saveLayout('p1', [])).toBeNull()
    expect(updateMock).toHaveBeenCalledWith('website_page', 'p1', { layout: [] })
    updateMock.mockRejectedValueOnce(new ApiError({ code: 'VALIDATION_ERROR', message: 'bad grid', status: 400 }))
    expect(await saveLayout('p1', [])).toBe('bad grid')
  })
})

describe('editor lists', () => {
  it('lists events of a kind', async () => {
    apiRequestMock.mockResolvedValueOnce({ data: [{ id: 'e', name: 'E' }] })
    expect(await listEditorEvents('sessions')).toEqual([{ id: 'e', name: 'E' }])
    expect(apiRequestMock.mock.calls[0][1]).toBe('/event?page_size=200&filter%5Bkind%5D=sessions')
    apiRequestMock.mockResolvedValueOnce({})
    expect(await listEditorEvents('appointment')).toEqual([])
    apiRequestMock.mockRejectedValueOnce(new Error('x'))
    expect(await listEditorEvents('appointment')).toEqual([])
  })

  it('lists pages with a slug', async () => {
    apiRequestMock.mockResolvedValueOnce({ data: [{ slug: '', title: 'Home', published: true }, { slug: 'shop', title: 'Shop', published: null }] })
    expect(await listEditorPages()).toEqual([{ slug: 'shop', title: 'Shop', published: false }])
    apiRequestMock.mockResolvedValueOnce({})
    expect(await listEditorPages()).toEqual([])
    apiRequestMock.mockRejectedValueOnce(new Error('x'))
    expect(await listEditorPages()).toEqual([])
  })

  it('searches or fetches picked records by label', async () => {
    expect(await listEditorRecords('', 'name', {})).toEqual([])
    apiRequestMock.mockResolvedValueOnce({ data: [{ id: 1, name: 'Chair' }, { id: 2 }] })
    expect(await listEditorRecords('product', 'name', { search: 'ch' })).toEqual([{ id: '1', label: 'Chair' }, { id: '2', label: '2' }])
    expect(apiRequestMock.mock.calls[0][1]).toBe('/product?page_size=20&search%5Bname%5D=ch')
    apiRequestMock.mockResolvedValueOnce({})
    expect(await listEditorRecords('product', '', { ids: ['a', 'b'], search: 'x' })).toEqual([])
    expect(apiRequestMock.mock.calls[1][1]).toBe('/product?page_size=20&in%5Bid%5D=a%2Cb')
    apiRequestMock.mockRejectedValueOnce(new Error('x'))
    expect(await listEditorRecords('product', 'name', {})).toEqual([])
  })
})
