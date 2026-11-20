import { describe, expect, it } from 'vitest'
import { initialSelection, isRemoval, selectAll, selectAllRemovals, toggle, type ExchangeChange } from './selection'

/** One review row, with only what a given test cares about filled in. */
function change(over: Partial<ExchangeChange> & { key: string; kind: string; task?: string }): ExchangeChange {
  return {
    key: over.key,
    kind: over.kind,
    task: over.task ?? 'Design review',
    wbs: over.wbs,
    field: over.field,
    before: over.before ?? null,
    after: over.after ?? null,
    default_selected: over.default_selected ?? true,
    requires: over.requires,
    was_unscheduled: over.was_unscheduled,
    dependents: over.dependents,
  }
}

const keys = (sel: Set<string>) => [...sel].sort()
/** The same order `keys` compares against, so a test can name its rows in any order. */
const sorted = (...names: string[]) => [...names].sort()

const create = change({ key: 'new:11', kind: 'create', task: 'Supplier audit' })
const depOnCreate = change({ key: 'dep:t1:new:11', kind: 'dependency', requires: ['new:11'] })
const update = change({ key: 'task:u1:dates', kind: 'update', field: 'dates' })
// The backend's direction (exchange_diff.go): a parent's delete row is the anchor,
// and it is the one that names the subtask deletes it cannot go without.
const parentDelete = change({
  key: 'task:u1:delete',
  kind: 'delete',
  default_selected: false,
  requires: ['task:u2:delete'],
  dependents: { subtasks: 3, timesheets: 2, risk_links: 1 },
})
const childDelete = change({ key: 'task:u2:delete', kind: 'delete', default_selected: false })
const milestoneUnlink = change({ key: 'task:u3:milestone_id', kind: 'update', field: 'milestone_id', after: null })
const depDelete = change({ key: 'dep:t1:t2:delete', kind: 'dependency_delete', default_selected: false })
const assignDelete = change({ key: 'assign:u4:dev@x.io:delete', kind: 'assign_delete', default_selected: false })
const milestoneDelete = change({ key: 'milestone:m1:delete', kind: 'milestone_delete', default_selected: false })

const ALL = [create, depOnCreate, update, parentDelete, childDelete, milestoneUnlink, depDelete, assignDelete, milestoneDelete]
const REMOVALS = [parentDelete, childDelete, milestoneUnlink, depDelete, assignDelete, milestoneDelete].map((c) => c.key)

describe('isRemoval', () => {
  it('reads every destroying kind as a removal', () => {
    for (const c of [parentDelete, childDelete, depDelete, assignDelete, milestoneDelete, milestoneUnlink]) {
      expect(isRemoval(c)).toBe(true)
    }
  })

  it('leaves the additive and editing kinds alone', () => {
    for (const c of [create, depOnCreate, update]) {
      expect(isRemoval(c)).toBe(false)
    }
  })

  it('reads a milestone link set to null as a removal, but a link being moved as an edit', () => {
    expect(isRemoval(change({ key: 'task:u9:milestone_id', kind: 'update', field: 'milestone_id', after: null }))).toBe(true)
    expect(
      isRemoval(change({ key: 'task:u9:milestone_id', kind: 'update', field: 'milestone_id', after: { id: 'm2' } })),
    ).toBe(false)
  })
})

describe('initialSelection', () => {
  it('takes the default-selected rows and no removal', () => {
    const sel = initialSelection(ALL)
    expect(keys(sel)).toEqual(sorted(create.key, depOnCreate.key, update.key))
    for (const key of REMOVALS) expect(sel.has(key)).toBe(false)
  })

  it('never pre-selects a removal, even one the backend flagged default_selected', () => {
    const sneaky = change({ key: 'task:u7:delete', kind: 'delete', default_selected: true })
    const sel = initialSelection([sneaky, update])
    expect(sel.has(sneaky.key)).toBe(false)
    expect(keys(sel)).toEqual(sorted(update.key))
  })

  it('pulls in what a default-selected row requires, transitively', () => {
    // A move under a task the file adds: the create row itself isn't default-selected,
    // but the row needing it cannot apply without it.
    const createRow = change({ key: 'new:12', kind: 'create', task: 'New phase', default_selected: false })
    const move = change({ key: 'task:u5:move', kind: 'move', requires: ['new:12'] })
    const parentCreate = change({ key: 'new:13', kind: 'create', default_selected: false })
    const childCreate = change({ key: 'new:14', kind: 'create', requires: ['new:12'] })
    const link = change({ key: 'dep:new:13:new:14', kind: 'dependency', requires: ['new:13', 'new:14'] })
    const sel = initialSelection([move, link, parentCreate, childCreate, createRow])
    expect(keys(sel)).toEqual(sorted(move.key, link.key, childCreate.key, createRow.key, parentCreate.key))
  })
})

describe('toggle', () => {
  it('ticking a dependency on a new task ticks the create it needs', () => {
    expect(keys(toggle(ALL, new Set(), depOnCreate.key, true))).toEqual(sorted(create.key, depOnCreate.key))
  })

  it('unticking the create unticks the dependency that needed it', () => {
    const sel = toggle(ALL, new Set([create.key, depOnCreate.key, update.key]), create.key, false)
    expect(keys(sel)).toEqual(sorted(update.key))
  })

  it('unticking a row leaves the rows that do not need it alone', () => {
    const sel = toggle(ALL, new Set([depOnCreate.key, update.key]), depOnCreate.key, false)
    expect(keys(sel)).toEqual(sorted(update.key))
  })

  it('ticking a parent delete ticks the child deletes it requires', () => {
    expect(keys(toggle(ALL, new Set(), parentDelete.key, true))).toEqual(sorted(parentDelete.key, childDelete.key))
  })

  it('unticking a child delete unticks the parent that could not go without it', () => {
    // The apply refuses a parent delete missing a child delete, so the cluster never
    // stays half-ticked.
    const sel = toggle(ALL, new Set([parentDelete.key, childDelete.key]), childDelete.key, false)
    expect(keys(sel)).toEqual([])
  })

  it('ticking one removal brings its whole cluster with it, and leaves the rest alone', () => {
    expect(keys(toggle(ALL, new Set([update.key]), parentDelete.key, true))).toEqual(
      sorted(parentDelete.key, childDelete.key, update.key),
    )
  })

  it('ignores a key the preview never sent', () => {
    expect(keys(toggle(ALL, new Set([update.key]), 'new:404', true))).toEqual(sorted(update.key))
  })
})

describe('selectAll', () => {
  it('never adds a removal', () => {
    const sel = selectAll(ALL, new Set(), true)
    expect(keys(sel)).toEqual(sorted(create.key, depOnCreate.key, update.key))
    for (const key of REMOVALS) expect(sel.has(key)).toBe(false)
  })

  it('leaves the removals a user already ticked in place', () => {
    const sel = selectAll(ALL, new Set([parentDelete.key, childDelete.key]), true)
    expect(sel.has(parentDelete.key)).toBe(true)
    expect(sel.has(childDelete.key)).toBe(true)
    expect(keys(sel)).toEqual(sorted(create.key, depOnCreate.key, update.key, parentDelete.key, childDelete.key))
  })

  it('off drops the non-removals and keeps the removals ticked', () => {
    const sel = selectAll(ALL, new Set([create.key, update.key, parentDelete.key, childDelete.key]), false)
    expect(keys(sel)).toEqual(sorted(parentDelete.key, childDelete.key))
  })
})

describe('selectAllRemovals', () => {
  it('ticks every removal, with what each one needs', () => {
    const sel = selectAllRemovals(ALL, new Set([update.key]), true)
    expect(keys(sel)).toEqual(
      sorted(
        update.key,
        parentDelete.key,
        childDelete.key,
        milestoneUnlink.key,
        depDelete.key,
        assignDelete.key,
        milestoneDelete.key,
      ),
    )
    // A removal needing a create (its new parent's row) carries that create too.
    const needing = change({ key: 'task:u8:delete', kind: 'delete', default_selected: false, requires: [create.key] })
    expect(keys(selectAllRemovals([needing, create], new Set(), true))).toEqual(sorted(needing.key, create.key))
    // A requires naming a row the preview never sent is dropped: apply must never
    // post a key Go has no row for.
    const dangling = change({ key: 'task:u9:delete', kind: 'delete', default_selected: false, requires: ['new:404'] })
    expect(keys(selectAllRemovals([dangling], new Set(), true))).toEqual(sorted(dangling.key))
  })

  it('off unticks every removal and nothing else', () => {
    const sel = selectAllRemovals(ALL, new Set([create.key, depOnCreate.key, parentDelete.key, childDelete.key]), false)
    expect(keys(sel)).toEqual(sorted(create.key, depOnCreate.key))
  })
})

describe('no mutation', () => {
  it('every function returns a new Set and leaves the one it was handed alone', () => {
    const base = new Set([create.key, update.key])
    const untouched = keys(base)

    const sels = [
      toggle(ALL, base, parentDelete.key, true),
      toggle(ALL, base, create.key, false),
      selectAll(ALL, base, true),
      selectAll(ALL, base, false),
      selectAllRemovals(ALL, base, true),
      selectAllRemovals(ALL, base, false),
      initialSelection(ALL),
    ]
    for (const sel of sels) {
      expect(sel).toBeInstanceOf(Set)
      expect(sel).not.toBe(base)
    }
    expect(keys(base)).toEqual(untouched)
    // And the rows themselves are never rewritten either.
    expect(ALL.map((r) => r.key)).toEqual([
      'new:11',
      'dep:t1:new:11',
      'task:u1:dates',
      'task:u1:delete',
      'task:u2:delete',
      'task:u3:milestone_id',
      'dep:t1:t2:delete',
      'assign:u4:dev@x.io:delete',
      'milestone:m1:delete',
    ])
  })
})
