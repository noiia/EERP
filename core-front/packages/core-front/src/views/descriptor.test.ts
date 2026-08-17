import { describe, expect, it } from 'vitest'
import {
  FIELD_WIDGETS,
  FORM_COLUMNS_ID,
  FORM_HEADER_ID,
  FORM_NOTEBOOK_ID,
  PAGE_SETTINGS_ID,
  evaluateCondition,
  fieldZeroDefault,
  isFieldVisible,
  isVirtualRelation,
  layoutFieldOrder,
  normalizeLayout,
  requiredMissing,
  resolveWidget,
  titleFieldName,
  validateCatalogDescriptor,
  validateDescriptorWidgets,
  validateSearchDescriptor,
  validateStatusBarDescriptor,
  type CatalogDescriptor,
  type Condition,
  type FieldDescriptor,
  type FieldType,
  type LayoutNode,
  type RelationDescriptor,
  type SearchDescriptor,
  type ViewDescriptor,
} from './descriptor'

const field = (type: FieldType, widget?: string): FieldDescriptor => ({
  name: 'f',
  label: 'F',
  type,
  ...(widget ? { widget } : {}),
})

const relationField = (
  relation: Partial<RelationDescriptor> & Pick<RelationDescriptor, 'kind'>,
  widget?: string,
): FieldDescriptor => ({
  name: 'f',
  label: 'F',
  type: 'relation',
  relation: { entity: 'contact', ...relation },
  ...(widget ? { widget } : {}),
})

const selectionField = (options: string[], widget?: string): FieldDescriptor => ({
  name: 'f',
  label: 'F',
  type: 'selection',
  selection: { options },
  ...(widget ? { widget } : {}),
})

describe('resolveWidget', () => {
  it('defaults to the first widget of each type', () => {
    expect(resolveWidget(field('text'))).toBe('simple')
    expect(resolveWidget(field('number'))).toBe('float')
    expect(resolveWidget(field('boolean'))).toBe('switch')
    expect(resolveWidget(field('date'))).toBe('simple')
  })

  it('accepts every widget the matrix allows', () => {
    for (const [type, widgets] of Object.entries(FIELD_WIDGETS)) {
      if (type === 'relation' || type === 'selection' || type === 'totals') continue // block-driven — covered below
      for (const widget of widgets) {
        expect(resolveWidget(field(type as FieldType, widget))).toBe(widget)
      }
    }
  })

  it('rejects widgets the matrix forbids, naming field, type, and widget', () => {
    const deny: Array<[FieldType, string]> = [
      ['text', 'stars'],
      ['number', 'long'],
      ['boolean', 'stars'],
      ['date', 'phone'],
    ]
    for (const [type, widget] of deny) {
      expect(() => resolveWidget(field(type, widget))).toThrowError(
        new RegExp(`"f".*"${widget}".*"${type}"`),
      )
    }
  })
})

describe('resolveWidget — selection', () => {
  it('defaults to select', () => {
    expect(resolveWidget(selectionField(['incoming', 'won']))).toBe('select')
  })

  it('requires a non-empty options list', () => {
    expect(() => resolveWidget(field('selection'))).toThrowError(
      /requires a non-empty selection\.options list/,
    )
    expect(() => resolveWidget(selectionField([]))).toThrowError(
      /requires a non-empty selection\.options list/,
    )
  })

  it('rejects a widget the matrix forbids, naming field, type, and widget', () => {
    expect(() => resolveWidget(selectionField(['incoming', 'won'], 'stars'))).toThrowError(
      /"f".*"stars".*"selection"/,
    )
  })
})

describe('resolveWidget — relations', () => {
  it('derives the widget from the relation kind', () => {
    expect(resolveWidget(relationField({ kind: 'many2one' }))).toBe('search')
    expect(resolveWidget(relationField({ kind: 'one2many', inverseField: 'crm_id' }))).toBe('list')
    expect(resolveWidget(relationField({ kind: 'many2many', via: 'crm_tag' }))).toBe('tags')
  })

  it('requires the relation block on relation fields', () => {
    expect(() => resolveWidget(field('relation'))).toThrowError(/requires a relation block/)
  })

  it('rejects a widget that contradicts the kind', () => {
    expect(() => resolveWidget(relationField({ kind: 'many2one' }, 'tags'))).toThrowError(
      /"tags" does not match relation kind "many2one"/,
    )
  })

  it('requires inverseField on one2many and via on many2many', () => {
    expect(() => resolveWidget(relationField({ kind: 'one2many' }))).toThrowError(
      /one2many relations require inverseField/,
    )
    expect(() => resolveWidget(relationField({ kind: 'many2many' }))).toThrowError(
      /many2many relations require via/,
    )
  })
})

describe('resolveWidget — totals', () => {
  it('defaults to recap', () => {
    expect(resolveWidget({ ...field('totals'), relation: { entity: 'sale_line', kind: 'one2many' } })).toBe(
      'recap',
    )
  })

  it('requires a relation block', () => {
    expect(() => resolveWidget(field('totals'))).toThrowError(/requires a relation block/)
  })
})

describe('resolveWidget — address', () => {
  it('defaults to form — no relation block required, unlike totals', () => {
    expect(resolveWidget(field('address'))).toBe('form')
  })
})

describe('fieldZeroDefault', () => {
  it('returns the natural empty value per type', () => {
    expect(fieldZeroDefault(field('text'))).toBe('')
    expect(fieldZeroDefault(field('number'))).toBe(0)
    expect(fieldZeroDefault(field('boolean'))).toBe(false)
    expect(fieldZeroDefault(field('date'))).toBeNull()
    expect(fieldZeroDefault(relationField({ kind: 'many2one' }))).toBeNull()
    expect(fieldZeroDefault(field('totals'))).toBeNull()
    expect(fieldZeroDefault(field('address'))).toBeNull()
  })

  it('a selection field has no "empty" — its zero default is the FIRST option', () => {
    expect(fieldZeroDefault(selectionField(['incoming', 'running', 'won']))).toBe('incoming')
    // Order is what governs it, not alphabetical or anything else.
    expect(fieldZeroDefault(selectionField(['won', 'incoming']))).toBe('won')
  })
})

describe('isVirtualRelation', () => {
  it('marks o2m/m2m virtual, m2o and scalars not', () => {
    expect(isVirtualRelation(relationField({ kind: 'one2many', inverseField: 'x' }))).toBe(true)
    expect(isVirtualRelation(relationField({ kind: 'many2many', via: 'j' }))).toBe(true)
    expect(isVirtualRelation(relationField({ kind: 'many2one' }))).toBe(false)
    expect(isVirtualRelation(field('text'))).toBe(false)
  })
})

describe('validateDescriptorWidgets', () => {
  const descriptor = (fields: FieldDescriptor[]): ViewDescriptor => ({
    entity: 'crm',
    viewType: 'form',
    fields,
  })

  it('passes a descriptor with valid and defaulted widgets', () => {
    expect(() =>
      validateDescriptorWidgets(
        descriptor([
          field('text'),
          field('number', 'stars'),
          field('boolean', 'switch'),
          selectionField(['incoming', 'won']),
        ]),
      ),
    ).not.toThrow()
  })

  it('throws on the first invalid field', () => {
    expect(() =>
      validateDescriptorWidgets(descriptor([field('text'), field('number', 'long')])),
    ).toThrowError(/widget "long" is not allowed for type "number"/)
  })
})

// docs/roadmaps/app-store.md, Phase 2: viewType 'catalog''s own registration
// check — every OTHER viewType is a no-op (nothing here should ever affect a
// form/tree/dashboard descriptor).
describe('validateCatalogDescriptor', () => {
  const catalogDescriptor = (
    fields: FieldDescriptor[],
    catalog: CatalogDescriptor | undefined,
  ): ViewDescriptor => ({
    entity: 'modules',
    viewType: 'catalog',
    fields,
    catalog,
  })

  const fields: FieldDescriptor[] = [
    { name: 'icon', label: 'Icon', type: 'text' },
    { name: 'display_name', label: 'Display name', type: 'text' },
    { name: 'description', label: 'Description', type: 'text' },
  ]

  it('passes a valid catalog block naming declared fields', () => {
    expect(() =>
      validateCatalogDescriptor(
        catalogDescriptor(fields, { icon: 'icon', title: 'display_name', subtitle: 'description' }),
      ),
    ).not.toThrow()
  })

  it('title alone (icon/subtitle omitted) is valid', () => {
    expect(() =>
      validateCatalogDescriptor(catalogDescriptor(fields, { title: 'display_name' })),
    ).not.toThrow()
  })

  it('throws when the catalog block is missing entirely', () => {
    expect(() => validateCatalogDescriptor(catalogDescriptor(fields, undefined))).toThrowError(
      /requires a "catalog" descriptor block/,
    )
  })

  it('throws when title is missing', () => {
    expect(() =>
      validateCatalogDescriptor(catalogDescriptor(fields, { title: '' })),
    ).toThrowError(/catalog.title is required/)
  })

  it('throws when title names an undeclared field', () => {
    expect(() =>
      validateCatalogDescriptor(catalogDescriptor(fields, { title: 'nope' })),
    ).toThrowError(/catalog.title "nope" is not declared/)
  })

  it('throws when icon names an undeclared field', () => {
    expect(() =>
      validateCatalogDescriptor(
        catalogDescriptor(fields, { icon: 'nope', title: 'display_name' }),
      ),
    ).toThrowError(/catalog.icon "nope" is not declared/)
  })

  it('throws when subtitle names an undeclared field', () => {
    expect(() =>
      validateCatalogDescriptor(
        catalogDescriptor(fields, { title: 'display_name', subtitle: 'nope' }),
      ),
    ).toThrowError(/catalog.subtitle "nope" is not declared/)
  })

  it('is a no-op for every other viewType', () => {
    const nonCatalog: ViewDescriptor = { entity: 'crm', viewType: 'form', fields: [] }
    expect(() => validateCatalogDescriptor(nonCatalog)).not.toThrow()
  })
})

describe('validateSearchDescriptor', () => {
  const searchFields: FieldDescriptor[] = [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'status', label: 'Status', type: 'selection', selection: { options: ['open', 'won'] } },
  ]

  const treeDescriptor = (fields: FieldDescriptor[], search: SearchDescriptor | undefined): ViewDescriptor => ({
    entity: 'crm',
    viewType: 'tree',
    fields,
    search,
  })

  it('passes a valid search block naming declared fields', () => {
    expect(() =>
      validateSearchDescriptor(
        treeDescriptor(searchFields, {
          liveFields: [{ field: 'name', priority: 0 }],
          filterableFields: ['name', 'status'],
          groupableFields: ['status'],
        }),
      ),
    ).not.toThrow()
  })

  it('is a no-op when search is omitted', () => {
    expect(() => validateSearchDescriptor(treeDescriptor(searchFields, undefined))).not.toThrow()
  })

  it('throws when liveFields names an undeclared field', () => {
    expect(() =>
      validateSearchDescriptor(treeDescriptor(searchFields, { liveFields: [{ field: 'nope' }] })),
    ).toThrowError(/search.liveFields "nope" is not declared/)
  })

  it('throws when filterableFields names an undeclared field', () => {
    expect(() =>
      validateSearchDescriptor(treeDescriptor(searchFields, { filterableFields: ['nope'] })),
    ).toThrowError(/search.filterableFields "nope" is not declared/)
  })

  it('throws when groupableFields names an undeclared field', () => {
    expect(() =>
      validateSearchDescriptor(treeDescriptor(searchFields, { groupableFields: ['nope'] })),
    ).toThrowError(/search.groupableFields "nope" is not declared/)
  })

  it('is a no-op for every other viewType, even with a search block set', () => {
    const nonTree: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: searchFields,
      search: { filterableFields: ['nope'] },
    }
    expect(() => validateSearchDescriptor(nonTree)).not.toThrow()
  })
})

describe('validateStatusBarDescriptor', () => {
  const statusFields: FieldDescriptor[] = [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'status', label: 'Status', type: 'selection', selection: { options: ['draft', 'sent'] } },
  ]

  const formDescriptor = (fields: FieldDescriptor[], statusBar: { field: string } | undefined): ViewDescriptor => ({
    entity: 'invoice',
    viewType: 'form',
    fields,
    statusBar,
  })

  it('passes a valid statusBar naming a declared selection field', () => {
    expect(() =>
      validateStatusBarDescriptor(formDescriptor(statusFields, { field: 'status' })),
    ).not.toThrow()
  })

  it('is a no-op when statusBar is omitted', () => {
    expect(() => validateStatusBarDescriptor(formDescriptor(statusFields, undefined))).not.toThrow()
  })

  it('throws when the field is not declared', () => {
    expect(() =>
      validateStatusBarDescriptor(formDescriptor(statusFields, { field: 'nope' })),
    ).toThrowError(/statusBar.field "nope" is not declared/)
  })

  it('throws when the field is not type "selection"', () => {
    expect(() =>
      validateStatusBarDescriptor(formDescriptor(statusFields, { field: 'name' })),
    ).toThrowError(/statusBar.field "name" must be type 'selection'/)
  })

  it('is a no-op for every other viewType, even with a statusBar block set', () => {
    const nonForm: ViewDescriptor = {
      entity: 'invoice',
      viewType: 'tree',
      fields: statusFields,
      statusBar: { field: 'nope' },
    }
    expect(() => validateStatusBarDescriptor(nonForm)).not.toThrow()
  })
})

describe('normalizeLayout', () => {
  // viewType 'tree' (not 'form'): this block is about the GENERIC flat
  // fallback shared by every non-form view — the form-specific header/
  // two-column default (docs/roadmaps/responsive-displays.md, Phase 3) has
  // its own describe block below.
  const three: ViewDescriptor = {
    entity: 'crm',
    viewType: 'tree',
    fields: [field('text'), { ...field('text'), name: 'g' }, { ...field('text'), name: 'h' }],
  }

  it('back-compat: no layout ⇒ one implicit, untitled group wrapping fields in declaration order', () => {
    expect(normalizeLayout(three)).toEqual([
      {
        kind: 'group',
        children: [
          { kind: 'field', name: 'f' },
          { kind: 'field', name: 'g' },
          { kind: 'field', name: 'h' },
        ],
      },
    ])
  })

  it('returns an explicit, valid layout as declared', () => {
    const layout: LayoutNode[] = [
      { kind: 'section', title: 'Main', children: [{ kind: 'field', name: 'g' }] },
      { kind: 'row', id: 'r1', children: [{ kind: 'field', name: 'f' }, { kind: 'field', name: 'h' }] },
    ]
    expect(normalizeLayout({ ...three, layout })).toBe(layout)
  })

  it('rejects a layout field name absent from `fields`', () => {
    const layout: LayoutNode[] = [{ kind: 'field', name: 'nope' }]
    expect(() => normalizeLayout({ ...three, layout })).toThrowError(
      /field "nope" is not declared in this view's fields/,
    )
  })

  it('rejects a field appearing twice, even nested in different containers', () => {
    const layout: LayoutNode[] = [
      { kind: 'group', children: [{ kind: 'field', name: 'f' }] },
      { kind: 'row', children: [{ kind: 'field', name: 'f' }] },
    ]
    expect(() => normalizeLayout({ ...three, layout })).toThrowError(
      /field "f" appears more than once/,
    )
  })

  it('rejects a duplicate node id, even across sibling containers', () => {
    const layout: LayoutNode[] = [
      { kind: 'group', id: 'dup', children: [{ kind: 'field', name: 'f' }] },
      { kind: 'row', id: 'dup', children: [{ kind: 'field', name: 'g' }] },
    ]
    expect(() => normalizeLayout({ ...three, layout })).toThrowError(/node id "dup" is not unique/)
  })
})

// docs/roadmaps/responsive-displays.md, Phases 3–4: the default anatomy for
// an un-layouted `viewType: 'form'` descriptor — a header (picture + big
// title), a two-column group holding most fields, and a notebook whose
// Settings page holds the `widget: 'long'` ones. Every other view type
// keeps the flat implicit group, pinned above. The notebook/Settings page
// ALWAYS render (even with no long field — it's also where a record's own
// runtime pages will live), so every test below expects exactly 3 top-level
// nodes unless noted.
describe('normalizeLayout — form view synthesis', () => {
  const textF = (name: string): FieldDescriptor => ({ name, label: name, type: 'text' })
  const longF = (name: string): FieldDescriptor => ({
    name,
    label: name,
    type: 'text',
    widget: 'long',
  })
  const pictureF = (name: string): FieldDescriptor => ({
    name,
    label: name,
    type: 'boolean',
    widget: 'picture',
  })
  const emptySettingsPage = {
    kind: 'notebook',
    id: FORM_NOTEBOOK_ID,
    children: [{ kind: 'page', id: PAGE_SETTINGS_ID, title: 'Settings', children: [] }],
  }

  it('header = [picture, title(first text, variant "title")], columns = everything else, in declaration order', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [pictureF('photo'), textF('name'), textF('email'), field('number'), textF('company')],
    }
    expect(normalizeLayout(descriptor)).toEqual([
      {
        kind: 'row',
        id: FORM_HEADER_ID,
        children: [
          { kind: 'field', name: 'photo' },
          { kind: 'field', name: 'name', variant: 'title' },
        ],
      },
      {
        kind: 'group',
        id: FORM_COLUMNS_ID,
        columns: 2,
        children: [
          { kind: 'field', name: 'email' },
          { kind: 'field', name: 'f' },
          { kind: 'field', name: 'company' },
        ],
      },
      emptySettingsPage,
    ])
  })

  it('no picture field: header holds only the title', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [textF('name'), textF('email')],
    }
    expect(normalizeLayout(descriptor)[0]).toEqual({
      kind: 'row',
      id: FORM_HEADER_ID,
      children: [{ kind: 'field', name: 'name', variant: 'title' }],
    })
  })

  it('no text field: no title, and — since nothing else is header material — no header row at all', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [field('number'), field('boolean')],
    }
    const nodes = normalizeLayout(descriptor)
    // No header row, but columns + the always-present notebook still do.
    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toMatchObject({ kind: 'group', id: FORM_COLUMNS_ID })
    expect(nodes[1]).toEqual(emptySettingsPage)
  })

  it('a picture field with NO text field still gets a header (picture only, no title)', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [pictureF('photo'), field('number')],
    }
    expect(normalizeLayout(descriptor)[0]).toEqual({
      kind: 'row',
      id: FORM_HEADER_ID,
      children: [{ kind: 'field', name: 'photo' }],
    })
  })

  it('only the FIRST text field becomes the title; later text fields land in columns', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [textF('name'), textF('nickname')],
    }
    const columns = normalizeLayout(descriptor).find((n) => n.kind !== 'field' && n.id === FORM_COLUMNS_ID)
    expect(columns).toMatchObject({ children: [{ kind: 'field', name: 'nickname' }] })
  })

  it('an explicit layout on a form view is returned as-is — no synthesis', () => {
    const layout: LayoutNode[] = [{ kind: 'group', children: [{ kind: 'field', name: 'name' }] }]
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [textF('name')],
      layout,
    }
    expect(normalizeLayout(descriptor)).toBe(layout)
  })

  it('every other view type keeps the flat implicit group even with a picture/text mix', () => {
    for (const viewType of ['tree', 'dashboard'] as const) {
      const descriptor: ViewDescriptor = {
        entity: 'crm',
        viewType,
        fields: [pictureF('photo'), textF('name')],
      }
      expect(normalizeLayout(descriptor)).toEqual([
        {
          kind: 'group',
          children: [
            { kind: 'field', name: 'photo' },
            { kind: 'field', name: 'name' },
          ],
        },
      ])
    }
  })

  // docs/roadmaps/responsive-displays.md, Phase 4: the notebook and its
  // always-present Settings page.
  describe('the synthesized notebook', () => {
    it('every widget:"long" field lands on the Settings page, in declaration order, and leaves __form_columns', () => {
      const descriptor: ViewDescriptor = {
        entity: 'crm',
        viewType: 'form',
        fields: [textF('name'), field('number'), longF('notes'), textF('company'), longF('comment')],
      }
      const nodes = normalizeLayout(descriptor)
      const columns = nodes.find((n) => n.kind !== 'field' && n.id === FORM_COLUMNS_ID)
      const notebook = nodes.find((n) => n.kind !== 'field' && n.id === FORM_NOTEBOOK_ID)
      expect(columns).toMatchObject({
        children: [{ kind: 'field', name: 'f' }, { kind: 'field', name: 'company' }],
      })
      expect(notebook).toEqual({
        kind: 'notebook',
        id: FORM_NOTEBOOK_ID,
        children: [
          {
            kind: 'page',
            id: PAGE_SETTINGS_ID,
            title: 'Settings',
            children: [{ kind: 'field', name: 'notes' }, { kind: 'field', name: 'comment' }],
          },
        ],
      })
    })

    it('a widget:"long" field is never chosen as the title, even when it is the very first text field', () => {
      const descriptor: ViewDescriptor = {
        entity: 'crm',
        viewType: 'form',
        fields: [longF('bio'), textF('name')],
      }
      const nodes = normalizeLayout(descriptor)
      const header = nodes.find((n) => n.kind !== 'field' && n.id === FORM_HEADER_ID)
      expect(header).toEqual({
        kind: 'row',
        id: FORM_HEADER_ID,
        children: [{ kind: 'field', name: 'name', variant: 'title' }],
      })
      const notebook = nodes.find((n) => n.kind !== 'field' && n.id === FORM_NOTEBOOK_ID)
      expect(notebook).toMatchObject({
        children: [{ children: [{ kind: 'field', name: 'bio' }] }],
      })
    })

    it('no long field: the Settings page still renders, empty', () => {
      const descriptor: ViewDescriptor = {
        entity: 'crm',
        viewType: 'form',
        fields: [textF('name')],
      }
      const nodes = normalizeLayout(descriptor)
      expect(nodes.at(-1)).toEqual(emptySettingsPage)
    })
  })
})

describe('normalizeLayout — notebook/page validation (explicit layouts)', () => {
  const two: ViewDescriptor = {
    entity: 'crm',
    viewType: 'form',
    fields: [field('text'), { ...field('text'), name: 'g' }],
  }

  it('accepts a well-formed notebook of pages', () => {
    const layout: LayoutNode[] = [
      {
        kind: 'notebook',
        id: 'nb',
        children: [
          { kind: 'page', id: 'p1', title: 'One', children: [{ kind: 'field', name: 'f' }] },
          { kind: 'page', id: 'p2', title: 'Two', children: [{ kind: 'field', name: 'g' }] },
        ],
      },
    ]
    expect(normalizeLayout({ ...two, layout })).toBe(layout)
  })

  it('rejects a page with no title — it doubles as the tab label', () => {
    const layout: LayoutNode[] = [
      { kind: 'notebook', children: [{ kind: 'page', children: [{ kind: 'field', name: 'f' }] } as LayoutNode] },
    ]
    expect(() => normalizeLayout({ ...two, layout })).toThrowError(/requires a title/)
  })

  it('rejects a page that is not a direct child of a notebook (top-level)', () => {
    const layout: LayoutNode[] = [
      { kind: 'page', title: 'Stray', children: [{ kind: 'field', name: 'f' }] } as LayoutNode,
    ]
    expect(() => normalizeLayout({ ...two, layout })).toThrowError(
      /must be a direct child of a "notebook"/,
    )
  })

  it('rejects a page nested inside a group instead of a notebook', () => {
    const layout: LayoutNode[] = [
      {
        kind: 'group',
        children: [{ kind: 'page', title: 'Stray', children: [{ kind: 'field', name: 'f' }] } as LayoutNode],
      },
    ]
    expect(() => normalizeLayout({ ...two, layout })).toThrowError(
      /must be a direct child of a "notebook"/,
    )
  })

  it('rejects a notebook with a non-page child', () => {
    const layout: LayoutNode[] = [
      {
        kind: 'notebook',
        id: 'nb',
        children: [{ kind: 'field', name: 'f' } as LayoutNode],
      },
    ]
    expect(() => normalizeLayout({ ...two, layout })).toThrowError(
      /notebook "nb" may only contain "page" children, found "field"/,
    )
  })

  it('rejects a second notebook anywhere in the tree', () => {
    const layout: LayoutNode[] = [
      { kind: 'notebook', id: 'nb1', children: [{ kind: 'page', title: 'A', children: [] }] },
      { kind: 'notebook', id: 'nb2', children: [{ kind: 'page', title: 'B', children: [] }] },
    ]
    expect(() => normalizeLayout({ ...two, layout })).toThrowError(/at most one "notebook" node/)
  })
})

describe('layoutFieldOrder', () => {
  it('matches fields declaration order for the implicit fallback (tree view)', () => {
    const three: ViewDescriptor = {
      entity: 'crm',
      viewType: 'tree',
      fields: [field('text'), { ...field('text'), name: 'g' }, { ...field('text'), name: 'h' }],
    }
    expect(layoutFieldOrder(normalizeLayout(three))).toEqual(['f', 'g', 'h'])
  })

  it('flattens nested group/row/section to leaf tree-walk order', () => {
    const layout: LayoutNode[] = [
      { kind: 'section', title: 'Main', children: [{ kind: 'field', name: 'a' }] },
      {
        kind: 'row',
        children: [
          { kind: 'field', name: 'b' },
          { kind: 'group', children: [{ kind: 'field', name: 'c' }, { kind: 'field', name: 'd' }] },
        ],
      },
    ]
    expect(layoutFieldOrder(layout)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('titleFieldName', () => {
  it('finds the default form anatomy\'s synthesized title field (the first plain text field)', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [
        { name: 'name', label: 'Name', type: 'text' },
        { name: 'notes', label: 'Notes', type: 'text', widget: 'long' },
      ],
    }
    expect(titleFieldName(normalizeLayout(descriptor))).toBe('name')
  })

  it('finds an explicit layout\'s variant: title field regardless of position', () => {
    const layout: LayoutNode[] = [
      { kind: 'group', children: [{ kind: 'field', name: 'a' }, { kind: 'field', name: 'b', variant: 'title' }] },
    ]
    expect(titleFieldName(layout)).toBe('b')
  })

  it('returns null when no field carries the title variant', () => {
    const layout: LayoutNode[] = [{ kind: 'group', children: [{ kind: 'field', name: 'a' }] }]
    expect(titleFieldName(layout)).toBeNull()
  })
})

describe('layout tree — RSC serializability', () => {
  // Descriptors cross the RSC boundary as props: no functions, no undefined,
  // no non-plain values, ever. A JSON round trip is the practical enforcement
  // — anything that doesn't survive it isn't safe to hand to a Server Component.
  it('a layout tree exercising every node kind survives a JSON round trip unchanged', () => {
    const layout: LayoutNode[] = [
      {
        kind: 'section',
        id: 'main',
        title: 'Main',
        children: [
          { kind: 'field', name: 'name' },
          {
            kind: 'row',
            id: 'r1',
            children: [{ kind: 'field', name: 'email' }, { kind: 'field', name: 'phone' }],
          },
        ],
      },
      { kind: 'group', children: [{ kind: 'field', name: 'notes' }] },
    ]
    expect(JSON.parse(JSON.stringify(layout))).toEqual(layout)
  })
})

describe('evaluateCondition', () => {
  const record = { status: 'won', score: 3, tags: null as unknown, note: '' }

  it('eq / ne', () => {
    expect(evaluateCondition({ field: 'status', op: 'eq', value: 'won' }, record)).toBe(true)
    expect(evaluateCondition({ field: 'status', op: 'eq', value: 'lost' }, record)).toBe(false)
    expect(evaluateCondition({ field: 'status', op: 'ne', value: 'lost' }, record)).toBe(true)
    expect(evaluateCondition({ field: 'status', op: 'ne', value: 'won' }, record)).toBe(false)
  })

  it('in', () => {
    expect(
      evaluateCondition({ field: 'status', op: 'in', value: ['won', 'running'] }, record),
    ).toBe(true)
    expect(evaluateCondition({ field: 'status', op: 'in', value: ['lost', 'closed'] }, record)).toBe(
      false,
    )
    // A non-array value is a malformed condition, not a crash — reads as false.
    expect(evaluateCondition({ field: 'status', op: 'in', value: 'won' }, record)).toBe(false)
  })

  it('set / unset: null, undefined, and empty string all count as unset', () => {
    expect(evaluateCondition({ field: 'score', op: 'set' }, record)).toBe(true)
    expect(evaluateCondition({ field: 'score', op: 'unset' }, record)).toBe(false)
    expect(evaluateCondition({ field: 'tags', op: 'unset' }, record)).toBe(true)
    expect(evaluateCondition({ field: 'note', op: 'unset' }, record)).toBe(true)
    expect(evaluateCondition({ field: 'missing', op: 'unset' }, record)).toBe(true)
    expect(evaluateCondition({ field: 'missing', op: 'set' }, record)).toBe(false)
  })

  it('a zero/false value still reads as SET — only null/undefined/"" are unset', () => {
    expect(evaluateCondition({ field: 'zero', op: 'set' }, { zero: 0 })).toBe(true)
    expect(evaluateCondition({ field: 'flag', op: 'set' }, { flag: false })).toBe(true)
  })

  it('all: every sub-condition must hold', () => {
    const cond: Condition = {
      all: [
        { field: 'status', op: 'eq', value: 'won' },
        { field: 'score', op: 'eq', value: 3 },
      ],
    }
    expect(evaluateCondition(cond, record)).toBe(true)
    expect(evaluateCondition(cond, { ...record, score: 1 })).toBe(false)
  })

  it('any: at least one sub-condition must hold', () => {
    const cond: Condition = {
      any: [
        { field: 'status', op: 'eq', value: 'lost' },
        { field: 'status', op: 'eq', value: 'won' },
      ],
    }
    expect(evaluateCondition(cond, record)).toBe(true)
    expect(evaluateCondition(cond, { ...record, status: 'running' })).toBe(false)
  })

  it('combinators nest', () => {
    const cond: Condition = {
      all: [
        { field: 'score', op: 'set' },
        { any: [{ field: 'status', op: 'eq', value: 'won' }, { field: 'status', op: 'eq', value: 'lost' }] },
      ],
    }
    expect(evaluateCondition(cond, record)).toBe(true)
    expect(evaluateCondition(cond, { ...record, status: 'running' })).toBe(false)
  })

  it('a condition on a field that does not exist degrades to false, never throws', () => {
    expect(() => evaluateCondition({ field: 'ghost', op: 'eq', value: 'x' }, record)).not.toThrow()
    expect(evaluateCondition({ field: 'ghost', op: 'eq', value: 'x' }, record)).toBe(false)
  })
})

describe('isFieldVisible', () => {
  it('true when neither invisible nor states.visible is declared', () => {
    expect(isFieldVisible({ name: 'a', type: 'text' }, {})).toBe(true)
  })

  it('false when the static invisible flag is set, regardless of states.visible', () => {
    expect(
      isFieldVisible(
        {
          name: 'a',
          type: 'text',
          invisible: true,
          states: { visible: { field: 'status', op: 'eq', value: 'won' } },
        },
        { status: 'won' },
      ),
    ).toBe(false)
  })

  it('follows states.visible when invisible is not set', () => {
    const field: FieldDescriptor = {
      name: 'a',
      type: 'text',
      states: { visible: { field: 'status', op: 'eq', value: 'won' } },
    }
    expect(isFieldVisible(field, { status: 'won' })).toBe(true)
    expect(isFieldVisible(field, { status: 'lost' })).toBe(false)
  })
})

describe('requiredMissing', () => {
  const descriptor = (fields: FieldDescriptor[]): ViewDescriptor => ({
    entity: 'crm',
    viewType: 'form',
    fields,
  })

  it('static required, unset: reported', () => {
    const d = descriptor([{ name: 'name', type: 'text', required: true }])
    expect(requiredMissing(d, {})).toEqual(['name'])
  })

  it('static required, set: not reported', () => {
    const d = descriptor([{ name: 'name', type: 'text', required: true }])
    expect(requiredMissing(d, { name: 'Ada' })).toEqual([])
  })

  it('a states.required condition acts exactly like static required when it holds', () => {
    const d = descriptor([
      { name: 'status', type: 'text' },
      {
        name: 'comment',
        type: 'text',
        states: { required: { field: 'status', op: 'eq', value: 'lost' } },
      },
    ])
    expect(requiredMissing(d, { status: 'lost' })).toEqual(['comment'])
    expect(requiredMissing(d, { status: 'won' })).toEqual([])
  })

  it('a HIDDEN field never blocks, even if required — visible:false wins', () => {
    const d = descriptor([
      {
        name: 'comment',
        type: 'text',
        required: true,
        states: { visible: { field: 'status', op: 'eq', value: 'lost' } },
      },
    ])
    // status isn't 'lost' -> comment is invisible -> required is inert.
    expect(requiredMissing(d, { status: 'won' })).toEqual([])
    // status IS 'lost' -> comment is visible -> required blocks.
    expect(requiredMissing(d, { status: 'lost' })).toEqual(['comment'])
  })

  it('a statically invisible field never blocks either, even if required and states.visible would hold', () => {
    const d = descriptor([
      {
        name: 'comment',
        type: 'text',
        required: true,
        invisible: true,
        states: { visible: { field: 'status', op: 'eq', value: 'lost' } },
      },
    ])
    expect(requiredMissing(d, { status: 'lost' })).toEqual([])
  })

  it('virtual relations (o2m/m2m) are never reported — they have no column to fill', () => {
    const d = descriptor([
      {
        name: 'tags',
        type: 'relation',
        required: true,
        relation: { entity: 'tag', kind: 'many2many', via: 'crm_tag' },
      },
    ])
    expect(requiredMissing(d, {})).toEqual([])
  })

  it('reports every missing field, in descriptor order', () => {
    const d = descriptor([
      { name: 'a', type: 'text', required: true },
      { name: 'b', type: 'text' },
      { name: 'c', type: 'text', required: true },
    ])
    expect(requiredMissing(d, { b: 'x' })).toEqual(['a', 'c'])
  })
})
