'use client'
import { memo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { createTheme, type Theme } from '@mui/material/styles'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import { useT } from '../../i18n/translate'
import type { FieldDescriptor, ViewDescriptor } from '../descriptor'
import { ErrorAlert } from '../error-alert'
import { byPrefixAndName, FontAwesomeIcon } from '../icons'
import { fieldWidget } from '../widgets'
import { moduleRegistry } from '../../registry'

// One task as a diagram box (WBS and PERT): its editable fields through the form's own
// widgets, committed one field at a time on blur or Enter, reverted when the write is
// refused. Double-click (outside a field) opens the record.

/** The box's fixed size (it scrolls inside past that), which the auto-layouts assume:
 * room for five compact fields, a badge row and a footer line. */
export const TASK_BOX_SIZE = { w: 240, h: 300 }

export interface TaskBoxData extends Record<string, unknown> {
  record: Record<string, unknown>
  editable: boolean
  /** Fields edited in the box (descriptor definitions); those missing on the record are skipped. */
  fields: FieldDescriptor[]
  onCommit: (field: string, value: unknown) => Promise<void>
  onOpen: () => void
  badges?: ReactNode
  footer?: ReactNode
  chevron?: { folded: boolean; onToggle: () => void }
}

/** The form's widgets, compact (they have no size prop of their own). The canvas
 * wraps all its boxes in one ThemeProvider of it, not one per box. */
export const compactTheme = (outer: Theme) => createTheme(outer, {
  components: {
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiFormControl: { defaultProps: { size: 'small' } },
    MuiAutocomplete: { defaultProps: { size: 'small' } },
  },
})

/** A box field's definition: the FORM's first (its relation scoping, e.g. a picker
 * filtered by the record's own project), else the list descriptor's. */
export function boxFieldOf(descriptor: ViewDescriptor) {
  const formFields = moduleRegistry.formDescriptorFor(descriptor.entity)?.fields ?? []
  return (name: string): FieldDescriptor | undefined =>
    formFields.find((f) => f.name === name) ?? descriptor.fields.find((f) => f.name === name)
}

export const TaskBox = memo(function TaskBox({ data, sourcePosition, targetPosition }: NodeProps<Node<TaskBoxData>>) {
  const t = useT()
  const [error, setError] = useState<SerializedError | null>(null)
  const { record, chevron } = data
  const onDoubleClick = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('input, textarea, [role="combobox"]')) data.onOpen()
  }
  return (
    <Paper variant="outlined" onDoubleClick={onDoubleClick} sx={{ width: TASK_BOX_SIZE.w, height: TASK_BOX_SIZE.h, boxSizing: 'border-box', overflow: 'auto', p: 1 }}>
      <Handle type="target" position={targetPosition ?? Position.Top} />
      <ErrorAlert error={error} />
      {chevron || data.badges ? (
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mb: 0.5 }}>
          {chevron ? (
            <IconButton size="small" aria-label={chevron.folded ? t('Expand') : t('Collapse')} onClick={chevron.onToggle}>
              <FontAwesomeIcon icon={byPrefixAndName.fas[chevron.folded ? 'chevron-right' : 'chevron-down']} />
            </IconButton>
          ) : null}
          {data.badges}
        </Stack>
      ) : null}
      <Stack spacing={0.75} sx={{ pt: 0.75 }}>
        {data.fields.filter((f) => f.name in record).map((f) => (
          <BoxField key={f.name} field={f} record={record} editable={data.editable} onCommit={data.onCommit} onError={setError} />
        ))}
      </Stack>
      {data.footer}
      <Handle type="source" position={sourcePosition ?? Position.Bottom} />
    </Paper>
  )
})

export interface LabelBoxData extends Record<string, unknown> {
  label: string
  footer?: ReactNode
  chevron?: TaskBoxData['chevron']
}

/** A read-only box with just a title (a WBS group root), as wide as a TaskBox. */
export const LabelBox = memo(function LabelBox({ data, sourcePosition, targetPosition }: NodeProps<Node<LabelBoxData>>) {
  const t = useT()
  const { chevron } = data
  return (
    <Paper variant="outlined" sx={{ width: TASK_BOX_SIZE.w, boxSizing: 'border-box', p: 1, bgcolor: 'action.hover' }}>
      <Handle type="target" position={targetPosition ?? Position.Top} />
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        {chevron ? (
          <IconButton size="small" aria-label={chevron.folded ? t('Expand') : t('Collapse')} onClick={chevron.onToggle}>
            <FontAwesomeIcon icon={byPrefixAndName.fas[chevron.folded ? 'chevron-right' : 'chevron-down']} />
          </IconButton>
        ) : null}
        <Typography variant="subtitle2" noWrap>{data.label}</Typography>
      </Stack>
      {data.footer}
      <Handle type="source" position={sourcePosition ?? Position.Bottom} />
    </Paper>
  )
})

function BoxField({ field, record, editable, onCommit, onError }: {
  field: FieldDescriptor
  record: Record<string, unknown>
  editable: boolean
  onCommit: TaskBoxData['onCommit']
  onError: (e: SerializedError | null) => void
}) {
  const current = record[field.name]
  const [draft, setDraft] = useState<{ v: unknown } | null>(null)
  // A new value from the record (a save, a reload) replaces whatever was typed.
  const [seen, setSeen] = useState(current)
  if (seen !== current) {
    setSeen(current)
    setDraft(null)
  }
  // The edit already sent: Enter then blur commits it once.
  const sent = useRef<{ v: unknown } | null>(null)
  const Widget = fieldWidget(field)
  const commit = () => {
    if (!draft || draft.v === current || draft === sent.current) return
    sent.current = draft
    onError(null)
    onCommit(field.name, draft.v).catch((e: unknown) => {
      setDraft(null)
      onError(serializeError(toApiError(e)))
    })
  }
  const onBlur = (e: FocusEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) commit()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement
    // Enter is a new line in a multiline field, and a pick in an open list.
    if (e.key === 'Enter' && target.tagName !== 'TEXTAREA' && target.getAttribute('aria-expanded') !== 'true') commit()
  }
  return (
    <Box className="nodrag" onBlur={onBlur} onKeyDown={onKeyDown} sx={{ '& .MuiInputBase-root': { fontSize: '0.8rem' } }}>
      <Widget field={field} value={draft ? draft.v : current} onChange={(v) => setDraft({ v })} disabled={!editable} recordId={String(record.id ?? '')} draft={record} />
    </Box>
  )
}
