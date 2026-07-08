// View descriptors — the metadata a module contributes. A module ships DESCRIPTORS
// ONLY; the engine derives the server loader, the Zustand store, and the renderer
// from them (CONVENTIONS.md — Module FE contract). Adding an entity is a descriptor;
// adding a view type is one store factory + one renderer + one loader path.

export type ViewType = 'form' | 'tree' | 'dashboard'

export type FieldType = 'text' | 'number' | 'date' | 'relation' | 'boolean'

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
 * matrix.
 */
export const FIELD_WIDGETS: Record<FieldType, readonly string[]> = {
  text: ['simple', 'long', 'phone'],
  number: ['float', 'int', 'percent', 'stars', 'phone'],
  boolean: ['switch', 'picture', 'signature'],
  date: ['simple'],
  relation: ['search', 'tags', 'list'],
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

/** Validate every field's widget/type pair of a descriptor (see resolveWidget). */
export function validateDescriptorWidgets<T>(descriptor: ViewDescriptor<T>): void {
  for (const field of descriptor.fields) resolveWidget(field)
}

/**
 * The zero default a field seeds with when the record lacks it and the
 * descriptor declares no `default`: the natural empty value of each data type.
 * Relations default null on the m2o FK ("no target"); virtual relations
 * (o2m/m2m) never seed — they have no column on this record.
 */
export function fieldZeroDefault(field: FieldDescriptor): JsonValue {
  switch (field.type) {
    case 'text':
      return ''
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'date':
    case 'relation':
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

export interface ViewDescriptor<T = Record<string, unknown>> {
  /** Maps straight to the Go route group, e.g. 'crm' -> GET /crm/. */
  entity: string
  viewType: ViewType
  fields: FieldDescriptor[]
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
  /** Phantom marker so T flows through to the derived store/renderer. */
  readonly __record?: T
}
