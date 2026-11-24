'use client'
import { createContext, memo, useContext, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import InputBase from '@mui/material/InputBase'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { createTheme, type Theme } from '@mui/material/styles'
import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import { useT } from '../../i18n/translate'
import { fieldLabel, type FieldDescriptor, type ViewDescriptor } from '../descriptor'
import { formatDatePattern, useFormatStore, useNumberFormat } from '../format-store'
import { ColorRibbon } from '../color-tags'
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
/** A WBS group root: a title and an optional fold summary, as wide as a task box. */
export const LABEL_BOX_SIZE = { w: 240, h: 64 }

/** Below this zoom a box draws only its title: its widgets are too small to read there,
 * and hundreds of them are what makes a zoomed-out diagram slow. */
export const DETAIL_ZOOM = 0.6
/** True while the canvas exports, so the image always gets the full boxes. */
export const ForceDetail = createContext(false)
/** True during a "simple" export: task boxes print as their zoomed-out face (color bar + title). */
export const SimpleExport = createContext(false)

/** The zone around the camera where boxes draw in full, as a share of the visible width and
 * height added on each side: boxes just off screen are ready before a pan reaches them. */
export const DETAIL_MARGIN = 0.5

/** A box's top-left (flow coordinates) and size. */
export interface BoxArea { x?: number; y?: number; w: number; h: number }

/** Whether a box draws in full: zoomed in to DETAIL_ZOOM or more and inside the camera's
 * zone (`box` unknown, or the pane not measured yet: inside). Selects only that boolean from
 * React Flow's store, so a box re-renders when it crosses the threshold or the zone's edge,
 * not on every pan or zoom step. */
export function useDetailed(box?: BoxArea): boolean {
  const near = useStore((s) => {
    const [tx, ty, zoom] = s.transform
    if (zoom < DETAIL_ZOOM) return false
    if (box?.x === undefined || box.y === undefined || !s.width || !s.height) return true
    const vw = s.width / zoom
    const vh = s.height / zoom
    const left = -tx / zoom - vw * DETAIL_MARGIN
    const top = -ty / zoom - vh * DETAIL_MARGIN
    const right = left + vw * (1 + 2 * DETAIL_MARGIN)
    const bottom = top + vh * (1 + 2 * DETAIL_MARGIN)
    return box.x + box.w >= left && box.x <= right && box.y + box.h >= top && box.y <= bottom
  })
  return useContext(ForceDetail) || near
}

// The far-zoom title: large enough to read at DETAIL_ZOOM and below, at most 4 lines.
const FAR_TITLE_SX = { fontSize: 28, lineHeight: 1.2, fontWeight: 600, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical' } as const

export interface TaskBoxData extends Record<string, unknown> {
  record: Record<string, unknown>
  /** What the box shows when zoomed out (default: the record's name or title). */
  title?: string
  editable: boolean
  /** Fields edited in the box (descriptor definitions); those missing on the record are skipped. */
  fields: FieldDescriptor[]
  onCommit: (field: string, value: unknown) => Promise<void>
  onOpen: () => void
  badges?: ReactNode
  footer?: ReactNode
  chevron?: { folded: boolean; onToggle: () => void }
  /** The record's color groups (ViewModeDefaults.colorTagsField): a solid bar along the top. */
  colors?: string[]
  /** Takes the box off this diagram only (the record stays): a trash button in its corner. */
  onRemove?: () => void
  /** A many2one value's label (resolved once for the whole diagram): the export prints it. */
  relationLabel?: (field: string, value: unknown) => string
}

/** A WBS stacked child's elbow starts here: this far from its parent's left edge. All the
 * children of one parent share that vertical line. */
export const STACK_TRUNK_X = 16
/** The source handle a stacked child's elbow (a `step` edge) leaves from. */
export const STACK_HANDLE = 'stack'

// Bottom-left, invisible and never a drag start: it only anchors elbow lines.
const StackHandle = () => (
  <Handle id={STACK_HANDLE} type="source" position={Position.Bottom} isConnectable={false} style={{ left: STACK_TRUNK_X, opacity: 0, pointerEvents: 'none' }} />
)

function RemoveButton({ onRemove, size }: { onRemove: () => void; size: number }) {
  const t = useT()
  return (
    <IconButton
      className="nodrag"
      size="small"
      aria-label={t('Remove from diagram')}
      title={t('Remove from diagram')}
      onClick={(e) => {
        e.stopPropagation()
        onRemove()
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      sx={{ position: 'absolute', top: 2, right: 2, zIndex: 1, fontSize: size }}
    >
      <FontAwesomeIcon icon={byPrefixAndName.fas['trash']} />
    </IconButton>
  )
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

export const TaskBox = memo(function TaskBox({ data, sourcePosition, targetPosition, positionAbsoluteX, positionAbsoluteY }: NodeProps<Node<TaskBoxData>>) {
  const t = useT()
  const detailed = useDetailed({ x: positionAbsoluteX, y: positionAbsoluteY, ...TASK_BOX_SIZE })
  const exporting = useContext(ForceDetail)
  const simple = useContext(SimpleExport)
  const [error, setError] = useState<SerializedError | null>(null)
  const { record, chevron } = data
  if (!detailed || simple) {
    // Same size and handles as the full box: the layout and the arrows don't move.
    return (
      <Paper variant="outlined" data-testid="task-box-far" sx={{ position: 'relative', width: TASK_BOX_SIZE.w, height: TASK_BOX_SIZE.h, boxSizing: 'border-box', overflow: 'hidden', p: 1.5, pt: data.colors?.length ? 4 : 1.5 }}>
        <ColorRibbon colors={data.colors} height={20} />
        <Handle type="target" position={targetPosition ?? Position.Top} />
        {data.onRemove && !exporting ? <RemoveButton onRemove={data.onRemove} size={40} /> : null}
        <Typography sx={FAR_TITLE_SX}>{data.title ?? String(record.name ?? record.title ?? '')}</Typography>
        <Handle type="source" position={sourcePosition ?? Position.Bottom} />
        <StackHandle />
      </Paper>
    )
  }
  return (
    // An export grows the box to its content (no scrollbar in the image).
    <Paper variant="outlined" sx={{ position: 'relative', width: TASK_BOX_SIZE.w, boxSizing: 'border-box', p: 1, pt: data.colors?.length ? 2.5 : 1, ...(exporting ? { minHeight: TASK_BOX_SIZE.h, overflow: 'visible' } : { height: TASK_BOX_SIZE.h, overflow: 'auto' }) }}>
      <ColorRibbon colors={data.colors} height={10} />
      <Handle type="target" position={targetPosition ?? Position.Top} />
      {data.onRemove && !exporting ? <RemoveButton onRemove={data.onRemove} size={14} /> : null}
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
        {data.fields.filter((f) => f.name in record).map((f) =>
          // An export prints plain wrapping text: an input clips a long value and scrolls.
          exporting ? (
            <ExportField key={f.name} field={f} value={record[f.name]} relationLabel={data.relationLabel} />
          ) : (
            <BoxField key={f.name} field={f} record={record} editable={data.editable} onCommit={data.onCommit} onError={setError} />
          ),
        )}
      </Stack>
      {data.footer}
      <Handle type="source" position={sourcePosition ?? Position.Bottom} />
      <StackHandle />
    </Paper>
  )
})

export interface LabelBoxData extends Record<string, unknown> {
  label: string
  footer?: ReactNode
  chevron?: TaskBoxData['chevron']
}

/** A read-only box with just a title (a WBS group root), as wide as a TaskBox. */
export const LabelBox = memo(function LabelBox({ data, sourcePosition, targetPosition, positionAbsoluteX, positionAbsoluteY }: NodeProps<Node<LabelBoxData>>) {
  const t = useT()
  const detailed = useDetailed({ x: positionAbsoluteX, y: positionAbsoluteY, ...LABEL_BOX_SIZE })
  const { chevron } = data
  if (!detailed) {
    return (
      <Paper variant="outlined" sx={{ width: LABEL_BOX_SIZE.w, height: LABEL_BOX_SIZE.h, boxSizing: 'border-box', overflow: 'hidden', p: 1, bgcolor: 'action.hover' }}>
        <Handle type="target" position={targetPosition ?? Position.Top} />
        <Typography noWrap sx={{ fontSize: 28, lineHeight: 1.6, fontWeight: 600 }}>{data.label}</Typography>
        <Handle type="source" position={sourcePosition ?? Position.Bottom} />
      </Paper>
    )
  }
  return (
    <Paper variant="outlined" sx={{ width: LABEL_BOX_SIZE.w, height: LABEL_BOX_SIZE.h, boxSizing: 'border-box', overflow: 'hidden', p: 1, bgcolor: 'action.hover' }}>
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

/** A note box's size: a few lines of text, scrolling past that. */
export const NOTE_BOX_SIZE = { w: 200, h: 120 }
/** The server's limits on one note. */
export const NOTE_TEXT_LIMIT = 2000
export const NOTE_LINK_LIMIT = 50
export const NOTE_LIMIT = 200

export interface NoteBoxData extends Record<string, unknown> {
  text: string
  onText: (text: string) => void
  onDelete: () => void
}

/** A user's free-text note on the diagram: typed in place (saved on blur), linked to
 * boxes by dragging from or to its handles, deleted with its button. */
export const NoteBox = memo(function NoteBox({ data, sourcePosition, targetPosition }: NodeProps<Node<NoteBoxData>>) {
  const t = useT()
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft !== null && draft !== data.text) data.onText(draft)
    setDraft(null)
  }
  return (
    <Paper variant="outlined" sx={{ width: NOTE_BOX_SIZE.w, height: NOTE_BOX_SIZE.h, boxSizing: 'border-box', borderStyle: 'dashed', bgcolor: 'action.hover', position: 'relative', p: 1, pr: 3.5 }}>
      <Handle type="target" position={targetPosition ?? Position.Top} />
      <IconButton className="nodrag" size="small" aria-label={t('Delete note')} onClick={data.onDelete} sx={{ position: 'absolute', top: 2, right: 2 }}>
        <FontAwesomeIcon icon={byPrefixAndName.fas['trash']} />
      </IconButton>
      <InputBase
        className="nodrag nowheel"
        multiline
        fullWidth
        value={draft ?? data.text}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        placeholder={t('Note')}
        inputProps={{ maxLength: NOTE_TEXT_LIMIT, 'aria-label': t('Note') }}
        sx={{ height: '100%', overflow: 'auto', alignItems: 'flex-start', fontSize: '0.8rem' }}
      />
      <Handle type="source" position={sourcePosition ?? Position.Bottom} />
    </Paper>
  )
})

/** A box field as an export prints it: its label, then its value as text that wraps. */
function ExportField({ field, value, relationLabel }: { field: FieldDescriptor; value: unknown; relationLabel?: TaskBoxData['relationLabel'] }) {
  const t = useT()
  const { format } = useNumberFormat()
  const dateFormat = useFormatStore((s) => s.dateFormat)
  let text: string
  if (value === null || value === undefined || value === '') text = '—'
  else if (field.type === 'relation') text = relationLabel?.(field.name, value) || String(value)
  else if (field.type === 'date') text = formatDatePattern(String(value), dateFormat, { time: field.widget === 'datetime' })
  else if (field.type === 'number') text = format(Number(value))
  else if (field.type === 'boolean') text = value ? '✓' : '—'
  else if (field.type === 'selection') text = t(String(value))
  else text = String(value)
  return (
    <Box data-testid={`export-field-${field.name}`}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.2 }}>{t(fieldLabel(field))}</Typography>
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</Typography>
    </Box>
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
