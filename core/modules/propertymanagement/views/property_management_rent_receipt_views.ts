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
  /** The full comma-joined list on a parent row; a single tenant's name on a child row. */
  tenant_names?: string
  receipt_file?: boolean
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
