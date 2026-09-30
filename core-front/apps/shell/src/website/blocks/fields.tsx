import Typography from '@mui/material/Typography'

/** Whether a record's picture_field can point at a picture: an anchor field (no value in
 * the record) or a boolean flag that is true. A number/text field never can. */
export const hasPicture = (record: Record<string, unknown>, field?: string): field is string =>
  !!field && (record[field] === undefined || record[field] === true)

const label = (k: string) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** `label: value` lines for the configured fields; a field Go omitted (unpublished) is
 * skipped, and so is a structured value (JSON object/array, e.g. a page layout): it has
 * no one-line text form. */
export function FieldLines({ record, fields, skip }: { record: Record<string, unknown>; fields: string[]; skip: string }) {
  return fields.filter((f) => f !== skip && record[f] != null && typeof record[f] !== 'object').map((f) => (
    <Typography key={f} variant="body2" color="text.secondary">{label(f)}: {String(record[f])}</Typography>
  ))
}
