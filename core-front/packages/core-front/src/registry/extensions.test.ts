import { describe, expect, it } from 'vitest'
import { normalizeLayout, type FieldDescriptor, type ViewDescriptor } from '../views/descriptor'
import { applyExtension, type Operation } from './extensions'

function field(name: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return { name, label: name.toUpperCase(), type: 'text', ...extra }
}

// viewType 'tree' (not 'form') on purpose: these tests exercise the extension
// MECHANISM itself, agnostic to view type — 'form' would trigger the
// header/two-column default synthesis (docs/roadmaps/responsive-displays.md,
// Phase 3), which has its own dedicated describe block below.
const base: ViewDescriptor = {
  entity: 'crm',
  viewType: 'tree',
  fields: [field('name'), field('email'), field('status')],
}

function apply(operations: Operation[], descriptor: ViewDescriptor = base) {
  return applyExtension(descriptor, operations)
}

describe('applyExtension — addField', () => {
  it('with no target/position: appended at the end', () => {
    const result = apply([{ op: 'addField', field: field('comment') }])
    expect(result.fields.map((f) => f.name)).toEqual(['name', 'email', 'status', 'comment'])
    expect(normalizeLayout(result)[0]).toMatchObject({
      children: [
        { kind: 'field', name: 'name' },
        { kind: 'field', name: 'email' },
        { kind: 'field', name: 'status' },
        { kind: 'field', name: 'comment' },
      ],
    })
  })

  it('with target + position "after": inserted right after the anchor, in both fields and layout', () => {
    const result = apply([
      { op: 'addField', field: field('date', { type: 'date' }), target: 'status', position: 'after' },
    ])
    expect(result.fields.map((f) => f.name)).toEqual(['name', 'email', 'status', 'date'])
    const leaves = normalizeLayout(result)[0]
    expect(leaves.kind).toBe('group')
    if (leaves.kind !== 'field') {
      expect(leaves.children.map((c) => (c.kind === 'field' ? c.name : c.id))).toEqual([
        'name',
        'email',
        'status',
        'date',
      ])
    }
  })

  it('with target + no position: defaults to "after"', () => {
    const result = apply([{ op: 'addField', field: field('date', { type: 'date' }), target: 'name' }])
    const leaves = normalizeLayout(result)[0]
    if (leaves.kind !== 'field') {
      expect(leaves.children.map((c) => (c.kind === 'field' ? c.name : c.id))).toEqual([
        'name',
        'date',
        'email',
        'status',
      ])
    }
  })

  it('rejects a name that already exists', () => {
    expect(() => apply([{ op: 'addField', field: field('name') }])).toThrowError(
      /addField: field "name" already exists/,
    )
  })

  it('rejects an unknown target', () => {
    expect(() =>
      apply([{ op: 'addField', field: field('date'), target: 'ghost', position: 'after' }]),
    ).toThrowError(/addField "date": target "ghost" not found/)
  })
})

describe('applyExtension — removeField', () => {
  it('removes from both fields and the layout tree', () => {
    const result = apply([{ op: 'removeField', name: 'email' }])
    expect(result.fields.map((f) => f.name)).toEqual(['name', 'status'])
    expect(() => normalizeLayout(result)).not.toThrow()
    const layout = normalizeLayout(result)[0]
    if (layout.kind !== 'field') {
      expect(layout.children.some((c) => c.kind === 'field' && c.name === 'email')).toBe(false)
    }
  })

  it('rejects an unknown field name', () => {
    expect(() => apply([{ op: 'removeField', name: 'ghost' }])).toThrowError(
      /removeField: field "ghost" not found/,
    )
  })
})

describe('applyExtension — setField', () => {
  it('shallow-merges the patch onto the existing field', () => {
    const result = apply([
      { op: 'setField', name: 'status', patch: { required: true, widget: undefined } },
    ])
    const status = result.fields.find((f) => f.name === 'status')
    expect(status?.required).toBe(true)
    expect(status?.label).toBe('STATUS') // untouched
  })

  it('attaches a states condition via patch', () => {
    const result = apply([
      {
        op: 'setField',
        name: 'status',
        patch: { states: { visible: { field: 'name', op: 'set' } } },
      },
    ])
    expect(result.fields.find((f) => f.name === 'status')?.states).toEqual({
      visible: { field: 'name', op: 'set' },
    })
  })

  it('rejects an unknown field name', () => {
    expect(() =>
      apply([{ op: 'setField', name: 'ghost', patch: { required: true } }]),
    ).toThrowError(/setField: field "ghost" not found/)
  })

  it('rejects renaming via patch.name', () => {
    expect(() =>
      apply([{ op: 'setField', name: 'status', patch: { name: 'renamed' } }]),
    ).toThrowError(/setField "status": renaming via patch.name is not allowed/)
  })
})

describe('applyExtension — move', () => {
  it('moves a field before another, field order in the tree changes, fields[] registry is untouched', () => {
    const result = apply([{ op: 'move', name: 'email', target: 'name', position: 'before' }])
    expect(result.fields.map((f) => f.name).sort()).toEqual(['email', 'name', 'status'])
    const layout = normalizeLayout(result)[0]
    if (layout.kind !== 'field') {
      expect(layout.children.map((c) => (c.kind === 'field' ? c.name : c.id))).toEqual([
        'email',
        'name',
        'status',
      ])
    }
  })

  it('moves a container by id', () => {
    const withSection: ViewDescriptor = {
      ...base,
      layout: [
        { kind: 'field', name: 'name' },
        { kind: 'section', id: 'extra', title: 'Extra', children: [{ kind: 'field', name: 'status' }] },
        { kind: 'field', name: 'email' },
      ],
    }
    const result = apply(
      [{ op: 'move', id: 'extra', target: 'name', position: 'before' }],
      withSection,
    )
    const top = normalizeLayout(result)
    expect(top.map((n) => (n.kind === 'field' ? n.name : n.id))).toEqual(['extra', 'name', 'email'])
  })

  it('rejects both name and id given', () => {
    expect(() =>
      apply([{ op: 'move', name: 'email', id: 'x', target: 'name', position: 'before' }]),
    ).toThrowError(/move: exactly one of name or id must be given/)
  })

  it('rejects neither name nor id given', () => {
    expect(() =>
      apply([{ op: 'move', target: 'name', position: 'before' } as Operation]),
    ).toThrowError(/move: exactly one of name or id must be given/)
  })

  it('rejects an unknown moved field', () => {
    expect(() =>
      apply([{ op: 'move', name: 'ghost', target: 'name', position: 'before' }]),
    ).toThrowError(/move: field "ghost" not found/)
  })

  it('rejects an unknown target', () => {
    expect(() =>
      apply([{ op: 'move', name: 'email', target: 'ghost', position: 'before' }]),
    ).toThrowError(/move field "email": target "ghost" not found/)
  })
})

describe('applyExtension — addNode', () => {
  it('wraps already-placed fields into a new container — extracted from their old spot, not duplicated', () => {
    const result = apply([
      {
        op: 'addNode',
        node: {
          kind: 'row',
          id: 'r1',
          children: [{ kind: 'field', name: 'name' }, { kind: 'field', name: 'email' }],
        },
        target: 'status',
        position: 'before',
      },
    ])
    // Structurally valid — no duplicate-field error.
    expect(() => normalizeLayout(result)).not.toThrow()
    const top = normalizeLayout(result)[0]
    expect(top.kind).toBe('group')
    if (top.kind !== 'field') {
      // 'name'/'email' are GONE from the top level — they now live only
      // inside the new row, which sits where 'status' used to have them as
      // flat siblings.
      expect(top.children.map((c) => (c.kind === 'field' ? c.name : c.id))).toEqual(['r1', 'status'])
      const row = top.children[0]
      if (row.kind !== 'field') {
        expect(row.children.map((c) => (c.kind === 'field' ? c.name : c.id))).toEqual(['name', 'email'])
      }
    }
  })

  it('rejects a field-leaf that is not declared in fields', () => {
    expect(() =>
      apply([
        {
          op: 'addNode',
          node: { kind: 'row', children: [{ kind: 'field', name: 'ghost' }] },
          target: 'status',
          position: 'after',
        },
      ]),
    ).toThrowError(/addNode: field "ghost" is not declared in fields/)
  })

  it('rejects an unknown target', () => {
    expect(() =>
      apply([
        {
          op: 'addNode',
          node: { kind: 'group', children: [] },
          target: 'ghost',
          position: 'after',
        },
      ]),
    ).toThrowError(/addNode: target "ghost" not found/)
  })
})

describe('applyExtension — setDescriptor', () => {
  it('patches view-level properties', () => {
    const result = apply([
      { op: 'setDescriptor', patch: { formPath: '/crm/:id', createPermission: 'crm:contacts:write' } },
    ])
    expect(result.formPath).toBe('/crm/:id')
    expect(result.createPermission).toBe('crm:contacts:write')
    expect(result.entity).toBe('crm') // untouched
  })
})

describe('applyExtension — form views materialize the synthesized default anatomy first', () => {
  // docs/roadmaps/responsive-displays.md, Phase 3: applyExtension always
  // normalizes the layout before applying ops, so a form-view extension sees
  // (and can target) the header/two-column default, not a flat group.
  const formBase: ViewDescriptor = {
    entity: 'crm',
    viewType: 'form',
    fields: [field('name'), field('email'), field('status')],
  }

  it('a no-target addField lands inside __form_columns, not top-level', () => {
    const result = apply([{ op: 'addField', field: field('comment') }], formBase)
    const top = normalizeLayout(result)
    const columns = top.find((n) => n.kind !== 'field' && n.id === '__form_columns')
    expect(columns).toBeDefined()
    if (columns && columns.kind !== 'field') {
      expect(columns.children.some((c) => c.kind === 'field' && c.name === 'comment')).toBe(true)
    }
    // Never at the top level alongside the header/columns nodes.
    expect(top.some((n) => n.kind === 'field' && n.name === 'comment')).toBe(false)
  })

  it('an addField anchored on a field living in __form_columns still resolves (recursive target search)', () => {
    // 'status' is neither the picture nor the title (title = first text
    // field = 'name'), so it lives inside __form_columns, one level deep —
    // insertAt's target search must still find it there.
    const result = apply(
      [{ op: 'addField', field: field('date', { type: 'date' }), target: 'status', position: 'after' }],
      formBase,
    )
    const top = normalizeLayout(result)
    const columns = top.find((n) => n.kind !== 'field' && n.id === '__form_columns')
    if (columns && columns.kind !== 'field') {
      const names = columns.children.map((c) => (c.kind === 'field' ? c.name : c.id))
      expect(names.indexOf('date')).toBe(names.indexOf('status') + 1)
    }
  })
})

// docs/roadmaps/responsive-displays.md, Phase 4: the notebook + Settings
// page a form-view extension can already reach with the EXISTING ops — no
// new extension API needed, because pages are ordinary addressable nodes.
describe('applyExtension — the notebook (Phase 4)', () => {
  const formBase: ViewDescriptor = {
    entity: 'crm',
    viewType: 'form',
    fields: [field('name'), field('email'), field('status')],
  }

  it('a target-less widget:"long" addField lands on the Settings page, not __form_columns', () => {
    const result = apply(
      [{ op: 'addField', field: field('bio', { widget: 'long' }) }],
      formBase,
    )
    const top = normalizeLayout(result)
    const notebook = top.find((n) => n.kind !== 'field' && n.id === '__form_notebook')
    const columns = top.find((n) => n.kind !== 'field' && n.id === '__form_columns')
    expect(notebook).toBeDefined()
    if (notebook && notebook.kind !== 'field') {
      const settings = notebook.children.find((p) => p.kind !== 'field' && p.id === '__page_settings')
      expect(settings).toMatchObject({ children: [{ kind: 'field', name: 'bio' }] })
    }
    if (columns && columns.kind !== 'field') {
      expect(columns.children.some((c) => c.kind === 'field' && c.name === 'bio')).toBe(false)
    }
  })

  it('a module can addNode a new page onto __form_notebook and addField into it — the entire "pages are as easy to create as views" story, no new extension op', () => {
    const result = apply(
      [
        {
          op: 'addNode',
          node: { kind: 'page', id: 'quality', title: 'Quality', children: [] },
          target: '__form_notebook',
          position: 'last',
        },
        { op: 'addField', field: field('audit_notes'), target: 'quality', position: 'last' },
      ],
      formBase,
    )
    const top = normalizeLayout(result)
    const notebook = top.find((n) => n.kind !== 'field' && n.id === '__form_notebook')
    expect(notebook).toBeDefined()
    if (notebook && notebook.kind !== 'field') {
      expect(notebook.children).toHaveLength(2) // Settings (built-in) + Quality (added)
      const quality = notebook.children.find((p) => p.kind !== 'field' && p.id === 'quality')
      expect(quality).toMatchObject({
        kind: 'page',
        title: 'Quality',
        children: [{ kind: 'field', name: 'audit_notes' }],
      })
    }
  })

  it('a page with no title is rejected even when added via addNode — the same validation any hand-authored layout gets', () => {
    // applyExtension's OWN throws are addField/removeField/etc.'s specific
    // checks (name collisions, missing targets); the notebook/page
    // STRUCTURAL rules are `normalizeLayout`'s, applied uniformly whether a
    // layout was hand-authored or assembled by an extension — so `apply`
    // itself succeeds here, and the next `normalizeLayout` call is what throws.
    const result = apply(
      [
        {
          op: 'addNode',
          node: { kind: 'page', id: 'blank', children: [] },
          target: '__form_notebook',
          position: 'last',
        },
      ],
      formBase,
    )
    expect(() => normalizeLayout(result)).toThrowError(/requires a title/)
  })
})

describe('applyExtension — operation order and chaining', () => {
  it('operations apply IN ORDER — later ops see earlier ops\' results', () => {
    const result = apply([
      { op: 'addField', field: field('comment') },
      { op: 'move', name: 'comment', target: 'name', position: 'after' },
      { op: 'setField', name: 'comment', patch: { required: true } },
    ])
    const layout = normalizeLayout(result)[0]
    if (layout.kind !== 'field') {
      expect(layout.children.map((c) => (c.kind === 'field' ? c.name : c.id))).toEqual([
        'name',
        'comment',
        'email',
        'status',
      ])
    }
    expect(result.fields.find((f) => f.name === 'comment')?.required).toBe(true)
  })

  it('reordering the SAME operations changes the outcome', () => {
    const moveFirst = apply([
      { op: 'move', name: 'email', target: 'status', position: 'after' },
      { op: 'setField', name: 'email', patch: { required: true } },
    ])
    expect(moveFirst.fields.find((f) => f.name === 'email')?.required).toBe(true)
    const layout = normalizeLayout(moveFirst)[0]
    if (layout.kind !== 'field') {
      expect(layout.children.map((c) => (c.kind === 'field' ? c.name : c.id))).toEqual([
        'name',
        'status',
        'email',
      ])
    }
  })

  it('an extension over an already-extended descriptor composes (A extends B extends base)', () => {
    const afterFirst = apply([{ op: 'addField', field: field('date', { type: 'date' }) }])
    const afterSecond = applyExtension(afterFirst, [
      { op: 'addField', field: field('comment'), target: 'date', position: 'after' },
      { op: 'setField', name: 'date', patch: { required: true } },
    ])
    expect(afterSecond.fields.map((f) => f.name)).toEqual([
      'name',
      'email',
      'status',
      'date',
      'comment',
    ])
    expect(afterSecond.fields.find((f) => f.name === 'date')?.required).toBe(true)
  })

  it('never mutates the input descriptor', () => {
    const before = JSON.stringify(base)
    apply([{ op: 'addField', field: field('comment') }])
    expect(JSON.stringify(base)).toBe(before)
  })
})
