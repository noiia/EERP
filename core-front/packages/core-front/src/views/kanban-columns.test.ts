import { describe, expect, it } from 'vitest'
import {
  kanbanColumnsGuard,
  mergeColumnsByLabel,
  registerKanbanColumnsGuard,
  resolveDropTarget,
  splitColumns,
} from './kanban-columns'

const config = { orderField: 'sequence', labelField: 'name', foldField: 'closed', scopeField: 'project_id' }

const stages = [
  { id: 'a-done', name: 'Done', sequence: 30, closed: true, project_id: 'A' },
  { id: 'a-new', name: 'New', sequence: 10, project_id: 'A' },
  { id: 'b-new', name: 'New', sequence: 5, project_id: 'B' },
  { id: 'b-review', name: 'Review', sequence: 20, project_id: 'B' },
  { id: 'b-done', name: 'Done', sequence: 40, closed: false, project_id: 'B' },
]

describe('mergeColumnsByLabel', () => {
  it('merges same-label records into one column ordered by their minimum orderField', () => {
    const columns = mergeColumnsByLabel(stages, config)
    expect(columns.map((c) => c.label)).toEqual(['New', 'Review', 'Done'])
    expect(columns[0]).toMatchObject({ key: 'b-new', order: 5, fold: false })
    expect(columns[0]!.stages.map((s) => s.id)).toEqual(['b-new', 'a-new'])
    expect(columns[2]!.stages.map((s) => s.id)).toEqual(['a-done', 'b-done'])
  })

  it('folds a merged column only when every one of its records folds', () => {
    const columns = mergeColumnsByLabel(stages, config)
    expect(columns[2]!.fold).toBe(false)
    expect(mergeColumnsByLabel(stages.slice(0, 1), config)[0]!.fold).toBe(true)
  })

  it('breaks an orderField tie by label', () => {
    const tied = [
      { id: '2', name: 'Zed', sequence: 10 },
      { id: '1', name: 'Alpha', sequence: 10 },
    ]
    expect(mergeColumnsByLabel(tied, config).map((c) => c.label)).toEqual(['Alpha', 'Zed'])
  })
})

describe('splitColumns', () => {
  it('keeps one column per record, keyed by its id, in orderField order', () => {
    const columns = splitColumns(stages.filter((s) => s.project_id === 'A'), config)
    expect(columns.map((c) => [c.key, c.label, c.fold])).toEqual([
      ['a-new', 'New', false],
      ['a-done', 'Done', true],
    ])
  })
})

describe('resolveDropTarget', () => {
  const done = mergeColumnsByLabel(stages, config)[2]!
  const review = mergeColumnsByLabel(stages, config)[1]!

  it("picks the merged column's record in the card's own scope", () => {
    expect(resolveDropTarget(done, 'A', config)).toBe('a-done')
    expect(resolveDropTarget(done, 'B', config)).toBe('b-done')
  })

  it('returns null when the card\'s scope has no record with that label', () => {
    expect(resolveDropTarget(review, 'A', config)).toBeNull()
  })

  it('without a scopeField, takes the column\'s first record', () => {
    expect(resolveDropTarget(done, undefined, { orderField: 'sequence', labelField: 'name' })).toBe('a-done')
  })
})

describe('kanban columns guard registry', () => {
  it('returns the registered guard by name, undefined otherwise', async () => {
    registerKanbanColumnsGuard('test.guard', async (scope) => scope === 'A')
    await expect(kanbanColumnsGuard('test.guard')?.('A', null)).resolves.toBe(true)
    expect(kanbanColumnsGuard('missing')).toBeUndefined()
  })
})
