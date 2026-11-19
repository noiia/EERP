import type { FieldDescriptor, ViewDescriptor } from '../views/descriptor'

// Form status breadcrumb configuration (core-front/CLAUDE.md's "Status bar"
// row): which selection field a form's breadcrumb follows and which of its
// options it lists as steps. A module declares the baseline
// (`ViewDescriptor.statusBar.field`, every option of that field as steps); an
// admin MAY override either per entity from Settings -> Apps -> :module —
// resolveStatusBar merges the two, the override winning when set and usable.
// Same "module baseline + runtime override" shape as chatter-visibility.ts.

/** Server state: app_settings key `views.<entity>.status_bar`. `null` means
 * "no workspace override" for that part — NOT "none". */
export interface StatusBarConfig {
  /** A `type: 'selection'` field of the form; null = the module's own field. */
  field: string | null
  /** The steps, in breadcrumb order, among that field's options; null = all of them. */
  steps: string[] | null
}

export const EMPTY_STATUS_BAR_CONFIG: StatusBarConfig = { field: null, steps: null }

export interface ResolvedStatusBar {
  field: FieldDescriptor
  steps: string[]
}

function selectionField<T>(descriptor: ViewDescriptor<T>, name: string | null | undefined) {
  if (!name) return undefined
  const field = descriptor.fields.find((f) => f.name === name)
  return field?.type === 'selection' && (field.selection?.options.length ?? 0) > 0 ? field : undefined
}

/**
 * The breadcrumb a form renders, or null when it has none. The module must
 * opt in (`descriptor.statusBar`); the override can't add a breadcrumb to a
 * form that declares none. An override naming a field the form doesn't have
 * (or that isn't a selection) falls back to the module's field; override steps
 * are kept in their own order, minus values the field doesn't offer, and an
 * override left with no usable step falls back to every option.
 */
export function resolveStatusBar<T>(
  descriptor: ViewDescriptor<T>,
  config: StatusBarConfig = EMPTY_STATUS_BAR_CONFIG,
): ResolvedStatusBar | null {
  if (!descriptor.statusBar) return null
  const field = selectionField(descriptor, config.field) ?? selectionField(descriptor, descriptor.statusBar.field)
  if (!field) return null
  const options = field.selection?.options ?? []
  // Steps saved for another field never apply to this one.
  const stepsApply = config.field == null || config.field === field.name
  const steps = stepsApply && config.steps ? config.steps.filter((s) => options.includes(s)) : []
  return { field, steps: steps.length > 0 ? [...new Set(steps)] : options }
}
