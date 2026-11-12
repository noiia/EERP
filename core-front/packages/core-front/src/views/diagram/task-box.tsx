'use client'
import { useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import { useT } from '../../i18n/translate'
import type { FieldDescriptor } from '../descriptor'
import { ErrorAlert } from '../error-alert'
import { byPrefixAndName, FontAwesomeIcon } from '../icons'
import { fieldWidget } from '../widgets'

// One task as a diagram box (WBS and PERT): its editable fields through the form's own
// widgets, committed one field at a time on blur or Enter, reverted when the write is
// refused. Double-click (outside a field) opens the record.

/** The box's width, and the height the auto-layouts should assume for it. */
export const TASK_BOX_SIZE = { w: 240, h: 160 }

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

export function TaskBox({ data, sourcePosition, targetPosition }: NodeProps<Node<TaskBoxData>>) {
  const t = useT()
  const [error, setError] = useState<SerializedError | null>(null)
  const { record, chevron } = data
  const onDoubleClick = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('input, textarea, [role="combobox"]')) data.onOpen()
  }
  return (
    <Paper variant="outlined" onDoubleClick={onDoubleClick} sx={{ width: TASK_BOX_SIZE.w, p: 1 }}>
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
      <Stack spacing={1}>
        {data.fields.filter((f) => f.name in record).map((f) => (
          <BoxField key={f.name} field={f} record={record} editable={data.editable} onCommit={data.onCommit} onError={setError} />
        ))}
      </Stack>
      {data.footer}
      <Handle type="source" position={sourcePosition ?? Position.Bottom} />
    </Paper>
  )
}

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
  const Widget = fieldWidget(field)
  const commit = () => {
    if (!draft || draft.v === current) return
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
    if (e.key === 'Enter') commit()
  }
  return (
    <Box className="nodrag" onBlur={onBlur} onKeyDown={onKeyDown} sx={{ '& .MuiInputBase-root': { fontSize: '0.8rem' } }}>
      <Widget field={field} value={draft ? draft.v : current} onChange={(v) => setDraft({ v })} disabled={!editable} recordId={String(record.id ?? '')} draft={record} />
    </Box>
  )
}
