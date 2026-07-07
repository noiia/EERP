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
 * boolean picture/signature (Phase 3) and relation tags/list (Phase 4) will
 * extend this matrix.
 */
export const FIELD_WIDGETS: Record<FieldType, readonly string[]> = {
  text: ['simple', 'long', 'phone'],
  number: ['float', 'int', 'percent', 'stars', 'phone'],
  boolean: ['switch'],
  date: ['simple'],
  relation: ['search'],
}

export interface FieldDescriptor {
  /** Property name on the record and the form draft. */
  name: string
  /** Human label shown by the renderer. */
  label: string
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
   * Name of a registered field function (registerFieldFunction) computing this
   * field's value from the draft. A NAME, never a function — descriptors cross
   * the RSC boundary. Computed fields render read-only and recompute whenever a
   * field in the function's `depends` list changes.
   */
  compute?: string
  /**
   * Whether the value persists to the DB column on commit. Default true.
   * `store: false` = display-only (typically with `compute`): stripped from the
   * commit payload and expected absent in server data.
   */
  store?: boolean
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
  const widget = field.widget ?? allowed[0]
  if (!allowed.includes(widget)) {
    throw new Error(
      `field "${field.name}": widget "${widget}" is not allowed for type "${field.type}" ` +
        `(allowed: ${allowed.join(', ')})`,
    )
  }
  return widget
}

/** Validate every field's widget/type pair of a descriptor (see resolveWidget). */
export function validateDescriptorWidgets<T>(descriptor: ViewDescriptor<T>): void {
  for (const field of descriptor.fields) resolveWidget(field)
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
