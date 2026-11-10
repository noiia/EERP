import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { EntityListOptions } from '../api/list-options'
import type { FieldDescriptor } from './descriptor'
import { RelationOpsProvider, type RelationOps, type RelationRecord } from './relation-ops'
import { cachedColors, RECORD_COLORS_CAP, useRecordColorsStore } from './record-colors-store'
import { useSessionStore } from './session-store'
import { colorTagsFieldOf, useRecordColors } from './use-record-colors'

const signIn = (userId: string) =>
  useSessionStore.setState({ identity: { userId, tenantId: 't1', roles: [], permissions: [] } })

beforeEach(() => {
  signIn('u1')
  useRecordColorsStore.getState().clear()
})

const field: FieldDescriptor = {
  name: 'color_groups',
  label: 'Color groups',
  type: 'relation',
  widget: 'colortags',
  relation: {
    entity: 'color',
    kind: 'many2many',
    via: 'task_color',
    viaFields: { own: 'task_id', related: 'color_id' },
  },
}

const palette: Record<string, string> = { c1: '#ff0000', c2: '#00ff00', c3: '#0000ff' }

/** Junction rows: task-0 → c2 then c1, every other task → c3. */
function junctionsFor(ids: string[]): RelationRecord[] {
  return ids.flatMap((id) =>
    id === 'task-0'
      ? [
          { id: 'j-a', task_id: id, color_id: 'c2' },
          { id: 'j-b', task_id: id, color_id: 'c1' },
        ]
      : [{ id: `j-${id}`, task_id: id, color_id: 'c3' }],
  )
}

function stubOps() {
  // Every junction query answers its rows page by page (pageSize honored), so paging is real.
  const list = vi.fn(async (entity: string, o: EntityListOptions = {}) => {
    if (entity === 'task_color') {
      const rows = junctionsFor(o.in?.task_id ?? [])
      const size = o.pageSize ?? 100
      const page = o.page ?? 1
      return rows.slice((page - 1) * size, page * size)
    }
    return (o.in?.id ?? []).map((id) => ({ id, name: id, color: palette[id] }))
  })
  const ops: RelationOps = { list, get: vi.fn(), create: vi.fn(), remove: vi.fn() }
  return { ops, list }
}

const wrapperFor =
  (ops: RelationOps) =>
  ({ children }: { children: ReactNode }) => (
    <RelationOpsProvider ops={ops}>{children}</RelationOpsProvider>
  )

const ids = (n: number) => Array.from({ length: n }, (_, i) => `task-${i}`)

describe('useRecordColors', () => {
  it('reads junction rows by chunks of 100 ids, paged in creation order, then their colors', async () => {
    const { ops, list } = stubOps()
    const { result } = renderHook(() => useRecordColors('task', field, ids(250)), {
      wrapper: wrapperFor(ops),
    })
    await waitFor(() => expect(result.current.colors.size).toBe(250))

    const junctionCalls = list.mock.calls.filter(([e]) => e === 'task_color').map(([, o]) => o!)
    expect(junctionCalls.every((o) => o.order === 'created_at')).toBe(true)
    expect(junctionCalls.every((o) => (o.in?.task_id ?? []).length <= 100)).toBe(true)
    // 250 ids → 3 chunks; a full page (100 rows) asks for the next one, a short page ends the chunk.
    expect(junctionCalls.map((o) => [o.in!.task_id!.length, o.page])).toEqual([
      [100, 1],
      [100, 2],
      [100, 1],
      [100, 2],
      [50, 1],
    ])
    expect(result.current.colors.get('task-0')).toEqual(['#00ff00', '#ff0000'])
    expect(result.current.colors.get('task-249')).toEqual(['#0000ff'])
    const relatedCalls = list.mock.calls.filter(([e]) => e === 'color')
    expect(relatedCalls).toHaveLength(1)
    expect(relatedCalls[0][1]!.in!.id!.sort()).toEqual(['c1', 'c2', 'c3'])
  })

  it('does not refetch when the same records are only reordered, does when the set changes or on reload', async () => {
    const { ops, list } = stubOps()
    const { result, rerender } = renderHook(({ shown }) => useRecordColors('task', field, shown), {
      wrapper: wrapperFor(ops),
      initialProps: { shown: ['task-1', 'task-2'] },
    })
    await waitFor(() => expect(result.current.colors.size).toBe(2))
    const calls = list.mock.calls.length

    rerender({ shown: ['task-2', 'task-1'] })
    expect(list.mock.calls.length).toBe(calls)

    rerender({ shown: ['task-2', 'task-3'] })
    await waitFor(() => expect(result.current.colors.has('task-3')).toBe(true))
    const after = list.mock.calls.length
    expect(after).toBeGreaterThan(calls)

    act(() => result.current.reload())
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(after))
  })

  it('is inert without a field, without ops, or with no record, and skips a refused read', async () => {
    const { ops, list } = stubOps()
    const { result } = renderHook(() => useRecordColors('task', null, ['task-1']), {
      wrapper: wrapperFor(ops),
    })
    expect(result.current.colors.size).toBe(0)
    renderHook(() => useRecordColors('task', field, []), { wrapper: wrapperFor(ops) })
    expect(list).not.toHaveBeenCalled()
    const bare = renderHook(() => useRecordColors('task', field, ['task-1']))
    expect(bare.result.current.colors.size).toBe(0)

    const refused: RelationOps = {
      ...ops,
      list: vi.fn(async () => Promise.reject(new Error('403'))),
    }
    const r = renderHook(() => useRecordColors('task', field, ['task-1']), {
      wrapper: wrapperFor(refused),
    })
    await waitFor(() => expect(refused.list).toHaveBeenCalled())
    expect(r.result.current.colors.size).toBe(0)
  })

  it('ignores invalid colors and dangling junction rows', async () => {
    const ops: RelationOps = {
      list: vi.fn(async (entity: string) =>
        entity === 'task_color'
          ? [
              { id: 'j1', task_id: 'task-1', color_id: 'bad' },
              { id: 'j2', task_id: 'task-1', color_id: 'gone' },
              { id: 'j3', task_id: 'task-1', color_id: 'c1' },
            ]
          : [
              { id: 'bad', color: 'url(javascript:alert(1))' },
              { id: 'c1', color: '#ff0000' },
            ],
      ),
      get: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
    }
    const { result } = renderHook(() => useRecordColors('task', field, ['task-1']), {
      wrapper: wrapperFor(ops),
    })
    await waitFor(() => expect(result.current.colors.get('task-1')).toEqual(['#ff0000']))
  })
})

describe('colorTagsFieldOf', () => {
  it('resolves a many2many field of the descriptor, nothing else', () => {
    const d = {
      entity: 'task',
      viewType: 'tree' as const,
      fields: [field, { name: 'name', label: 'Name', type: 'text' as const }],
    }
    expect(colorTagsFieldOf(d, 'color_groups')).toBe(field)
    expect(colorTagsFieldOf(d, 'name')).toBeNull()
    expect(colorTagsFieldOf(d, undefined)).toBeNull()
    expect(colorTagsFieldOf(d, 'missing')).toBeNull()
  })
})

describe('record colors cache', () => {
  const config = 'color\u0000task_color\u0000task_id\u0000color_id\u0000color'

  it('draws the cached colors at once, then the fresh read replaces them', async () => {
    const { ops } = stubOps()
    const first = renderHook(() => useRecordColors('task', field, ['task-0']), { wrapper: wrapperFor(ops) })
    await waitFor(() => expect(first.result.current.colors.get('task-0')).toEqual(['#00ff00', '#ff0000']))
    first.unmount()

    // The next display: the read never answers, the cached colors still show.
    const pending: RelationOps = { ...ops, list: vi.fn(() => new Promise<RelationRecord[]>(() => {})) }
    const second = renderHook(() => useRecordColors('task', field, ['task-0', 'task-9']), { wrapper: wrapperFor(pending) })
    expect(second.result.current.colors.get('task-0')).toEqual(['#00ff00', '#ff0000'])
    expect(second.result.current.colors.has('task-9')).toBe(false)
    expect(pending.list).toHaveBeenCalled()
  })

  it('is per user and wiped on logout', () => {
    useRecordColorsStore.getState().put(config, ['a'], new Map([['a', ['#123456']]]))
    expect(cachedColors(config, ['a']).get('a')).toEqual(['#123456'])
    signIn('u2')
    expect(cachedColors(config, ['a']).size).toBe(0)
    signIn('u1')
    useRecordColorsStore.getState().put(config, ['a'], new Map([['a', ['#123456']]]))
    act(() => useSessionStore.getState().clear())
    expect(useRecordColorsStore.getState().entries).toEqual({})
  })

  it('records a record without colors as such and keeps at most the cap', () => {
    const put = useRecordColorsStore.getState().put
    put(config, ['none'], new Map())
    expect(useRecordColorsStore.getState().entries[config]).toEqual({ none: [] })
    const many = Array.from({ length: RECORD_COLORS_CAP + 1 }, (_, i) => `r${i}`)
    put(config, many, new Map())
    const kept = Object.keys(useRecordColorsStore.getState().entries[config]!)
    expect(kept).toHaveLength(RECORD_COLORS_CAP)
    expect(kept).not.toContain('none') // the oldest went first
  })
})
