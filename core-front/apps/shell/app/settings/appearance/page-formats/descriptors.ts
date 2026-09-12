import type { ViewDescriptor } from '@eerp/core-front'

// Settings → Global settings → Reports → page formats: descriptors only, like
// core/modules/users/descriptors.ts. The entity maps to
// core/modules/reportlayout's generic-CRUD table (GET/POST /api/v1/
// report_page_format, GET/PUT/DELETE .../:id) — a plain Go module, not one
// discovered via the module-registry FrontModule pipeline, since this table
// has no on-screen route of its own outside this hand-built settings page
// (same posture as Users/Roles).

/** The record shape at this boundary — the engine only needs HasId. */
export type ReportPageFormatRecord = { id: string } & Record<string, unknown>

// Standard paper sizes for the form's "Standard size" selector (selection/
// linked widget, packages/core-front/src/views/widgets.tsx) — picking one
// patches width/height/unit together; "Custom" (first = the field's default)
// is a deliberate no-op, leaving manual entry untouched. Real physical
// dimensions, not arbitrary presets: A4/A5 in cm (ISO 216), Letter/Legal in
// inches (the units each size is conventionally quoted in).
export const PAPER_SIZE_PRESETS = {
  A4: { width: 21, height: 29.7, unit: 'cm' },
  A5: { width: 14.8, height: 21, unit: 'cm' },
  Letter: { width: 8.5, height: 11, unit: 'in' },
  Legal: { width: 8.5, height: 14, unit: 'in' },
}

export const pageFormatListDescriptor: ViewDescriptor<ReportPageFormatRecord> = {
  entity: 'report_page_format',
  viewType: 'tree',
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'width', label: 'Width', type: 'number', widget: 'float', required: true },
    { name: 'height', label: 'Height', type: 'number', widget: 'float', required: true },
    {
      name: 'unit',
      label: 'Unit',
      type: 'selection',
      selection: { options: ['px', 'cm', 'in'] },
    },
  ],
  formPath: '/settings/appearance/page-formats/:id',
  createPermission: 'report_page_format:report_page_format:write',
  permissions: ['report_page_format:report_page_format:read'],
}

// Every override field is optional — unset means "inherit the global
// reports.layout default (footer/address) or the built-in constant
// (padding/colors)" (packages/core-front/src/views/report-chrome.ts).
export const pageFormatFormDescriptor: ViewDescriptor<ReportPageFormatRecord> = {
  entity: 'report_page_format',
  viewType: 'form',
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    // store: false: a UI convenience only — its choice patches width/height/
    // unit below via widgetOptions.presets, but has no column of its own
    // (report-chrome.ts never reads it, only the three fields it patches).
    {
      name: 'size_preset',
      label: 'Standard size',
      type: 'selection',
      widget: 'linked',
      store: false,
      selection: { options: ['Custom', 'A4', 'A5', 'Letter', 'Legal'] },
      widgetOptions: { presets: PAPER_SIZE_PRESETS },
    },
    { name: 'width', label: 'Width', type: 'number', widget: 'float', required: true },
    { name: 'height', label: 'Height', type: 'number', widget: 'float', required: true },
    {
      name: 'unit',
      label: 'Unit',
      type: 'selection',
      selection: { options: ['px', 'cm', 'in'] },
    },
    { name: 'padding', label: 'Padding override (px)', type: 'number', widget: 'float' },
    { name: 'color_text', label: 'Text color override', type: 'text', widget: 'color' },
    { name: 'color_text_muted', label: 'Muted text color override', type: 'text', widget: 'color' },
    { name: 'color_border', label: 'Border color override', type: 'text', widget: 'color' },
    { name: 'color_accent', label: 'Accent color override', type: 'text', widget: 'color' },
    { name: 'footer', label: 'Footer override', type: 'text', widget: 'long' },
    { name: 'address', label: 'Address override', type: 'text', widget: 'long' },
  ],
  permissions: ['report_page_format:report_page_format:read'],
}
