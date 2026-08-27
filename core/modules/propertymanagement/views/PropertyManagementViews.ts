 import {
  createAttachmentClient,
  fetchReportPDF,
  FORM_COLUMNS_ID,
  FORM_NOTEBOOK_ID,
  registerFieldFunction,
  registerHeaderButtonAction,
  reportPartyAddressFields,
  useEntityRefreshStore,
  type DraftRecord,
  type FrontModule,
  type HeaderButtonDescriptor,
  type Operation,
  type ReportDescriptor,
  type ViewDescriptor,
} from '@eerp/core-front'

// Property management frontend — DESCRIPTORS ONLY (same discipline as
// core/modules/crm's CrmViews.ts). Seven entities, one module — see
// core/modules/propertymanagement/module.go's doc comments for the full
// data model. Every `entity` name is the Go route prefix from module.go's
// orm.Register calls, not the module slug 'propertymanagement'.

/** The Property record as served by Go's /property_management endpoints. */
export interface PropertyManagement {
  id: string
  name: string
  address_number?: number | null
  address_complement?: string
  address_street?: string
  address_zip_code?: string
  address_city?: string
  address_state?: string
  address_country?: string
  floor_area?: number
  /** "2026-08"-shaped, null until the first Generate — set by the Generate
   * Rent Receipt header button. */
  last_receipt_month?: string | null
  /** Server-computed, non-stored (GetProperty override, handler.go) — never
   * a real column, never sent back on write. */
  receipt_generated_this_month?: boolean
}

/** One property_management_equipment row. */
export interface PropertyManagementEquipment {
  id: string
  property_management_id: string
  name: string
  quantity?: number
  /** Rollup of the latest property_management_equipment_status entry (handler.go). */
  current_state?: string
  billing_of_buy?: boolean
  buying_price?: number
  buying_date?: string | null
}

/** One property_management_equipment_status row — a dated entry in the
 * equipment's damage-state history log (the user's own confirmed choice). */
export interface PropertyManagementEquipmentStatus {
  id: string
  property_management_equipment_id: string
  date?: string | null
  /** good / damaged / under_repair / out_of_service — see module.go. */
  state: string
}

/** One property_management_equipment_photo row — mirrors PropertyManagementPhoto. */
export interface PropertyManagementEquipmentPhoto {
  id: string
  property_management_equipment_id: string
  position: number
}

/**
 * One property_management_rent_receipt row — append-only, see module.go.
 * A PARENT row (one per property+period) has property_management_id set and
 * parent_id null; a CHILD row (one per tenant, module.go's "parent/child"
 * doc comment) has parent_id set instead and no property_management_id.
 */
export interface PropertyManagementRentReceipt {
  id: string
  property_management_id?: string | null
  parent_id?: string | null
  /** true on a parent row, false on a child — see module.go's doc comment;
   * exists so the flat cross-property list can filter to parents (no "IS
   * NULL" filter exists to scope by parent_id alone). */
  is_parent?: boolean
  period: string
  generated_at?: string | null
  property_name?: string
  /** Full formatted line (number/street, complement, zip/city, country) —
   * see formatPropertyAddress below. */
  property_address?: string
  floor_area?: number
  /** The full comma-joined list on a parent row; a single tenant's name on a child row. */
  tenant_names?: string
  receipt_file?: boolean
}

/**
 * The property's full postal address as one printable line — "12 Main
 * Street, Apt 4B, 75001 Paris, France" — from the type: 'address' composite
 * field's 7 sibling draft columns (core-front/CLAUDE.md's AddressWidget).
 * Was just `[address_number, address_street].join(' ')`, silently dropping
 * complement/zip code/city/state/country — the reason a generated receipt's
 * report read "barely empty".
 */
function formatPropertyAddress(draft: Record<string, unknown>): string {
  const line = (...parts: unknown[]) =>
    parts
      .filter((part) => part != null && part !== '')
      .map(String)
      .join(' ')
  return [
    line(draft.address_number, draft.address_street),
    line(draft.address_complement),
    line(draft.address_zip_code, draft.address_city),
    line(draft.address_state),
    line(draft.address_country),
  ]
    .filter((part) => part !== '')
    .join(', ')
}

// Generate Rent Receipt: creates one PARENT row for this property+period
// (the summary the property form's own rent_receipts field lists — see
// module.go's doc comment on PropertyManagementRentReceipt) plus one
// dedicated CHILD row per CURRENT tenant, each rendered to its OWN PDF via
// the propertymanagement.rentReceipt report below and re-uploaded as that
// child's fixed snapshot (never re-rendered on a later download — the
// user's own explicit requirement) — a tenant moving out/in later never
// changes what an already-generated receipt shows. Mirrors
// modules/sale/views/SaleViews.ts's sale.acceptQuote shape (read via
// relationOps, create, then setFieldAndCommit).
registerHeaderButtonAction({
  entity: 'property_management',
  name: 'propertymanagement.generateRentReceipt',
  handler: async (ctx) => {
    const ops = ctx.relationOps
    if (!ops) return

    const period = new Date().toISOString().slice(0, 7)
    const generatedAt = new Date().toISOString()
    const addressLine = formatPropertyAddress(ctx.draft)

    const links = await ops.list('property_management_tenant', {
      filter: { property_management_id: ctx.recordId },
      pageSize: 100,
    })
    const tenants = await Promise.all(
      links.map((link) =>
        typeof link.contact_id === 'string' ? ops.get('contact', link.contact_id).catch(() => null) : null,
      ),
    )
    const tenantNames = tenants
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .map((c) => String(c.name ?? ''))

    const parent = await ops.create('property_management_rent_receipt', {
      property_management_id: ctx.recordId,
      is_parent: true,
      period,
      generated_at: generatedAt,
      property_name: ctx.draft.name,
      property_address: addressLine,
      floor_area: ctx.draft.floor_area,
      tenant_names: tenantNames.join(', '),
      // receipt_file is a plain NOT NULL bool column (module.go) — must be
      // present on Create even though BooleanFileWidget/CarouselSlide never
      // trust the stored flag anyway (they re-derive "does a file exist"
      // live via the attachment service). The parent never gets a PDF.
      receipt_file: false,
    })

    // One dedicated child per tenant — independent creates/uploads, so one
    // tenant's failure (e.g. a mid-batch attachments hiccup) never blocks
    // the others.
    for (const name of tenantNames) {
      const child = await ops.create('property_management_rent_receipt', {
        parent_id: parent.id,
        is_parent: false,
        period,
        generated_at: generatedAt,
        property_name: ctx.draft.name,
        property_address: addressLine,
        floor_area: ctx.draft.floor_area,
        tenant_names: name,
        receipt_file: false,
      })

      // Best-effort: the receipt row is the workflow's real state — a PDF
      // failure (e.g. attachments' S3 store not configured in this
      // deployment, internal/attachments' own degrade posture) must not
      // block the other tenants' receipts or leave the property stuck
      // unable to re-attempt this month.
      try {
        const pdf = await fetchReportPDF('propertymanagement.rentReceipt', child.id)
        await createAttachmentClient().upload(
          { table: 'property_management_rent_receipt', recordId: child.id, field: 'receipt_file' },
          pdf,
          `rent-receipt-${period}-${name}.pdf`,
        )
      } catch {
        // Swallowed — see the comment above.
      }
    }

    // The property form's own rent_receipts RelationListWidget (and the
    // parent's own children widget, once open) have no way to know these
    // rows exist (created via relationOps, not their own create wizard) —
    // bump once so any mounted widget over this entity re-fetches.
    useEntityRefreshStore.getState().bump('property_management_rent_receipt')

    await ctx.setFieldAndCommit({ last_receipt_month: period })
  },
})

const propertyHeaderButtons: HeaderButtonDescriptor[] = [
  {
    name: 'propertymanagement.generateRentReceipt',
    label: 'Generate Rent Receipt',
    // Stays VISIBLE but DISABLED once already run this month — a server-
    // computed key (see PropertyManagement.receipt_generated_this_month
    // above), never a stored column, so this Condition needs no dynamic
    // "now" operator.
    states: { readOnly: { field: 'receipt_generated_this_month', op: 'eq', value: true } },
  },
]

const fields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'address', label: 'Address', type: 'address', widget: 'form' },
  { name: 'floor_area', label: 'Floor area', type: 'number', widget: 'float' },
]

// Form-only: current_tenant (many2many, tags widget) stays in the default
// two-column body — compact, unlike the three bulkier one2many tables below,
// which propertyNotebookOperations moves into their own notebook pages.
// widgetOptions.deferred (the user's own explicit choice): a tenant change
// stages in the draft and marks the form dirty — Save is what actually
// writes the property_management_tenant junction rows — rather than every
// other many2many field's default "junction row written the instant you
// click," so an accidental tenant edit stays discardable via Reset like any
// other field, and "did I save?" has one answer: the Save button's own
// dirty state.
const formFields: ViewDescriptor['fields'] = [
  ...fields,
  {
    name: 'current_tenant',
    label: 'Current tenant(s)',
    type: 'relation',
    relation: {
      entity: 'contact',
      kind: 'many2many',
      via: 'property_management_tenant',
      viaFields: { own: 'property_management_id', related: 'contact_id' },
      labelField: 'name',
    },
    widgetOptions: { deferred: true },
  },
  {
    name: 'photos',
    label: 'Photos',
    type: 'relation',
    widget: 'carousel',
    widgetOptions: { max: 20 },
    relation: { entity: 'property_management_photo', kind: 'one2many', inverseField: 'property_management_id' },
  },
  {
    name: 'equipment',
    label: 'Equipment',
    type: 'relation',
    relation: {
      entity: 'property_management_equipment',
      kind: 'one2many',
      inverseField: 'property_management_id',
      labelField: 'name',
      formPath: '/propertymanagement/equipment/:id',
    },
  },
  {
    name: 'rent_receipts',
    label: 'Rent receipts',
    type: 'relation',
    readOnly: true,
    relation: {
      entity: 'property_management_rent_receipt',
      kind: 'one2many',
      inverseField: 'property_management_id',
      labelField: 'period',
      formPath: '/propertymanagement/receipts/:id',
    },
  },
]

const dashboardView: ViewDescriptor = {
  entity: 'property_management',
  viewType: 'dashboard',
  fields,
  permissions: ['property_management:property_management:read'],
}

const listView: ViewDescriptor = {
  entity: 'property_management',
  viewType: 'tree',
  fields,
  formPath: '/propertymanagement/:id',
  createPermission: 'property_management:property_management:write',
  permissions: ['property_management:property_management:read'],
}

const formView: ViewDescriptor = {
  entity: 'property_management',
  viewType: 'form',
  fields: formFields,
  permissions: ['property_management:property_management:read'],
  headerButtons: propertyHeaderButtons,
}

// Moves photos/equipment/rent_receipts off the default two-column body into
// their own notebook pages — same self-extension shape
// core/modules/sale/views/SaleViews.ts's orderLinesPageOperations uses.
const propertyNotebookOperations: Operation[] = [
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Photos', children: [{ kind: 'field', name: 'photos' }] },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Equipment', children: [{ kind: 'field', name: 'equipment' }] },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Rent receipt', children: [{ kind: 'field', name: 'rent_receipts' }] },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
]

// Age is a LIVE compute (registerFieldFunction, store:false — see crm's
// crm.displayName for the same shape), not a `default`: it must stay current
// as buying_date changes, not just seed once. Years once >= 1, otherwise
// months — "3 years old" reads better than "38 months old".
const MS_PER_DAY = 24 * 60 * 60 * 1000

function ageLabel(boughtAt: Date): string {
  const days = (Date.now() - boughtAt.getTime()) / MS_PER_DAY
  if (days < 0) return ''
  const years = Math.floor(days / 365.25)
  if (years >= 1) return `${years} year${years === 1 ? '' : 's'} old`
  const months = Math.floor(days / 30.44)
  return `${months} month${months === 1 ? '' : 's'} old`
}

registerFieldFunction({
  entity: 'property_management_equipment',
  name: 'propertymanagement.equipmentAge',
  depends: ['buying_date'],
  handler: (draft: Readonly<DraftRecord>) => {
    const raw = draft.buying_date
    if (typeof raw !== 'string' || raw === '') return ''
    const boughtAt = new Date(raw)
    return Number.isNaN(boughtAt.getTime()) ? '' : ageLabel(boughtAt)
  },
})

const equipmentFields: ViewDescriptor['fields'] = [
  { name: 'global_picture', label: 'Picture', hideLabel: true, type: 'boolean', widget: 'picture' },
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'quantity', label: 'Quantity', type: 'number', widget: 'int' },
  // Rollup of the latest damage-state entry (handler.go's rollupCurrentState) — display only.
  { name: 'current_state', label: 'Current state', type: 'text', readOnly: true },
  { name: 'billing_of_buy', label: 'Billing of buy', type: 'boolean', widget: 'file' },
  { name: 'buying_price', label: 'Buying price', type: 'number', widget: 'monetary' },
  { name: 'buying_date', label: 'Buying date', type: 'date' },
  { name: 'buying_age', label: 'Age', type: 'text', compute: 'propertymanagement.equipmentAge', store: false },
  {
    // The one owning property (exactly one — the user's own confirmed
    // choice). widget: 'summary' (opt-in over the stock many2one 'search'
    // picker) renders a READ-ONLY recap instead — "Equipped in" shows which
    // property + its tenants, rather than an FK the user would edit here;
    // required: true still lets the create-wizard preset+hide it exactly
    // like sale_line's invoice_id/quote_line's quote_id do.
    name: 'property_management_id',
    label: 'Equipped in',
    type: 'relation',
    required: true,
    widget: 'summary',
    widgetOptions: {
      fields: ['name', 'address_city'],
      relatedRelationField: 'current_tenant',
      relatedRelationLabel: 'Tenant',
    },
    relation: { entity: 'property_management', kind: 'many2one', labelField: 'name' },
  },
  {
    name: 'statuses',
    label: 'Damage state history',
    type: 'relation',
    relation: {
      entity: 'property_management_equipment_status',
      kind: 'one2many',
      inverseField: 'property_management_equipment_id',
      labelField: 'state',
      formPath: '/propertymanagement/equipment/statuses/:id',
    },
  },
  {
    name: 'photos',
    label: 'Photos',
    type: 'relation',
    widget: 'carousel',
    widgetOptions: { max: 10 },
    relation: {
      entity: 'property_management_equipment_photo',
      kind: 'one2many',
      inverseField: 'property_management_equipment_id',
    },
  },
]

const equipmentFormView: ViewDescriptor = {
  entity: 'property_management_equipment',
  viewType: 'form',
  fields: equipmentFields,
  permissions: ['property_management_equipment:property_management_equipment:read'],
}

// buying_date + buying_age as one row in the two-column body, Equipped in /
// Damage state history / Photos as their own notebook pages — same
// self-extension shape as propertyNotebookOperations above.
const equipmentNotebookOperations: Operation[] = [
  {
    op: 'addNode',
    node: { kind: 'row', children: [{ kind: 'field', name: 'buying_date' }, { kind: 'field', name: 'buying_age' }] },
    target: FORM_COLUMNS_ID,
    position: 'last',
  },
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Photos', children: [{ kind: 'field', name: 'photos' }] },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Damage state history', children: [{ kind: 'field', name: 'statuses' }] },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Equipped in', children: [{ kind: 'field', name: 'property_management_id' }] },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
]

// property_management_equipment_status's own descriptor — needed for the
// equipment form's "Damage state history" one2many create-wizard, same
// reasoning as quote_line's own descriptor in SaleViews.ts.
const equipmentStatusFields: ViewDescriptor['fields'] = [
  {
    name: 'property_management_equipment_id',
    label: 'Equipment',
    type: 'relation',
    required: true,
    relation: { entity: 'property_management_equipment', kind: 'many2one', labelField: 'name' },
  },
  { name: 'date', label: 'Date', type: 'date', required: true },
  {
    name: 'state',
    label: 'State',
    type: 'selection',
    selection: { options: ['good', 'damaged', 'under_repair', 'out_of_service'] },
  },
]

const equipmentStatusFormView: ViewDescriptor = {
  entity: 'property_management_equipment_status',
  viewType: 'form',
  fields: equipmentStatusFields,
  permissions: ['property_management_equipment_status:property_management_equipment_status:read'],
}

// property_management_rent_receipt's own read-only descriptor — needed so
// the Rent receipt notebook page's formPath has somewhere to navigate: a
// generated receipt's snapshot fields + its saved PDF (boolean/file,
// readOnly — a receipt is append-only server-side too, see module.go).
const rentReceiptFields: ViewDescriptor['fields'] = [
  { name: 'period', label: 'Period', type: 'text', readOnly: true },
  { name: 'generated_at', label: 'Generated at', type: 'text', readOnly: true },
  { name: 'property_name', label: 'Property', type: 'text', readOnly: true },
  { name: 'property_address', label: 'Address', type: 'text', readOnly: true },
  { name: 'floor_area', label: 'Floor area', type: 'number', widget: 'float', readOnly: true },
  { name: 'tenant_names', label: 'Tenant(s)', type: 'text', readOnly: true },
  { name: 'receipt_file', label: 'Receipt PDF', type: 'boolean', widget: 'file', readOnly: true },
]

// Form-only, NOT part of rentReceiptFields (which the cross-property
// rentReceiptListView's DataGrid columns also read — a one2many relation
// field has no sensible DataGrid column rendering): on a PARENT row's own
// form, embeds the per-tenant CHILD rows this generation produced
// (module.go's doc comment on PropertyManagementRentReceipt). On a CHILD
// row's own form this is simply empty — a child has no children of its own.
const rentReceiptFormFields: ViewDescriptor['fields'] = [
  ...rentReceiptFields,
  {
    name: 'children',
    label: 'Tenant receipts',
    type: 'relation',
    readOnly: true,
    relation: {
      entity: 'property_management_rent_receipt',
      kind: 'one2many',
      inverseField: 'parent_id',
      labelField: 'tenant_names',
      formPath: '/propertymanagement/receipts/:id',
    },
  },
]

// Regenerate PDF: covers the best-effort upload in propertymanagement.
// generateRentReceipt failing (e.g. attachments' S3 store unavailable at
// generation time) — re-renders the SAME snapshot fields already on this
// receipt row (never re-reads the property/tenants, per module.go's "capture
// at document time" discipline) and re-uploads onto the same receipt_file
// anchor. Visible only while the boolean/file widget's own live check
// (file-widgets.tsx's useAttachmentState) has resolved no attachment there.
registerHeaderButtonAction({
  entity: 'property_management_rent_receipt',
  name: 'propertymanagement.regenerateReceiptPdf',
  handler: async (ctx) => {
    const pdf = await fetchReportPDF('propertymanagement.rentReceipt', ctx.recordId)
    await createAttachmentClient().upload(
      { table: 'property_management_rent_receipt', recordId: ctx.recordId, field: 'receipt_file' },
      pdf,
      `rent-receipt-${String(ctx.draft.period ?? '')}.pdf`,
    )
    // This upload bypasses BooleanFileWidget's own upload flow, so its
    // useAttachmentState effect never re-resolves the anchor on its own —
    // without this the button stays visible (its states.visible watches
    // receipt_file) after a successful regenerate.
    useEntityRefreshStore.getState().bump('property_management_rent_receipt')
  },
})

const rentReceiptHeaderButtons: HeaderButtonDescriptor[] = [
  {
    name: 'propertymanagement.regenerateReceiptPdf',
    label: 'Regenerate PDF',
    // AND parent_id "set": only a CHILD row ever has its own PDF — a parent
    // is a pure summary row (module.go's doc comment), regenerating one for
    // it would have nothing meaningful to snapshot beyond the joined name list.
    states: {
      visible: {
        all: [
          { field: 'receipt_file', op: 'eq', value: false },
          { field: 'parent_id', op: 'set' },
        ],
      },
    },
  },
]

const rentReceiptFormView: ViewDescriptor = {
  entity: 'property_management_rent_receipt',
  viewType: 'form',
  fields: rentReceiptFormFields,
  permissions: ['property_management_rent_receipt:property_management_rent_receipt:read'],
  headerButtons: rentReceiptHeaderButtons,
}

// Moves the embedded "children" table off the default two-column body into
// its own notebook page — same self-extension shape propertyNotebookOperations
// (above) and equipmentNotebookOperations (below) already use for every
// other one2many field in this module.
const receiptNotebookOperations: Operation[] = [
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Tenant receipts', children: [{ kind: 'field', name: 'children' }] },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
]

// Every generated receipt, across every property — module.go's "capture at
// document time" snapshot (property_name/tenant_names) is what makes a
// single cross-property list meaningful without joining back to
// property_management. No createPermission: a receipt is append-only,
// created only by propertymanagement.generateRentReceipt (handler.go's
// RejectReceiptMutation rejects a manual PUT/DELETE too) — formPath still
// makes rows navigable to the read-only form above. listFilter scopes this
// FIXED, non-user-editable to PARENT rows only (is_parent: true) — the same
// posture the property form's own rent_receipts field already gets for free
// via property_management_id, just expressed as an exact-match filter here
// since there's no "parent_id IS NULL" filter to lean on for a route with no
// single property to key off. Each parent's own form embeds its tenant
// children (the "children" relation field) for anyone who needs them.
const rentReceiptListView: ViewDescriptor = {
  entity: 'property_management_rent_receipt',
  viewType: 'tree',
  fields: rentReceiptFields,
  formPath: '/propertymanagement/receipts/:id',
  permissions: ['property_management_rent_receipt:property_management_rent_receipt:read'],
  listFilter: { filter: { is_parent: 'true' } },
}

// propertymanagement.rentReceipt — the receipt's own printable PDF, rendered
// once at generation time (the header button above) and never again — the
// bytes this produces are what get re-uploaded onto the receipt's own
// receipt_file anchor, so a later download always shows exactly what was
// true when it was generated. Adopts the default report masthead
// (report-descriptor.ts's reportPartyAddressFields): the issuing company's
// address top-left, PURE companyFallback — the receipt itself has no
// issuer_* columns of its own (there's only ever one party issuing a rent
// receipt: the printing user's active company), so every one of those
// fields resolves entirely from the active company profile, never the
// record. Top-right stays the property/tenant(s) snapshot this entity
// actually has — a flat address string (formatPropertyAddress's FULL line,
// not just number+street — the earlier truncation was why a generated
// report read "barely empty") plus floor_area and a comma-joined tenant
// list, not the 7-column composite (no per-tenant address exists to
// decompose: tenants live at the property's own address). The title is a
// STATIC bigger label,
// not `reportTitleSection` over a record field — rentReceiptFormView above
// has no writable field at all (handler.go rejects every PUT/DELETE; the
// document is append-only), so there is no field here a user could ever
// "edit manually later". No table node: no line items exist on this entity.
const rentReceiptReport: ReportDescriptor = {
  name: 'propertymanagement.rentReceipt',
  entity: 'property_management_rent_receipt',
  permissions: ['property_management_rent_receipt:property_management_rent_receipt:read'],
  layout: [
    {
      kind: 'section',
      className: 'eerp-report-parties',
      children: [
        { kind: 'section', className: 'eerp-report-issuer', children: reportPartyAddressFields('issuer', true) },
        {
          kind: 'section',
          className: 'eerp-report-client',
          children: [
            { kind: 'text', text: 'Tenant(s):', className: 'eerp-report-label' },
            { kind: 'field', name: 'tenant_names' },
            { kind: 'text', text: 'Property:', className: 'eerp-report-label' },
            { kind: 'field', name: 'property_name' },
            { kind: 'field', name: 'property_address' },
            { kind: 'field', name: 'floor_area', format: 'number' },
          ],
        },
      ],
    },
    { kind: 'text', text: 'Rent receipt', className: 'eerp-report-title' },
    {
      kind: 'section',
      className: 'eerp-report-doc-meta',
      children: [
        { kind: 'field', name: 'period' },
        { kind: 'field', name: 'generated_at', format: 'date' },
      ],
    },
  ],
}

const propertymanagement: FrontModule = {
  name: 'propertymanagement',
  routes: [
    { path: '/propertymanagement', descriptor: dashboardView, permission: 'property_management:property_management:read' },
    { path: '/propertymanagement/list', descriptor: listView, permission: 'property_management:property_management:read' },
    { path: '/propertymanagement/:id', descriptor: formView, permission: 'property_management:property_management:read' },
    {
      path: '/propertymanagement/equipment/:id',
      descriptor: equipmentFormView,
      permission: 'property_management_equipment:property_management_equipment:read',
    },
    {
      path: '/propertymanagement/equipment/statuses/:id',
      descriptor: equipmentStatusFormView,
      permission: 'property_management_equipment_status:property_management_equipment_status:read',
    },
    {
      path: '/propertymanagement/receipts',
      descriptor: rentReceiptListView,
      permission: 'property_management_rent_receipt:property_management_rent_receipt:read',
    },
    {
      path: '/propertymanagement/receipts/:id',
      descriptor: rentReceiptFormView,
      permission: 'property_management_rent_receipt:property_management_rent_receipt:read',
    },
  ],
  reports: [rentReceiptReport],
  extends: [
    { path: '/propertymanagement/:id', operations: propertyNotebookOperations },
    { path: '/propertymanagement/equipment/:id', operations: equipmentNotebookOperations },
    { path: '/propertymanagement/receipts/:id', operations: receiptNotebookOperations },
  ],
}

export default propertymanagement
