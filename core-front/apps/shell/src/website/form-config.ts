import type { FormConfig, FormField } from './types'

// Pure helpers behind the Form block's settings (ADR-033). Go re-validates every
// saved layout (formtarget.ValidateFormConfig); these keep the editor from offering
// what it would refuse.

/** The 7 column suffixes an `address` field writes (Go's formtarget.AddressSuffixes). */
export const ADDRESS_SUFFIXES = ['_number', '_complement', '_street', '_zip_code', '_city', '_state', '_country'] as const
export const MAX_FORM_TARGETS = 10

export type FormPreset = 'user' | 'address' | 'message'

/** Ready-made field groups, mapped onto a target: user data and address on a contact,
 * a message on a CRM lead's notes. */
export const FORM_PRESETS: Record<FormPreset, (target: number) => FormField[]> = {
  user: (target) => [
    { id: 'name', label: 'Name', type: 'text', column: 'name', required: true, target, preset: 'user' },
    { id: 'surname', label: 'Surname', type: 'text', column: 'surname', target, preset: 'user' },
    { id: 'email', label: 'Email', type: 'email', column: 'email', required: true, target, preset: 'user' },
    { id: 'phone', label: 'Phone', type: 'phone', column: 'phone', target, preset: 'user' },
  ],
  address: (target) => [{ id: 'address', label: 'Address', type: 'address', column: 'address', target, preset: 'address' }],
  message: (target) => [{ id: 'message', label: 'Message', type: 'long', column: 'notes', target, preset: 'message' }],
}

/** The table a preset maps onto. */
export const PRESET_TABLE: Record<FormPreset, string> = { user: 'contact', address: 'contact', message: 'crm' }

/** The columns a field writes: its column, or an address's 7. */
export function fieldColumns(f: Pick<FormField, 'type' | 'column'>): string[] {
  return f.type === 'address' ? ADDRESS_SUFFIXES.map((s) => f.column + s) : [f.column]
}

/** Every column target `i` already writes (fields, links, fixed values). */
export function usedColumns(c: FormConfig, i: number, exceptField?: string): Set<string> {
  const t = c.targets[i]
  const out = new Set([...Object.keys(t?.links ?? {}), ...Object.keys(t?.fixed ?? {})])
  for (const f of c.fields) if (f.target === i && f.id !== exceptField && f.column) fieldColumns(f).forEach((col) => out.add(col))
  return out
}

/** Prefixes whose 7 address columns are all registered. */
export function addressPrefixes(columns: string[]): string[] {
  const set = new Set(columns)
  return columns.filter((c) => c.endsWith('_street')).map((c) => c.slice(0, -'_street'.length))
    .filter((p) => ADDRESS_SUFFIXES.every((s) => set.has(p + s)))
}

/** Columns a visitor may type into: ids (`*_id`) only come from links or fixed values. */
export const typeableColumns = (columns: string[]) => columns.filter((c) => !c.endsWith('_id'))

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}_${n}`)) n++
  return `${base}_${n}`
}

/** A new custom field id (`field_1`, `field_2`, …). */
export function newFieldId(c: FormConfig): string {
  const ids = new Set(c.fields.map((f) => f.id))
  let n = 1
  while (ids.has(`field_${n}`)) n++
  return `field_${n}`
}

/** The config with the preset's fields added to the first target of its table, minus
 * those whose columns that target already writes; null when there is no such target. */
export function addPreset(c: FormConfig, preset: FormPreset): FormConfig | null {
  const target = c.targets.findIndex((t) => t.table === PRESET_TABLE[preset])
  if (target < 0) return null
  const used = usedColumns(c, target)
  const ids = new Set(c.fields.map((f) => f.id))
  const added: FormField[] = []
  for (const f of FORM_PRESETS[preset](target)) {
    if (fieldColumns(f).some((col) => used.has(col))) continue
    const id = uniqueId(f.id, ids)
    ids.add(id)
    added.push({ ...f, id })
  }
  return { ...c, fields: [...c.fields, ...added] }
}

/** Removes target `i`: its fields and the links pointing at it go, later indexes shift down. */
export function removeTarget(c: FormConfig, i: number): FormConfig {
  const shift = (n: number) => (n > i ? n - 1 : n)
  const targets = c.targets.filter((_, j) => j !== i).map((t) => ({
    ...t,
    links: t.links ? Object.fromEntries(Object.entries(t.links).filter(([, from]) => from !== i).map(([col, from]) => [col, shift(from)])) : t.links,
  }))
  const fields = c.fields.filter((f) => f.target !== i).map((f) => ({ ...f, target: shift(f.target) }))
  return { ...c, targets, fields }
}
