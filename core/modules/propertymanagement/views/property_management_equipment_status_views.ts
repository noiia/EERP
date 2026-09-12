import { type FrontRoute, type ViewDescriptor } from '@eerp/core-front'

// property_management_equipment_status — a dated entry in an equipment's
// damage-state history (the user's own confirmed choice: a log, not a
// single current-status field) — State is a closed vocabulary, same
// selection-field shape as sale.Invoice.Status.

/** One property_management_equipment_status row — a dated entry in the
 * equipment's damage-state history log (the user's own confirmed choice). */
export interface PropertyManagementEquipmentStatus {
  id: string
  property_management_equipment_id: string
  date?: string | null
  /** good / damaged / under_repair / out_of_service — see module.go. */
  state: string
}

// property_management_equipment_status's own descriptor — needed for the
// equipment form's "Damage state history" one2many create-wizard, same
// reasoning as sale's quote_line_views.ts own descriptor.
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

export const equipmentStatusRoutes: FrontRoute[] = [
  {
    path: '/propertymanagement/equipment/statuses/:id',
    descriptor: equipmentStatusFormView,
    permission: 'property_management_equipment_status:property_management_equipment_status:read',
  },
]
