'use client'
import { memo, useContext } from 'react'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import { alpha, useTheme } from '@mui/material/styles'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { useT } from '../../i18n/translate'
import { FAR_LABEL_SX, SimpleExport, useDetailed } from './task-box'

// One deliverable (a milestone) of the WBS: under the task that carries it, or, for a
// level-1 task, on the footer row below the diagram — then empty ("No milestone yet")
// when that task has none. Never dragged, saved or connected by hand (ADR-039).

export const DELIVERABLE_BOX_SIZE = { w: 240, h: 72 }
const YELLOW = '#fbc02d'

export interface DeliverableBoxData extends Record<string, unknown> {
  /** The milestone's label; null = the empty placeholder of `taskName`. */
  label: string | null
  taskName: string
  /** "done / total", shown only when the config names both count columns. */
  counts?: string
  /** Opens the milestone, or the creation form for the empty placeholder. */
  onOpen: () => void
}

function DeliverableBoxImpl({ data, positionAbsoluteX, positionAbsoluteY }: NodeProps<Node<DeliverableBoxData>>) {
  const t = useT()
  const theme = useTheme()
  const detailed = useDetailed({ x: positionAbsoluteX, y: positionAbsoluteY, ...DELIVERABLE_BOX_SIZE })
  // Text sizes follow the task and label boxes: their far/simple title, else their subtitle.
  const simple = useContext(SimpleExport)
  const far = !detailed || simple
  const empty = data.label === null
  return (
    <Paper
      data-testid="deliverable-box"
      role="button"
      tabIndex={0}
      elevation={0}
      onClick={data.onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') data.onOpen()
      }}
      sx={{
        width: '100%',
        height: '100%',
        px: 1.5,
        py: 1,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 0.5,
        borderRadius: 1,
        cursor: 'pointer',
        bgcolor: empty ? 'background.paper' : alpha(YELLOW, 0.15),
        border: empty ? `1px dashed ${theme.palette.divider}` : `1px solid ${alpha(YELLOW, 0.7)}`,
      }}
    >
      {/* The arrow from the task ends here; no hand-drawn link starts or ends on it. */}
      <Handle type="target" position={Position.Top} isConnectable={false} style={{ opacity: 0 }} />
      {empty ? (
        <Typography variant="subtitle2" color="text.secondary" noWrap={far} sx={{ textAlign: 'center', ...(far ? FAR_LABEL_SX : {}) }}>
          {t('No milestone yet for {name}').replace('{name}', data.taskName)}
        </Typography>
      ) : (
        <>
          <Typography variant="subtitle2" noWrap sx={far ? FAR_LABEL_SX : undefined}>
            {data.label}
          </Typography>
          {!far && data.counts ? (
            <Typography variant="caption" color="text.secondary">
              {data.counts}
            </Typography>
          ) : null}
        </>
      )}
    </Paper>
  )
}

export const DeliverableBox = memo(DeliverableBoxImpl)
