// View descriptors — the metadata a module contributes. A module ships DESCRIPTORS
// ONLY; the engine derives the server loader, the Zustand store, and the renderer
// from them (CONVENTIONS.md — Module FE contract). Adding an entity is a descriptor;
// adding a view type is one store factory + one renderer + one loader path.

import type { ViewModeDefaults } from '../api/view-fields'

export type ViewType = 'form' | 'tree' | 'dashboard' | 'catalog'

export type FieldType = 'text' | 'number' | 'date' | 'relation' | 'boolean' | 'selection' | 'totals'

/**
 * Descriptors cross the RSC boundary as props, so everything in them — widget
 * options included — must stay JSON-serializable. No functions, ever.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * The widgets each field type may render as; the FIRST entry is the type's
 * default. `type` is the data type, `widget` the presentation — a descriptor
 * never needs one for the stock look (docs/roadmaps/field-widgets.md).
 * boolean picture/signature are backed by the core picture service (the DB
 * column stores only the flag, the service owns the bytes — field true ⇔ a
 * picture exists on the anchor). Relation tags/list (Phase 4) will extend this
 * matrix. selection has exactly one widget (`select`, a dropdown) — the type
 * exists to declare a closed value list (SelectionDescriptor), not to offer
 * presentation variants. text/table (docs/roadmaps/app-store.md, Phase 2) is
 * the odd one out: its VALUE is an array of records, not a string — a
 * deliberate simplification (no new FieldType) for a read-only, `store: false`
 * field whose value is seeded server-side, never typed or edited. text/color
 * is a hex-string field rendered as a swatch + hex TextField, the same visual
 * pattern Settings -> Global settings -> Colors uses for the brand palette
 * (there it edits useUiStore directly; here it's a plain text field like any
 * other). selection/linked (docs/roadmaps/pdf-reports.md's page-format
 * presets) is a dropdown that ALSO patches sibling fields per
 * widgetOptions.presets when an option is picked — a generic "apply a preset"
 * mechanism, not specific to page formats; see widgets.tsx's
 * SelectionLinkedWidget for the exact contract. type/totals (sale/quote's
 * totals recap block) is the other odd one out: its value, like text/table,
 * is never typed or stored (`store: false`) — it computes itself, live, from
 * the SAME one2many lines its sibling relation field already reads (declared
 * via `relation`, exactly like a relation field's own block), grouped by
 * each line's own tax rate. One widget, 'recap' — no presentation variants.
 */
export const FIELD_WIDGETS: Record<FieldType, readonly string[]> = {
  text: ['simple', 'long', 'phone', 'table', 'color'],
  number: ['float', 'int', 'percent', 'stars', 'phone'],
  boolean: ['switch', 'picture', 'signature'],
  date: ['simple'],
  relation: ['search', 'tags', 'list'],
  selection: ['select', 'linked'],
  totals: ['recap'],
}

export type RelationKind = 'many2one' | 'one2many' | 'many2many'

/**
 * Each relation kind renders as exactly one widget in v1; the kind therefore
 * doubles as the field's default widget (a relation never falls back to the
 * matrix's first entry).
 */
export const RELATION_KIND_WIDGETS: Record<RelationKind, string> = {
  many2one: 'search',
  one2many: 'list',
  many2many: 'tags',
}

/**
 * How a relation field points at another entity. `entity` is the Go route
 * prefix, as everywhere. JSON-only — this block crosses the RSC boundary.
 */
export interface RelationDescriptor {
  /** The related entity (its generic CRUD route prefix = its table name). */
  entity: string
  kind: RelationKind
  /** The related record's display field (tags, autocomplete rows). Default 'name'. */
  labelField?: string
  /** one2many: the FK column ON THE RELATED entity that points back at this record. */
  inverseField?: string
  /** many2many: the junction entity holding one row per link. */
  via?: string
  /**
   * many2many: the junction's FK columns. Defaults to `<own entity>_id` /
   * `<related entity>_id` — declare explicitly when the junction deviates.
   */
  viaFields?: { own: string; related: string }
}

/**
 * How a `selection` field's pickable values are declared. `options` is the
 * closed list the user chooses from, IN ORDER — order matters twice: it is
 * the dropdown's display order, and (absent an explicit `default` on the
 * field) the FIRST entry is the field's default value (see fieldZeroDefault).
 * JSON-only — this block crosses the RSC boundary.
 */
export interface SelectionDescriptor {
  options: string[]
}

// ── declarative field states (docs/roadmaps/view-customization.md, Phase 2) ───
// Modifiers that react to the record ITSELF — e.g. a status field flipping a
// comment field visible — expressed as DATA, never a function (the RSC rule:
// descriptors cross the server/client boundary as props). Mirrors Odoo's
// attrs-as-data XML approach: `<field name="comment" attrs="{'invisible':
// [('status','=','lead')]}"/>` becomes `states: { visible: { field: 'status',
// op: 'ne', value: 'lead' } }`.

export type ConditionOp = 'eq' | 'ne' | 'in' | 'set' | 'unset'

/** A single comparison against another field's value in the same record/draft. */
export interface FieldCondition {
  field: string
  op: ConditionOp
  /** Required for 'eq'/'ne'/'in' (an array for 'in'); ignored for 'set'/'unset'. */
  value?: JsonValue
}

export interface AllCondition {
  all: Condition[]
}

export interface AnyCondition {
  any: Condition[]
}

export type Condition = FieldCondition | AllCondition | AnyCondition

export interface FieldDescriptor {
  /** Property name on the record and the form draft. */
  name: string
  /** Human label shown by the renderer. */
  label?: string
  type: FieldType
  /**
   * Presentation decorator: how the value renders and edits (e.g. a number as
   * 'stars', a text as 'long'). Must be allowed for the type per FIELD_WIDGETS;
   * omitted = the type's default. Validated at module registration.
   */
  widget?: string
  /** Widget tuning (e.g. { max: 5 } for stars). JSON-serializable only. */
  widgetOptions?: Record<string, JsonValue>
  required?: boolean
  /**
   * Seed value for the field when the record lacks it (new records, columns
   * added after rows existed). Either a JSON literal, or the NAME of a field
   * function registered via registerFieldFunction — called with the seed draft,
   * its return value becomes the default. A name, never a function object (the
   * RSC rule, same as `compute`). Omitted = the type's zero default: text `''`,
   * number `0`, boolean `false`, date/relation `null` (see fieldZeroDefault).
   * Pitfall: a literal string default that collides with a registered function
   * name is resolved as the function — function names are namespaced
   * ('<entity>.<what>'), so collisions don't happen by accident.
   */
  default?: JsonValue
  /**
   * Name of a registered field function (registerFieldFunction) computing this
   * field's value from the draft. A NAME, never a function — descriptors cross
   * the RSC boundary. Computed fields render read-only and recompute whenever a
   * field in the function's `depends` list changes.
   */
  compute?: string
  /**
   * Whether the value persists to the DB column on commit. Default true.
   * `store: false` = display-only (typically with `compute`): stripped from the
   * commit payload and expected absent in server data. one2many/many2many
   * relation fields are display-only regardless — the links live on the other
   * side (inverse FK / junction rows), never in a column of this record.
   */
  store?: boolean
  /** Required on type 'relation': where the field points (see RelationDescriptor). */
  relation?: RelationDescriptor
  /** Required on type 'selection': the pickable values (see SelectionDescriptor). */
  selection?: SelectionDescriptor
  /**
   * Static, unconditional read-only (docs/roadmaps/app-store.md, Phase 2) —
   * unlike `states.readOnly`, this never reevaluates against the draft; the
   * field simply never accepts edits, for the descriptor's whole lifetime.
   * OR's into the same disabled computation as `states.readOnly` and
   * `compute`, so it composes with both: STATIC wins (there is no condition
   * that can turn it back on). The intended use is a form over data the user
   * may only inspect (the App Store's module.json fields) — as opposed to
   * `compute`, which still WRITES a value (just a derived one) on commit,
   * `readOnly: true` never writes anything at all, computed or not.
   */
  readOnly?: boolean
  /**
   * Static, unconditional visibility — the same "never rendered, for the
   * descriptor's whole lifetime" posture `readOnly` has for edits. Unlike
   * `states.visible` (a condition reevaluated against the draft), this never
   * turns back on. Combines with `states.visible` exactly like `readOnly`
   * combines with `states.readOnly`: either one hiding the field is enough
   * (see `isFieldVisible`) — a field hidden either way still can't block
   * commit via `required` (`requiredMissing` skips it), since the user has no
   * way to fill in what they can't see.
   */
  invisible?: boolean
  /**
   * Server-enforced group gating (core/orm's `WithFieldGroups` /
   * `FieldMeta.Groups`): when set, Go's generic CRUD `BuildResponse` omits
   * this column's KEY entirely from every JSON response for a caller whose
   * resolved group set (JWT `groups` claim — a role's own technical_name
   * plus every role it transitively belongs to, Odoo `implied_ids`-style)
   * doesn't intersect these strings. That server omission is the real
   * security boundary; `groups` here is purely the client-side UX
   * counterpart (see `isFieldVisible`), so a gated field's slot doesn't
   * render empty/broken for a user who can never receive its value — it
   * never affects what data is actually reachable.
   */
  groups?: string[]
  /**
   * Suppresses the field's own label (the boxed TextField label, the
   * FormControlLabel text, or the small caption a widget renders above
   * itself) while still rendering the field itself — unlike `invisible`,
   * which hides the whole field. For a field whose surrounding layout
   * already names it (a section title, a single-field row), so the widget
   * doesn't repeat it.
   */
  hideLabel?: boolean
  /**
   * Declarative modifiers reevaluated against the CURRENT DRAFT on every
   * edit — they react to the user's OWN changes (e.g. a status field flips a
   * comment field visible), no code involved. `visible: false` UNMOUNTS the
   * field without touching its draft value (toggling it back on shows
   * whatever was last set/loaded — it never resets). `readOnly: true` OR's
   * into the widget's disabled state alongside the existing compute-disables
   * rule and the static `FieldDescriptor.readOnly` above (static wins).
   * `required: true` blocks commit (see `requiredMissing`) exactly like the
   * static `required` flag, but only while the field is visible — a hidden
   * field can never block commit; the user has no way to fill in what they
   * can't see.
   */
  states?: {
    visible?: Condition
    readOnly?: Condition
    required?: Condition
  }
}

/**
 * Resolve a field's display label: the declared one, or the field name
 * humanized (`contact_id` → "Contact id") when omitted. Every renderer/widget
 * labels through this helper — the result is the gettext msgid, so a derived
 * label simply renders verbatim until a module ships an explicit one.
 */
export function fieldLabel(field: FieldDescriptor): string {
  if (field.label) return field.label
  const words = field.name.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Resolve a field's effective widget: the declared one when valid, the type's
 * default when omitted. Throws — naming field, type, and widget — on a pair the
 * matrix forbids, so a bad descriptor fails at registration, not at render.
 */
export function resolveWidget(field: FieldDescriptor): string {
  const allowed = FIELD_WIDGETS[field.type]
  if (!allowed) {
    throw new Error(`field "${field.name}": unknown field type "${field.type}"`)
  }
  if (field.type === 'relation') return resolveRelationWidget(field)
  if (field.type === 'selection') return resolveSelectionWidget(field)
  if (field.type === 'totals' && !field.relation) {
    throw new Error(`field "${field.name}": type 'totals' requires a relation block (the lines it recaps)`)
  }
  const widget = field.widget ?? allowed[0]
  if (!allowed.includes(widget)) {
    throw new Error(
      `field "${field.name}": widget "${widget}" is not allowed for type "${field.type}" ` +
        `(allowed: ${allowed.join(', ')})`,
    )
  }
  return widget
}

/**
 * Relation fields carry extra invariants: the relation block is mandatory, the
 * widget must match the kind (1:1 in v1 — the kind is the default), o2m needs
 * the inverse FK column, m2m the junction entity. All enforced at registration
 * so a broken descriptor fails the build, not the form.
 */
function resolveRelationWidget(field: FieldDescriptor): string {
  const rel = field.relation
  if (!rel) {
    throw new Error(`field "${field.name}": type 'relation' requires a relation block`)
  }
  const expected = RELATION_KIND_WIDGETS[rel.kind]
  if (!expected) {
    throw new Error(`field "${field.name}": unknown relation kind "${rel.kind}"`)
  }
  const widget = field.widget ?? expected
  if (widget !== expected) {
    throw new Error(
      `field "${field.name}": widget "${widget}" does not match relation kind ` +
        `"${rel.kind}" (expected "${expected}")`,
    )
  }
  if (rel.kind === 'one2many' && !rel.inverseField) {
    throw new Error(`field "${field.name}": one2many relations require inverseField`)
  }
  if (rel.kind === 'many2many' && !rel.via) {
    throw new Error(`field "${field.name}": many2many relations require via (junction entity)`)
  }
  return widget
}

/**
 * Selection fields carry one invariant: a non-empty options list — the field
 * declares a value picker, so an empty list has nothing to pick. Enforced at
 * registration, like the relation block, so a broken descriptor fails the
 * build, not the form.
 */
function resolveSelectionWidget(field: FieldDescriptor): string {
  const sel = field.selection
  if (!sel || sel.options.length === 0) {
    throw new Error(`field "${field.name}": type 'selection' requires a non-empty selection.options list`)
  }
  const allowed = FIELD_WIDGETS.selection
  const widget = field.widget ?? allowed[0]
  if (!allowed.includes(widget)) {
    throw new Error(
      `field "${field.name}": widget "${widget}" is not allowed for type "selection" ` +
        `(allowed: ${allowed.join(', ')})`,
    )
  }
  return widget
}

/** Validate every field's widget/type pair of a descriptor (see resolveWidget). */
export function validateDescriptorWidgets<T>(descriptor: ViewDescriptor<T>): void {
  for (const field of descriptor.fields) resolveWidget(field)
}

/**
 * Validate a `viewType: 'catalog'` descriptor's `catalog` block: required,
 * `title` mandatory, and every declared name (`icon`/`title`/`subtitle`)
 * resolves against `fields` — exactly the "dangling reference is a
 * registration error" discipline the layout tree already enforces for its
 * own field leaves. A no-op for every other viewType.
 */
export function validateCatalogDescriptor<T>(descriptor: ViewDescriptor<T>): void {
  if (descriptor.viewType !== 'catalog') return
  const { catalog } = descriptor
  if (!catalog) {
    throw new Error(`viewType 'catalog' requires a "catalog" descriptor block`)
  }
  if (!catalog.title) {
    throw new Error(`catalog.title is required`)
  }
  const fieldNames = new Set(descriptor.fields.map((f) => f.name))
  const checkNamed = (key: 'icon' | 'title' | 'subtitle', name: string | undefined): void => {
    if (name != null && !fieldNames.has(name)) {
      throw new Error(`catalog.${key} "${name}" is not declared in this view's fields`)
    }
  }
  checkNamed('title', catalog.title)
  checkNamed('icon', catalog.icon)
  checkNamed('subtitle', catalog.subtitle)
}

/**
 * Validate a `viewType: 'tree'` descriptor's `search` block, when declared:
 * every named field (liveFields/filterableFields/groupableFields) resolves
 * against `fields` — the same "dangling reference is a registration error"
 * discipline validateCatalogDescriptor already enforces. A no-op when
 * `search` is omitted (the engine default) or the viewType isn't 'tree'.
 */
export function validateSearchDescriptor<T>(descriptor: ViewDescriptor<T>): void {
  if (descriptor.viewType !== 'tree' || !descriptor.search) return
  const { liveFields, filterableFields, groupableFields } = descriptor.search
  const fieldNames = new Set(descriptor.fields.map((f) => f.name))
  const checkNamed = (key: string, name: string): void => {
    if (!fieldNames.has(name)) {
      throw new Error(`search.${key} "${name}" is not declared in this view's fields`)
    }
  }
  for (const entry of liveFields ?? []) checkNamed('liveFields', entry.field)
  for (const name of filterableFields ?? []) checkNamed('filterableFields', name)
  for (const name of groupableFields ?? []) checkNamed('groupableFields', name)
}

/**
 * Validate a `viewType: 'form'` descriptor's `statusBar` block, when
 * declared: the named field must exist AND be `type: 'selection'` (the
 * breadcrumb's steps come from its `selection.options`) — a no-op when
 * `statusBar` is omitted or the viewType isn't 'form'.
 */
export function validateStatusBarDescriptor<T>(descriptor: ViewDescriptor<T>): void {
  if (descriptor.viewType !== 'form' || !descriptor.statusBar) return
  const { field: name } = descriptor.statusBar
  const field = descriptor.fields.find((f) => f.name === name)
  if (!field) {
    throw new Error(`statusBar.field "${name}" is not declared in this view's fields`)
  }
  if (field.type !== 'selection') {
    throw new Error(`statusBar.field "${name}" must be type 'selection', got "${field.type}"`)
  }
}

/**
 * The zero default a field seeds with when the record lacks it and the
 * descriptor declares no `default`: the natural empty value of each data type.
 * Relations default null on the m2o FK ("no target"); virtual relations
 * (o2m/m2m) never seed — they have no column on this record. selection has no
 * natural "empty" value — a closed list has no blank option — so its zero
 * default is the FIRST declared option (resolveWidget already guarantees a
 * non-empty list for any registered descriptor); an explicit `default`
 * overrides it exactly like any other type.
 */
export function fieldZeroDefault(field: FieldDescriptor): JsonValue {
  switch (field.type) {
    case 'text':
      return ''
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'selection':
      return field.selection?.options[0] ?? null
    case 'date':
    case 'relation':
    case 'totals':
      return null
  }
}

/**
 * True for fields whose value never persists on THIS record: o2m/m2m relations
 * (links live on the inverse side / junction). Folded into the behavior plan's
 * unstored set alongside explicit store:false fields.
 */
export function isVirtualRelation(field: FieldDescriptor): boolean {
  return field.type === 'relation' && field.relation != null && field.relation.kind !== 'many2one'
}

/** A field reads as "not filled in": absent, null, or the empty string. Shared
 * by evaluateCondition's set/unset ops and requiredMissing's blank check —
 * one definition of "empty" for the whole states layer. */
function isUnset(value: unknown): boolean {
  return value == null || value === ''
}

/**
 * Evaluate a Condition against a record — typically the current form draft,
 * so states react to the user's OWN edits live. Pure: no exceptions on a
 * missing field (its value reads `undefined`, which correctly fails 'eq'/'in'
 * and IS what 'unset' tests for) — a condition referencing a field that
 * doesn't exist (yet) degrades to "off", never crashes the form.
 */
export function evaluateCondition(cond: Condition, record: Record<string, unknown>): boolean {
  if ('all' in cond) return cond.all.every((c) => evaluateCondition(c, record))
  if ('any' in cond) return cond.any.some((c) => evaluateCondition(c, record))
  const value = record[cond.field]
  switch (cond.op) {
    case 'eq':
      return value === cond.value
    case 'ne':
      return value !== cond.value
    case 'in':
      return Array.isArray(cond.value) && cond.value.includes(value as JsonValue)
    case 'set':
      return !isUnset(value)
    case 'unset':
      return isUnset(value)
  }
}

/**
 * Whether a field renders/counts at all: the static `invisible` flag OR's
 * with the declarative `states.visible` condition and `field.groups` OR's in
 * too — any one hiding the field is enough, and STATIC (`invisible`,
 * `groups`) wins over `states.visible` (no condition can turn it back on).
 * The one definition of "visible" LayoutNodeView (rendering) and
 * requiredMissing (commit validation) both read, so they can never disagree
 * about a field `invisible: true` already unmounted.
 *
 * `callerGroups` is optional and fail-OPEN when omitted (every existing call
 * site keeps compiling and keeps its old behavior) — correct because the
 * real gate already ran server-side (see `FieldDescriptor.groups`'s doc);
 * this check only avoids rendering an empty slot for a field the caller was
 * never sent.
 */
export function isFieldVisible(
  field: FieldDescriptor,
  draft: Record<string, unknown>,
  callerGroups?: string[],
): boolean {
  if (field.invisible) return false
  if (field.groups?.length && callerGroups && !field.groups.some((g) => callerGroups.includes(g))) {
    return false
  }
  return field.states?.visible ? evaluateCondition(field.states.visible, draft) : true
}

/**
 * Names of fields whose EFFECTIVE required (static `required`, OR
 * `states.required` evaluated against `draft`) is true but whose draft value
 * is unset — among fields that are currently VISIBLE (isFieldVisible). A
 * hidden field never blocks: the user has no way to fill in what they can't
 * see, so a required condition on an invisible field is inert by design
 * (mirrors Odoo). Virtual relations (o2m/m2m) are skipped — they have no
 * column on this record, so "required" has no meaning for them. Used by the
 * form store to block commit.
 */
export function requiredMissing<T>(
  descriptor: ViewDescriptor<T>,
  draft: Record<string, unknown>,
): string[] {
  const missing: string[] = []
  for (const field of descriptor.fields) {
    if (isVirtualRelation(field)) continue
    if (!isFieldVisible(field, draft)) continue
    const required =
      field.required === true ||
      (field.states?.required ? evaluateCondition(field.states.required, draft) : false)
    if (!required) continue
    if (isUnset(draft[field.name])) missing.push(field.name)
  }
  return missing
}

// ── layout tree (docs/roadmaps/view-customization.md, Phase 1) ────────────────
// A ViewDescriptor's presentational structure, separate from its field REGISTRY
// (`fields`, still the source of truth for name/type/widget/behaviors). The tree
// is addressed by field name or an explicit node `id` — the anchors a future
// view EXTENSION targets (Phase 3). JSON-only: no functions, ever — it crosses
// the RSC boundary like every other descriptor piece.

export type LayoutNodeKind = 'group' | 'row' | 'section' | 'notebook' | 'page'

/**
 * A structural node: `group` stacks its children vertically, `row` lays them
 * out horizontally, `section` is a titled block, `notebook` is a tabbed
 * container whose children must ALL be `page` nodes (a titled tab's content
 * — legal only directly inside a `notebook`), one per tab
 * (docs/roadmaps/responsive-displays.md, Phase 4). All five share this same
 * shape — the kind is purely a rendering hint plus, for `notebook`/`page`, an
 * extra pair of structural rules `normalizeLayout` enforces at registration
 * time (never a different data contract).
 */
export interface LayoutContainerNode {
  kind: LayoutNodeKind
  /** The anchor an extension's `move`/`addNode` operation targets. Must be
   * unique across the WHOLE tree (registration error otherwise). */
  id?: string
  /** A heading, rendered above the children. A gettext msgid, like any other
   * descriptor string — the extending module ships its own translation.
   * MANDATORY on a `page` node — it's also that page's tab label — and
   * validated as such (registration error, not a blank tab). */
  title?: string
  /**
   * Rendering hint (docs/roadmaps/responsive-displays.md, Phase 3): lay the
   * children out as a CSS grid of up to this many columns instead of the
   * kind's normal stack/row, collapsing to a single column when the
   * container itself is narrow (a CSS container query, keyed off the
   * container's OWN measured width — never a viewport media query, so the
   * SAME node renders correctly full-width on the form page and inside the
   * relation wizard's narrow dialog). JSON-only, like every other hint here.
   */
  columns?: number
  children: LayoutNode[]
}

/** A leaf: renders the named field's widget. `name` must exist in `fields`. */
export interface LayoutFieldNode {
  kind: 'field'
  name: string
  /**
   * Rendering hint (docs/roadmaps/responsive-displays.md, Phase 3): `'title'`
   * renders this field big (a placeholder-labeled, borderless-until-focus
   * input) instead of its normal boxed appearance — the form header's name
   * field, or any explicit layout that wants the same treatment. The field
   * is still fully real: required/states/compute all apply unchanged.
   */
  variant?: 'title'
}

export type LayoutNode = LayoutContainerNode | LayoutFieldNode

/** Well-known ids of the nodes `normalizeLayout` synthesizes for an
 * un-layouted `viewType: 'form'` descriptor — stable across calls so
 * extensions (and, one render layer up, the renderer itself) can target the
 * default anatomy by id, exactly like any hand-authored node id. */
export const FORM_HEADER_ID = '__form_header'
export const FORM_COLUMNS_ID = '__form_columns'
/** The synthesized notebook (docs/roadmaps/responsive-displays.md, Phase 4)
 * and its always-present first tab. */
export const FORM_NOTEBOOK_ID = '__form_notebook'
export const PAGE_SETTINGS_ID = '__page_settings'

/**
 * The default `viewType: 'form'` anatomy (docs/roadmaps/responsive-displays.md,
 * Phases 3–4): a header row — the first `widget: 'picture'` boolean field,
 * then the first plain (non-`long`) `text` field rendered big via `variant:
 * 'title'` — followed by a two-column group holding every other field
 * EXCEPT `widget: 'long'` ones, and a notebook whose first ("Settings") page
 * holds those long-text fields instead, in declaration order. Either header
 * half is omitted if the form has nothing for it (no picture field ⇒ no
 * picture; no eligible text field ⇒ no title; NEITHER ⇒ the header row
 * itself is omitted rather than rendering empty) — the notebook and its
 * Settings page always render, even with zero long fields, since the
 * Settings page is also where a record's own runtime-created pages will
 * live (a later phase). A `long` field is deliberately never title
 * candidate material — a multi-line note doesn't belong as a form's big
 * single-line heading. Synthesized fresh on every call, never written back
 * to `descriptor.layout` — an entity gets this anatomy for free the moment
 * it declares no explicit `layout`, and a module opts out simply by
 * declaring one.
 */
function synthesizeFormLayout(fields: FieldDescriptor[]): LayoutNode[] {
  const pictureField = fields.find((f) => f.type === 'boolean' && f.widget === 'picture')
  const titleField = fields.find((f) => f.type === 'text' && f.widget !== 'long')
  const longFields = fields.filter((f) => f.type === 'text' && f.widget === 'long')
  const headerNames = new Set(
    [pictureField?.name, titleField?.name].filter((name): name is string => name != null),
  )
  const longNames = new Set(longFields.map((f) => f.name))

  const headerChildren: LayoutNode[] = []
  if (pictureField) headerChildren.push({ kind: 'field', name: pictureField.name })
  if (titleField) headerChildren.push({ kind: 'field', name: titleField.name, variant: 'title' })

  const columnsChildren: LayoutFieldNode[] = fields
    .filter((f) => !headerNames.has(f.name) && !longNames.has(f.name))
    .map((f) => ({ kind: 'field', name: f.name }))

  const nodes: LayoutNode[] = []
  if (headerChildren.length > 0) {
    nodes.push({ kind: 'row', id: FORM_HEADER_ID, children: headerChildren })
  }
  nodes.push({ kind: 'group', id: FORM_COLUMNS_ID, columns: 2, children: columnsChildren })
  nodes.push({
    kind: 'notebook',
    id: FORM_NOTEBOOK_ID,
    children: [
      {
        kind: 'page',
        id: PAGE_SETTINGS_ID,
        title: 'Settings',
        children: longFields.map((f): LayoutFieldNode => ({ kind: 'field', name: f.name })),
      },
    ],
  })
  return nodes
}

/**
 * Resolve a descriptor's presentational structure: the declared `layout`,
 * validated, or — when omitted — a synthesized default. For `viewType:
 * 'form'` that default is the header/two-column anatomy above; every other
 * view type keeps the original flat, untitled group wrapping every field in
 * declaration order (unchanged — `layoutFieldOrder` for a tree/kanban/
 * calendar/dashboard view must stay pixel-identical to before this existed).
 * That fallback is what makes the layout tree fully backward-compatible: a
 * descriptor written before it existed resolves to exactly the flat order
 * renderers already produced, so nothing needs to opt in. Renderers call
 * this — never read `fields` for display order/grouping directly — so the
 * WHOLE engine has one code path to keep consistent as later phases add
 * `move`/`addNode` extension operations.
 *
 * Validates: every field-leaf name exists in `fields` (a dangling reference is
 * a registration error, not a silently dropped node), no field-leaf appears
 * twice, every declared node `id` is unique across the tree. Also validates
 * the notebook/page structural rules (docs/roadmaps/responsive-displays.md,
 * Phase 4): a `page` must be a direct child of a `notebook` (never top-level,
 * never nested in a group/row/section), a `page` must declare a `title` (it
 * doubles as the tab label — a blank tab is a registration error, not a
 * silent one), a `notebook`'s children must ALL be `page` nodes, and at most
 * one `notebook` exists anywhere in the tree (v1). Errors name the field,
 * id, or offending kind.
 */
export function normalizeLayout<T>(descriptor: ViewDescriptor<T>): LayoutNode[] {
  if (!descriptor.layout) {
    if (descriptor.viewType === 'form') return synthesizeFormLayout(descriptor.fields)
    return [
      {
        kind: 'group',
        children: descriptor.fields.map((f): LayoutFieldNode => ({ kind: 'field', name: f.name })),
      },
    ]
  }

  const fieldNames = new Set(descriptor.fields.map((f) => f.name))
  const seenFields = new Set<string>()
  const seenIds = new Set<string>()
  let notebookCount = 0

  const visit = (node: LayoutNode, parentKind: LayoutNodeKind | null): void => {
    if (node.kind === 'field') {
      if (!fieldNames.has(node.name)) {
        throw new Error(`layout: field "${node.name}" is not declared in this view's fields`)
      }
      if (seenFields.has(node.name)) {
        throw new Error(`layout: field "${node.name}" appears more than once in the layout`)
      }
      seenFields.add(node.name)
      return
    }
    if (node.id) {
      if (seenIds.has(node.id)) {
        throw new Error(`layout: node id "${node.id}" is not unique`)
      }
      seenIds.add(node.id)
    }
    const label = node.id ? `"${node.id}"` : `(no id)`
    if (node.kind === 'page') {
      if (parentKind !== 'notebook') {
        throw new Error(`layout: a "page" node ${label} must be a direct child of a "notebook" node`)
      }
      if (!node.title) {
        throw new Error(`layout: a "page" node ${label} requires a title (it is also its tab label)`)
      }
    }
    if (node.kind === 'notebook') {
      notebookCount += 1
      if (notebookCount > 1) {
        throw new Error(`layout: at most one "notebook" node is allowed per layout, found a second ${label}`)
      }
      for (const child of node.children) {
        if (child.kind !== 'page') {
          throw new Error(
            `layout: notebook ${label} may only contain "page" children, found "${child.kind}"`,
          )
        }
      }
    }
    for (const child of node.children) visit(child, node.kind)
  }
  for (const node of descriptor.layout) visit(node, null)

  return descriptor.layout
}

/**
 * Every field-leaf name in a normalized layout, in tree-walk order — the flat
 * ORDER views that don't group/row (tree columns, a hierarchy's label field)
 * still need. For the implicit (no explicit `layout`) case this is exactly
 * `fields.map(f => f.name)`; an explicit layout can reorder without touching
 * `fields` at all.
 */
export function layoutFieldOrder(layout: LayoutNode[]): string[] {
  const names: string[] = []
  const walk = (nodes: LayoutNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'field') names.push(node.name)
      else walk(node.children)
    }
  }
  walk(layout)
  return names
}

/**
 * The layout's designated "big heading" field (`variant: 'title'`), if any —
 * the same field a form's own header renders large. A host shell reuses this
 * to show a record's real name in places that only have the layout tree to
 * go on (e.g. the breadcrumb's trailing crumb, which otherwise has nothing
 * but the raw id). `null` when no field carries the variant.
 */
export function titleFieldName(layout: LayoutNode[]): string | null {
  for (const node of layout) {
    if (node.kind === 'field') {
      if (node.variant === 'title') return node.name
      continue
    }
    const found = titleFieldName(node.children)
    if (found) return found
  }
  return null
}

/**
 * The form actions menu (docs/adr/ADR-011): every `viewType: 'form'` route
 * renders one options button, by default, at the top of the form — the same
 * "structural chrome the engine always provides" posture CreateBar takes for
 * tree views. Its content is this tree, declared on `ViewDescriptor.actions`:
 * a flat list of leaves (`kind: 'action'`) and/or nested groups
 * (`kind: 'submenu'`), a submenu's own children being more of either. Stays
 * DATA, like every other descriptor piece — an action names its handler by
 * NAME (`action: 'sale.printInvoice'`), never a function reference (the RSC
 * boundary rule `compute`/`on_change` already follow — see menu-actions.ts's
 * `registerMenuAction`). An empty/omitted `actions` still renders the
 * button — the engine has no way to know in advance a module will never add
 * one — just disabled, so there's nothing dead to click.
 */
export interface MenuActionNode {
  kind: 'action'
  label: string
  /** A name registered via `registerMenuAction` for this SAME descriptor's
   * entity — validated at registration (validateMenuActions), not at click. */
  action: string
}

export interface MenuSubmenuNode {
  kind: 'submenu'
  label: string
  children: MenuNode[]
}

export type MenuNode = MenuActionNode | MenuSubmenuNode

/**
 * `viewType: 'catalog'`'s presentation: an icon/title/subtitle list, one row
 * per record (docs/roadmaps/app-store.md, Phase 2 — the App Store's own
 * module listing is its first user, but the type is generic: any future
 * "directory of things" reuses it). Values are field NAMES, resolved against
 * `ViewDescriptor.fields` at registration (validateCatalogDescriptor) exactly
 * like a layout leaf — a typo'd name fails the build, not the render.
 */
export interface CatalogDescriptor {
  /** Renders as-is if the record's value is a non-empty string (an emoji works
   * well); falls back to the title's first letter otherwise. */
  icon?: string
  title: string
  subtitle?: string
}

/**
 * The search bar's structured-filter operators (docs/adr/ADR-014-search-filter-bar.md).
 * Maps 1:1 to the generic list endpoint's query params: eq/contains -> the
 * existing filter[col]/search[col]; in -> in[col] (comma-joined); the
 * ranges -> gt[col]/gte[col]/lt[col]/lte[col]. A "between" is just a gte
 * condition and an lte condition on the same field — no separate operator.
 */
export type FilterOperator = 'eq' | 'contains' | 'in' | 'gt' | 'gte' | 'lt' | 'lte'

/** One structured filter row in the search bar's Filters section. */
export interface FilterCondition {
  field: string
  op: FilterOperator
  /** eq/contains/gt/gte/lt/lte. */
  value?: string
  /** in only. */
  values?: string[]
}

/** One entry in `SearchDescriptor.liveFields` — the search bar's typed-text
 * autocomplete leg, in priority order. */
export interface SearchFieldConfig {
  field: string
  /** Lower searches first. Omitted ⇒ declaration order among liveFields, or
   * the engine default (name, then id, then other text/relation fields). */
  priority?: number
}

/**
 * `viewType: 'tree'`'s built-in search bar (docs/adr/ADR-014-search-filter-bar.md)
 * — every tree view gets the bar automatically; this only customizes it.
 * Values are field NAMES, resolved against `ViewDescriptor.fields` at
 * registration (validateSearchDescriptor), the same "dangling reference is a
 * build error" discipline `catalog`/layout leaves already follow. A module
 * overriding another module's search bar patches this whole block via a
 * `setDescriptor` view extension (registry/extensions.ts) — there is no
 * separate inheritance mechanism.
 */
export interface SearchDescriptor {
  /** Omitted ⇒ engine default: name, then id, then every other text/relation field. */
  liveFields?: SearchFieldConfig[]
  /** Omitted ⇒ every field is filterable (still per-caller group-gated). */
  filterableFields?: string[]
  /** Omitted ⇒ every selection/relation/boolean field is groupable. */
  groupableFields?: string[]
}

/**
 * `viewType: 'form'`'s built-in read-only status breadcrumb — names a
 * declared `type: 'selection'` field as the status source; the breadcrumb's
 * own steps are that field's `selection.options`, in declaration order (no
 * separately-declared step list — the field already owns that order, the
 * same "don't re-declare what a field already states" spirit
 * `viewModeDefaults.kanbanStatusField` follows for Kanban's columns). The
 * current step is the field's live value; earlier options read as done,
 * later ones as upcoming. Purely a DISPLAY of the field's value — never
 * interactive, never a second way to edit it — validated at registration
 * (validateStatusBarDescriptor): the named field must exist and be
 * `type: 'selection'`.
 */
export interface StatusBarDescriptor {
  field: string
}

/**
 * One button in `ViewDescriptor.headerButtons` (the header-button-container —
 * see `header-button-actions.ts`'s `registerHeaderButtonAction`): a REAL,
 * always-visible button (not a menu item behind a click) for a workflow
 * action that mutates the record's own state or side effects, rendered in
 * the form's top toolbar immediately right of the options menu (FormActionsMenu)
 * — e.g. sale's Quote form Confirm/Send/Accept/Decline buttons. Several
 * entries with different `states.visible` conditions is how a SINGLE visual
 * slot appears to "change label" across a workflow (Confirm while draft, Send
 * once confirmed, Accept once sent) — only one is ever visible at a time for
 * a given condition set, same "declarative, not a function" discipline
 * `FieldDescriptor.states` already uses.
 */
export interface HeaderButtonDescriptor {
  /** A name registered via `registerHeaderButtonAction` for this SAME
   * descriptor's entity — validated at registration, not at click (mirrors
   * MenuActionNode.action). */
  name: string
  label: string
  /** MUI Button variant mapping: 'primary' (contained, the default) or
   * 'secondary' (outlined) — e.g. a destructive/negative action like Decline. */
  variant?: 'primary' | 'secondary'
  /** Shown only while the condition holds against the CURRENT DRAFT, reevaluated
   * live exactly like `FieldDescriptor.states.visible` — e.g. `{ field: 'status',
   * op: 'eq', value: 'draft' }`. Omitted ⇒ always shown (while the record exists). */
  states?: { visible?: Condition }
}

export interface ViewDescriptor<T = Record<string, unknown>> {
  /** Maps straight to the Go route group, e.g. 'crm' -> GET /crm/. */
  entity: string
  viewType: ViewType
  fields: FieldDescriptor[]
  /** Required when viewType is 'catalog' (validateCatalogDescriptor enforces
   * it); meaningless otherwise. */
  catalog?: CatalogDescriptor
  /**
   * Presentational structure over `fields`: a tree of groups/rows/sections
   * containing field leaves, addressed by field NAME or an explicit node `id`
   * — the anchor a view EXTENSION targets (docs/roadmaps/view-customization.md).
   * Omitted ⇒ `normalizeLayout` synthesizes one implicit group wrapping every
   * field in declaration order — full backward compatibility, every descriptor
   * written before the layout tree existed renders unchanged. Renderers never
   * read `fields` directly for display order/grouping; `normalizeLayout` is
   * the single entry point.
   */
  layout?: LayoutNode[]
  /** Permissions required to view (server authorizes; client gates UI). */
  permissions?: string[]
  /**
   * For list ('tree') and dashboard views: the form route for one record, as a
   * path template whose ':id' is replaced by the clicked row's id (e.g.
   * '/crm/:id'). Set it to make list rows clickable; with createPermission it
   * also powers the Create button (':id' → 'new'). Omit for read-only views.
   */
  formPath?: string
  /**
   * Permission required to CREATE records (e.g. 'crm:contacts:write'). When both
   * this and formPath are set, tree/dashboard views show a Create button opening
   * an empty form — only for sessions whose role-derived permissions grant it.
   * Default-closed: no createPermission, no button. Display gating only — Go
   * re-authorizes the POST regardless.
   */
  createPermission?: string
  /**
   * The form actions menu's content (see MenuNode). Meaningful on
   * `viewType: 'form'` only — FormActionsMenu is the one renderer that reads
   * it; other view types render no options button, so a value here is
   * harmless-but-inert on them, same posture `createPermission` takes on a
   * form. Omitted ⇒ the button still renders (disabled) — see MenuNode's doc.
   */
  actions?: MenuNode[]
  /**
   * For `viewType: 'tree'` only: a module's own hardcoded baseline for its
   * Kanban status field / Calendar date field / Graph mode availability
   * (docs/adr/ADR-006-runtime-configurable-view-fields.md's amendment) — the
   * value Settings -> Views shows before any admin override, and what a
   * "revert to module settings" action there restores. Omitted (the common
   * case) means the module declared no opinion; every mode stays unavailable
   * until an admin configures it from Settings, unchanged from before this
   * existed. Merged with the admin's own override via `effectiveViewFields`
   * (api/view-fields.ts) — never read directly by a renderer.
   */
  viewModeDefaults?: ViewModeDefaults
  /**
   * For `viewType: 'tree'` only: customizes the built-in search bar every
   * list view renders automatically (docs/adr/ADR-014-search-filter-bar.md)
   * — omitted means the engine default (see SearchDescriptor's own fields).
   */
  search?: SearchDescriptor
  /**
   * For `viewType: 'form'` only: the built-in read-only status breadcrumb
   * (see StatusBarDescriptor). Omitted ⇒ no breadcrumb renders — opt-in,
   * unlike Save/Reset/the options menu, since not every form has a
   * meaningful status field.
   */
  statusBar?: StatusBarDescriptor
  /**
   * For `viewType: 'form'` only: the header-button-container (see
   * HeaderButtonDescriptor) — real workflow buttons in the top toolbar, right
   * of the options menu. Omitted ⇒ nothing renders there, unlike Save/Reset/
   * the options menu, since not every form has a workflow beyond plain edits.
   */
  headerButtons?: HeaderButtonDescriptor[]
  /** Phantom marker so T flows through to the derived store/renderer. */
  readonly __record?: T
}
