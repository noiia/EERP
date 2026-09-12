import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { ApiError } from '../api/errors'
import type { EntityActions } from './stores'
import { useOptimisticFieldMove } from './use-optimistic-field-move'

interface Item {
  id: string
  status: string | null
}

function actionsWith(
  update: EntityActions<Item>['update'],
): EntityActions<Item> {
  return { create: vi.fn(async (b) => b as Item), update }
}

describe('useOptimisticFieldMove', () => {
  it('seeds records from initialData', () => {
    const initial: Item[] = [{ id: '1', status: 'open' }]
    const { result } = renderHook(() => useOptimisticFieldMove(initial, actionsWith(vi.fn()), 'status'))
    expect(result.current.records).toEqual(initial)
    expect(result.current.error).toBeNull()
  })

  it('optimistically applies the move before the write resolves, then PATCHes', async () => {
    const initial: Item[] = [{ id: '1', status: 'open' }]
    const update = vi.fn(async (id: string, body: Partial<Item>) => ({ id, ...body }) as Item)
    const { result } = renderHook(() => useOptimisticFieldMove(initial, actionsWith(update), 'status'))

    await act(async () => {
      await result.current.moveField('1', 'won')
    })
    expect(result.current.records[0]?.status).toBe('won')
    expect(update).toHaveBeenCalledWith('1', { status: 'won' })
    expect(result.current.error).toBeNull()
  })

  it('is a no-op when the value is unchanged', async () => {
    const initial: Item[] = [{ id: '1', status: 'open' }]
    const update = vi.fn()
    const { result } = renderHook(() => useOptimisticFieldMove(initial, actionsWith(update), 'status'))

    await act(async () => {
      await result.current.moveField('1', 'open')
    })
    expect(update).not.toHaveBeenCalled()
  })

  it('treats a null current value and an explicit null target as unchanged', async () => {
    const initial: Item[] = [{ id: '1', status: null }]
    const update = vi.fn()
    const { result } = renderHook(() => useOptimisticFieldMove(initial, actionsWith(update), 'status'))

    await act(async () => {
      await result.current.moveField('1', null)
    })
    expect(update).not.toHaveBeenCalled()
  })

  it('reverts the optimistic change and surfaces the error on a rejected write', async () => {
    const initial: Item[] = [{ id: '1', status: 'open' }]
    const update = vi.fn(async () => {
      throw new ApiError({ code: 'FORBIDDEN', message: 'no', status: 403 })
    })
    const { result } = renderHook(() => useOptimisticFieldMove(initial, actionsWith(update), 'status'))

    await act(async () => {
      await result.current.moveField('1', 'won')
    })
    expect(result.current.records[0]?.status).toBe('open')
    expect(result.current.error).toEqual({ code: 'FORBIDDEN', message: 'no', requestId: undefined })
  })

  it('reconciles with a fresh initialData prop (e.g. after a revalidation elsewhere)', async () => {
    const update = vi.fn(async (id: string, body: Partial<Item>) => ({ id, ...body }) as Item)
    const { result, rerender } = renderHook(
      ({ initial }: { initial: Item[] }) => useOptimisticFieldMove(initial, actionsWith(update), 'status'),
      { initialProps: { initial: [{ id: '1', status: 'open' }] } },
    )
    rerender({ initial: [{ id: '1', status: 'won' }] })
    await waitFor(() => expect(result.current.records[0]?.status).toBe('won'))
  })
})
