import {
  createAttachmentClient,
  fetchReportPDF,
  FORM_NOTEBOOK_ID,
  registerHeaderButtonAction,
  useEntityRefreshStore,
  type FrontRoute,
  type HeaderButtonDescriptor,
  type Operation,
  type ViewDescriptor,
} from '@eerp/core-front'

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
   * see property_management_views.ts's formatPropertyAddress. */
  property_address?: string
  floor_area?: number
  /** Snapshot of PropertyManagement.rent_price at generation time. */
  rent_price?: number
  /** Snapshot totals over this receipt's own lines (below) — same
   * excl./tax/incl. shape as sale.invoice's subtotal/tax_amount/total. */
  subtotal?: number
  tax_amount?: number
  total?: number
  /** The full comma-joined list on a parent row; a single tenant's name on a child row. */
  tenant_names?: string
  receipt_file?: boolean
}

// property_management_rent_receipt's own descriptor — needed so the Rent
// receipt notebook page's formPath has somewhere to navigate: a generated
// receipt's snapshot fields + its saved PDF (boolean/file). None of these
// are readOnly — a receipt row is append-only in the sense that it's never
// DELETED (module.go's doc comment), but every field, PUT included, is
// editable after the fact; PUT rides the generic CRUD surface like any other
// entity's (handler.go only still hand-mounts a DELETE override).
const rentReceiptFields: ViewDescriptor['fields'] = [
  { name: 'period', label: 'Period', type: 'text' },
  { name: 'generated_at', label: 'Generated at', type: 'text' },
  { name: 'property_name', label: 'Property', type: 'text' },
  { name: 'property_address', label: 'Address', type: 'text' },
  { name: 'floor_area', label: 'Floor area', type: 'number', widget: 'float' },
  { name: 'rent_price', label: 'Rent price', type: 'number', widget: 'monetary' },
  { name: 'subtotal', label: 'Subtotal (excl. tax)', type: 'number', widget: 'monetary' },
  { name: 'tax_amount', label: 'Tax', type: 'number', widget: 'monetary' },
  { name: 'total', label: 'Total (incl. tax)', type: 'number', widget: 'monetary' },
  { name: 'tenant_names', label: 'Tenant(s)', type: 'text' },
  { name: 'receipt_file', label: 'Receipt PDF', type: 'boolean', widget: 'file' },
]

// Form-only, NOT part of rentReceiptFields (which the cross-property
// rentReceiptListView's DataGrid columns also read — a one2many relation
// field has no sensible DataGrid column rendering): on a PARENT row's own
// form, embeds the per-tenant CHILD rows this generation produced, PLUS every
// later "Regenerate report" version of each (below) — every row sharing this
// parent's own id (module.go's doc comment on PropertyManagementRentReceipt).
// On a CHILD row's own form this is simply empty — a child has no children
// of its own.
const rentReceiptFormFields: ViewDescriptor['fields'] = [
  ...rentReceiptFields,
  {
    name: 'children',
    label: 'Tenant receipts',
    type: 'relation',
    relation: {
      entity: 'property_management_rent_receipt',
      kind: 'one2many',
      inverseField: 'parent_id',
      labelField: 'tenant_names',
      formPath: '/propertymanagement/receipts/:id',
    },
  },
]

// Regenerate PDF: covers the best-effort upload in property_management_
// views.ts's propertymanagement.generateRentReceipt failing (e.g.
// attachments' S3 store unavailable at generation time) — re-renders the
// SAME snapshot fields already on this receipt row (never re-reads the
// property/tenants, per module.go's "capture at document time" discipline)
// and re-uploads onto the same receipt_file anchor. Visible only while the
// boolean/file widget's own live check (file-widgets.tsx's
// useAttachmentState) has resolved no attachment there.
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

// Regenerate report: unlike Regenerate PDF above (repairs THIS row's own
// missing file, in place), this produces a whole NEW version — a sibling
// CHILD row (same parent_id) with its own fresh snapshot (copied from
// whatever is currently on screen, including any unsaved edits — a receipt's
// fields are no longer read-only, see module.go's doc comment) and its own
// receipt_line copies and PDF. Every version this ever produces stays
// visible side by side in the parent's own "Tenant receipts" notebook table
// (receiptExtendOperations, below) instead of overwriting one in place —
// the append-only discipline module.go documents, now expressed as "add a
// sibling" rather than "reject the edit." Always visible on a child (no
// receipt_file gate, unlike Regenerate PDF) — regenerating a fresh version
// is meaningful whether or not this one already has a PDF.
registerHeaderButtonAction({
  entity: 'property_management_rent_receipt',
  name: 'propertymanagement.regenerateReceipt',
  handler: async (ctx) => {
    const ops = ctx.relationOps
    if (!ops) return

    const lines = await ops.list('property_management_rent_receipt_line', {
      filter: { rent_receipt_id: ctx.recordId },
      pageSize: 100,
    })

    const version = await ops.create('property_management_rent_receipt', {
      parent_id: ctx.draft.parent_id,
      is_parent: false,
      period: ctx.draft.period,
      generated_at: new Date().toISOString(),
      property_name: ctx.draft.property_name,
      property_address: ctx.draft.property_address,
      floor_area: ctx.draft.floor_area,
      uom: ctx.draft.uom,
      rent_price: ctx.draft.rent_price,
      // Upfront estimate copied straight from this row's own current totals
      // (about to be re-derived anyway, below) — same "estimate now, let the
      // backend correct it" posture property_management_views.ts's
      // generateRentReceipt already takes for a brand-new receipt.
      subtotal: ctx.draft.subtotal,
      tax_amount: ctx.draft.tax_amount,
      total: ctx.draft.total,
      tenant_names: ctx.draft.tenant_names,
      receipt_file: false,
    })

    // Each create triggers the backend's own recomputeReceiptTotals
    // (handler.go's CreateRentReceiptLine) from ALL of this new version's
    // lines so far — the same double-check generateRentReceipt's own child
    // rows get, not just the upfront estimate above.
    for (const line of lines) {
      await ops.create('property_management_rent_receipt_line', {
        rent_receipt_id: version.id,
        name: line.name,
        unit_price: line.unit_price,
        tax_rate: line.tax_rate,
        subtotal: line.subtotal,
        total: line.total,
      })
    }

    const pdf = await fetchReportPDF('propertymanagement.rentReceipt', version.id)
    await createAttachmentClient().upload(
      { table: 'property_management_rent_receipt', recordId: version.id, field: 'receipt_file' },
      pdf,
      `rent-receipt-${String(ctx.draft.period ?? '')}.pdf`,
    )

    // The new version's own row never reaches this (already-open) record's
    // own draft — bump so the parent's "Tenant receipts" table (a
    // RelationListWidget scoped by parent_id) picks it up.
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
  {
    name: 'propertymanagement.regenerateReceipt',
    label: 'Regenerate report',
    // Same "child only" gate as Regenerate PDF above, minus the
    // receipt_file condition — see the handler's own doc comment.
    states: {
      visible: { field: 'parent_id', op: 'set' },
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
// its own notebook page — same self-extension shape
// property_management_views.ts's propertyExtendOperations and
// property_management_equipment_views.ts's equipmentExtendOperations
// already use for every other one2many field in this module.
export const receiptExtendOperations: Operation[] = [
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
// created only by property_management_views.ts's
// propertymanagement.generateRentReceipt (handler.go's
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

export const rentReceiptRoutes: FrontRoute[] = [
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
]
