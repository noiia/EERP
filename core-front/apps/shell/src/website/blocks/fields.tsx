import Typography from '@mui/material/Typography'

const label = (k: string) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** `label: value` lines for the configured fields; a field Go omitted (unpublished) is skipped. */
export function FieldLines({ record, fields, skip }: { record: Record<string, unknown>; fields: string[]; skip: string }) {
  return fields.filter((f) => f !== skip && record[f] != null).map((f) => (
    <Typography key={f} variant="body2" color="text.secondary">{label(f)}: {String(record[f])}</Typography>
  ))
}
