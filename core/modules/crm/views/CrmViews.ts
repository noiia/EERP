import {
  FORM_NOTEBOOK_ID,
  registerFieldFunction,
  registerOnChange,
  type DraftRecord,
  type FrontModule,
  type Operation,
  type ViewDescriptor,
} from '@eerp/core-front'

// CRM frontend — DESCRIPTORS ONLY. The engine derives the server loader, the Zustand
// store, and the renderer from these; this module ships no controllers or renderers.
// A custom component here would signal an engine gap to fix in @eerp/core-front.

/** The CRM record as served by Go's /crm endpoints (BaseModel + business fields). */
export interface Crm {
  id: string
  name: string
  email: string
  company?: string
  /** One of the selection field's options: incoming/running/won/lost/closed. */
  status?: string
  contact_id?: string | null
  /** E.164 in a TEXT column (numeric columns lose the leading + / zeros). */
  phone?: string
  notes?: string
  /** 0..1 ratio; the percent widget displays it ×100. */
  satisfaction?: number | null
  deals?: number | null
  /** User-set stars; re-suggested on status change (crm.scoreFromStatus), indexed column. */
  score?: number | null
  /** true ⇔ a picture exists on this record's picture anchor (picture service). */
  picture?: boolean | null
  /** Same contract as picture, on the signature anchor (canvas-drawn PNG) —
   * lives under its OWN notebook tab (see `signaturePageOperations` below),
   * not the two-column body. */
  signature?: boolean | null
}

// ── Behavior layer showcase (compute / depends / on_change / store) ───────────
// Descriptors stay DATA — they cross the RSC boundary, so a field references
// its function by NAME (`compute: 'crm.score'`) and the code registers here,
// at import time, into the engine's client-side behavior registry.

/**
 * How each status scores; the suggestion's whole business logic. `incoming`
 * and `running` climb toward a `won` deal; `lost` and `closed` are terminal
 * without a positive outcome, so both score 0 — a closure with no explicit
 * win is not a 3-star deal by default.
 */
const STATUS_SCORE: Record<string, number> = {
  incoming: 1,
  running: 2,
  won: 3,
  lost: 0,
  closed: 0,
}

// on_change (NOT compute — that's the editable-vs-derived line): a compute
// would render the stars read-only; this patch only SUGGESTS a score whenever
// `status` changes, and the user remains free to click the stars to any
// half-step. Commits into the `score` column — which the Go model declares as
// `db:"score,index"`, so migration also materializes idx_crm_score (the
// struct-tag index DDL).
registerOnChange({
  entity: 'crm',
  name: 'crm.scoreFromStatus',
  onChange: ['status'],
  handler: (draft: Readonly<DraftRecord>) => ({
    score: STATUS_SCORE[String(draft.status ?? '').toLowerCase()] ?? 0,
  }),
})

// compute + store:false: display-only. Recomputed from name/company on every
// edit, but stripped from commit payloads — there is no display_name column,
// and the form tolerates its absence in server data (re-seeded after save).
registerFieldFunction({
  entity: 'crm',
  name: 'crm.displayName',
  depends: ['name', 'company'],
  handler: (draft: Readonly<DraftRecord>) => {
    const name = String(draft.name ?? '')
    const company = String(draft.company ?? '')
    return company ? `${name} (${company})` : name
  },
})

// default as a FUNCTION: the descriptor's `default` names this registration
// (same name-not-function rule as compute); called with the seed draft when a
// record lacks the field — here, new CRM records start at 50% satisfaction.
registerFieldFunction({
  entity: 'crm',
  name: 'crm.defaultSatisfaction',
  depends: [],
  handler: () => 0.5,
})

// on_change: fires when a listed field (`company`) changes; the returned patch
// merges into the draft — here, suggest an email once a company is typed,
// without ever clobbering an address the user already entered. A patched field
// would in turn recompute any compute depending on it (cycle-guarded).
registerOnChange({
  entity: 'crm',
  name: 'crm.suggestEmail',
  onChange: ['company'],
  handler: (draft: Readonly<DraftRecord>) => {
    if (draft.email) return
    const slug = String(draft.company ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
    return slug ? { email: `contact@${slug}.com` } : undefined
  },
})

const fields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'email', label: 'Email', type: 'text', required: true },
  { name: 'company', label: 'Company', type: 'text' },
  {
    // selection: a closed value list, dropdown widget. No explicit `default`
    // — the type's own rule (fieldZeroDefault) seeds the FIRST option,
    // 'incoming', for every new record; the seed pass then turns that into
    // score = 1 via crm.scoreFromStatus, before the first edit.
    name: 'status',
    label: 'Status',
    type: 'selection',
    selection: { options: ['incoming', 'running', 'won', 'lost', 'closed'] },
  },
  {
    // Editable stars (no compute — computed fields render disabled): hover
    // previews half/full steps, click sets the value. crm.scoreFromStatus
    // re-suggests it on every status change; the list's DataGrid shows the
    // same value straight from the column.
    name: 'score',
    label: 'Score',
    type: 'number',
    widget: 'stars',
    widgetOptions: { max: 3 },
  },
]

// Relation fields render on the FORM only: the list's DataGrid would show the
// raw FK / nothing for the virtual tags field. contact_id is a real column
// (many2one -> search + wizard); tags is virtual — the links are crm_tag
// junction rows the widget writes directly, never part of the crm payload.
const formFields: ViewDescriptor['fields'] = [
  {
    name: 'picture',
    label: 'Crm picture',
    type: 'boolean',
    widget: 'picture',
  },
  ...fields,
  {
    // TEXT column on purpose: E.164 keeps its leading + (the widget normalizes;
    // a numeric column would drop it — the roadmap's documented pitfall).
    name: 'phone',
    label: 'Phone',
    type: 'text',
    widget: 'phone',
  },
  {
    // Stored as a 0..1 ratio (the percent widget's default base), shown ×100
    // with the workspace separators from useNumberFormat(). The default is a
    // registered function NAME (crm.defaultSatisfaction) — new records seed 50%.
    name: 'satisfaction',
    label: 'Satisfaction',
    type: 'number',
    widget: 'percent',
    default: 'crm.defaultSatisfaction',
  },
  {
    name: 'deals',
    label: 'Deals',
    type: 'number',
    widget: 'int',
  },
  {
    // No label: exercises the fieldLabel fallback — renders as "Notes".
    name: 'notes',
    type: 'text',
    widget: 'long',
  },
  {
    // Display-only compute (see crm.displayName above): store:false keeps it
    // out of every commit payload — a pure UI projection of name + company.
    name: 'display_name',
    label: 'Display name',
    type: 'text',
    compute: 'crm.displayName',
    store: false,
  },
  {
    name: 'contact_id',
    label: 'Contact',
    type: 'relation',
    relation: { entity: 'contact', kind: 'many2one', labelField: 'name' },
  },
  {
    name: 'tags',
    label: 'Tags',
    type: 'relation',
    relation: { entity: 'tag', kind: 'many2many', via: 'crm_tag', labelField: 'name' },
  },
]

const dashboardView: ViewDescriptor = {
  entity: 'crm',
  viewType: 'dashboard',
  fields,
  permissions: ['crm:contacts:read'],
}

const listView: ViewDescriptor = {
  entity: 'crm',
  viewType: 'tree',
  fields,
  // Clicking a row opens that contact's form; Create opens it empty (writers only).
  formPath: '/crm/:id',
  createPermission: 'crm:contacts:write',
  permissions: ['crm:contacts:read'],
}

const formView: ViewDescriptor = {
  entity: 'crm',
  viewType: 'form',
  fields: formFields,
  permissions: ['crm:contacts:read'],
}

// A notebook page coded directly IN this module, as opposed to
// crminheritdemo's cross-module example or Phase 5's runtime, user-created
// pages: `signature` is a real column (model.go) — its own dedicated tab,
// not the two-column body, but still committed the ordinary way, through the
// record's own PUT. It renders ONLY on the crm FORM, never on `/crm/list` or
// the `/crm` dashboard, because the extension below targets `/crm/:id` alone
// (docs/roadmaps/responsive-displays.md, Phase 4). A page's fields still
// have to exist in `fields[]` first — `addField` with no target lands it in
// `__form_columns` (the default anatomy's normal body) — then `addNode`
// EXTRACTS it from there into the new page, so it ends up living in exactly
// one place, never duplicated (see `AddNodeOp`'s own doc comment in
// `registry/extensions.ts`).
const signaturePageOperations: Operation[] = [
  {
    op: 'addField',
    field: {
      // Same service contract as picture, drawn instead of uploaded: any
      // stroke flips the flag true, "done" exports the canvas PNG onto the
      // signature anchor, reset deletes the picture and commits false.
      name: 'signature',
      label: 'Signed',
      type: 'boolean',
      widget: 'signature',
    },
  },
  {
    op: 'addNode',
    node: {
      kind: 'page',
      title: 'Signature',
      children: [{ kind: 'field', name: 'signature' }],
    },
    target: FORM_NOTEBOOK_ID,
    position: 'last',
  },
]

const crm: FrontModule = {
  name: 'crm',
  routes: [
    { path: '/crm', descriptor: dashboardView, permission: 'crm:contacts:read' },
    { path: '/crm/list', descriptor: listView, permission: 'crm:contacts:read' },
    { path: '/crm/:id', descriptor: formView, permission: 'crm:contacts:read' },
  ],
  // A module may extend its OWN already-registered route, not just another
  // module's — ModuleRegistry.register() applies `extends` right after this
  // SAME call's `routes`, so the target already exists (registry.ts skips
  // the depends-coverage warning for self-targeting, too).
  extends: [{ path: '/crm/:id', operations: signaturePageOperations }],
}

export default crm
