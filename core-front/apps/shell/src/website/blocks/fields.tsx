import { humanize } from '../field-display'

/** Whether a record's picture_field can point at a picture: an anchor field (no value in
 * the record) or a boolean flag that is true. A number/text field never can. */
export const hasPicture = (record: Record<string, unknown>, field?: string): field is string =>
  !!field && (record[field] === undefined || record[field] === true)

/** A column name as a readable label. Field values go through the presentation
 * pipeline instead (present.ts → FieldValue.tsx, ADR-036). */
export const label = humanize
