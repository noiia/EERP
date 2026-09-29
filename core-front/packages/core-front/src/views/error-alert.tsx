'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import AlertTitle from '@mui/material/AlertTitle'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import type { SerializedError } from '../api/errors'
import { useT } from '../i18n/translate'
import { fieldLabel, type FieldDescriptor } from './descriptor'

// Shared error surface for every renderer that can fail a write: FormRenderer's
// Save, the relation create wizard, KanbanRenderer's drag-to-move, Calendar's
// drag-to-reschedule (docs/roadmaps/list-view-modes.md). A separate file (not
// defined inline in renderers.tsx) so kanban-renderer.tsx can import it without
// a circular import back into renderers.tsx.
//
// Written for two readers: the user, who needs to know what to fix, and the
// administrator they forward it to, who needs the request id to find the
// backend log line — hence "Copy details".

/**
 * Split a VALIDATION_ERROR's missing field names into the ones this form shows
 * (by label — the user can fill them) and the ones it doesn't (the user can't:
 * a module/configuration problem only an administrator can fix). An `address`
 * field owns its `<name>_*` sub-columns, so those resolve to its label.
 */
export function splitMissingFields(
  missing: string[],
  fields: FieldDescriptor[],
): { onForm: string[]; offForm: string[] } {
  const onForm = new Set<string>()
  const offForm: string[] = []
  for (const name of missing) {
    const field = fields.find(
      (f) => f.name === name || (f.type === 'address' && name.startsWith(`${f.name}_`)),
    )
    if (field) onForm.add(fieldLabel(field))
    else offForm.push(name)
  }
  return { onForm: [...onForm], offForm }
}

/** The plain-text report "Copy details" puts on the clipboard. */
export function errorDetails(error: SerializedError): string {
  return [
    `code: ${error.code}`,
    `message: ${error.message}`,
    error.fields?.length ? `fields: ${error.fields.join(', ')}` : null,
    error.requestId ? `request id: ${error.requestId}` : null,
    typeof window === 'undefined' ? null : `page: ${window.location.href}`,
    `time: ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join('\n')
}

export function ErrorAlert({
  error,
  fields,
}: {
  error: SerializedError
  /** The form's field descriptors — lets a VALIDATION_ERROR name fields by label. */
  fields?: FieldDescriptor[]
}) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const missing = error.code === 'VALIDATION_ERROR' ? (error.fields ?? []) : []
  const split = fields ? splitMissingFields(missing, fields) : { onForm: [], offForm: missing }

  function copy() {
    void navigator.clipboard?.writeText(errorDetails(error)).then(() => setCopied(true))
  }

  return (
    <Alert
      severity="error"
      action={
        <Button color="inherit" size="small" onClick={copy}>
          {copied ? t('Copied') : t('Copy details')}
        </Button>
      }
    >
      <AlertTitle>{missing.length ? t('Required fields are missing') : error.code}</AlertTitle>
      {missing.length ? null : t(error.message)}
      {split.onForm.length ? (
        <Typography variant="body2">
          {t('Fill in')}: {split.onForm.map((label) => t(label)).join(', ')}
        </Typography>
      ) : null}
      {split.offForm.length ? (
        <Typography variant="body2" sx={{ mt: split.onForm.length ? 0.5 : 0 }}>
          {fields
            ? t('These required fields are not on this form, so they cannot be filled in here. Please send the details to your administrator:')
            : t('Missing:')}{' '}
          {split.offForm.join(', ')}
        </Typography>
      ) : null}
      {error.requestId ? (
        <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>
          {t('Reference for your administrator')}: {error.requestId}
        </Typography>
      ) : null}
    </Alert>
  )
}
