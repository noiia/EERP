// View descriptors — the metadata a module contributes. A module ships DESCRIPTORS
// ONLY; the engine derives the server loader, the Zustand store, and the renderer
// from them (CONVENTIONS.md — Module FE contract). Adding an entity is a descriptor;
// adding a view type is one store factory + one renderer + one loader path.

export type ViewType = 'form' | 'tree' | 'dashboard'

export type FieldType = 'text' | 'number' | 'date' | 'relation' | 'boolean'

export interface FieldDescriptor {
  /** Property name on the record and the form draft. */
  name: string
  /** Human label shown by the renderer. */
  label: string
  type: FieldType
  required?: boolean
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
