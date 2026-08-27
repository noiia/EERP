import {
  FORM_COLUMNS_ID,
  FORM_NOTEBOOK_ID,
  registerFieldFunction,
  type DraftRecord,
  type FrontRoute,
  type Operation,
  type ViewDescriptor,
} from '@eerp/core-front'

// property_management_equipment — one piece of equipment, owned by EXACTLY
// one property (the user's own confirmed choice — not shared/movable, a
// real FK same shape as sale_line belonging to one invoice).

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
// self-extension shape as property_management_views.ts's
// propertyExtendOperations.
export const equipmentExtendOperations: Operation[] = [
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

export const equipmentRoutes: FrontRoute[] = [
  {
    path: '/propertymanagement/equipment/:id',
    descriptor: equipmentFormView,
    permission: 'property_management_equipment:property_management_equipment:read',
  },
]
