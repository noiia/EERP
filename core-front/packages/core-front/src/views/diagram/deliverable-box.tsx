'use client'
import { memo } from 'react'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import type { Node, NodeProps } from '@xyflow/react'
import { useT } from '../../i18n/translate'
import { useDetailed } from './task-box'

// One box of the WBS deliverables footer: the PBS items the column's tasks produce.
// Detached from the diagram: no lines, no handles, never a task (ADR-039 § PBS footer).

export const DELIVERABLE_BOX_SIZE = { w: 240, h: 96 }

export interface DeliverableItem {
  id: string
  label: string
  /** Present (>= 0) only when the config names both count columns. */
  done: number
  total: number
  hasCounts: boolean
}

export interface DeliverableBoxData extends Record<string, unknown> {
  items: DeliverableItem[]
  /** Opens the task list filtered to the item's project and the item itself. */
  onOpen: (itemId: string) => void
}

function DeliverableBoxImpl({ data, positionAbsoluteX, positionAbsoluteY }: NodeProps<Node<DeliverableBoxData>>) {
  const t = useT()
  const theme = useTheme()
  const detailed = useDetailed({ x: positionAbsoluteX, y: positionAbsoluteY, ...DELIVERABLE_BOX_SIZE })
  const empty = data.items.length === 0
  return (
    <Paper
      data-testid="deliverable-box"
      elevation={0}
      sx={{
        width: '100%',
        height: '100%',
        px: 1.5,
        py: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        borderRadius: 1,
        bgcolor: 'background.paper',
        border: `1px ${empty ? 'dashed' : 'solid'} ${theme.palette.divider}`,
      }}
    >
      {empty ? (
        <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center', my: 'auto' }}>
          {t('No deliverable')}
        </Typography>
      ) : detailed ? (
        data.items.map((it) => (
          <Box
            key={it.id}
            onClick={() => data.onOpen(it.id)}
            sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 1, cursor: 'pointer' }}
          >
            <Typography variant="caption" sx={{ fontWeight: 600 }} noWrap>
              {it.label}
            </Typography>
            {it.hasCounts ? (
              <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                {it.done} / {it.total}
              </Typography>
            ) : null}
          </Box>
        ))
      ) : (
        // Zoomed out: just the first item, like a box's own title.
        <Typography variant="caption" noWrap sx={{ alignSelf: 'center' }}>
          {data.items[0]?.label ?? ''}
        </Typography>
      )}
    </Paper>
  )
}

export const DeliverableBox = memo(DeliverableBoxImpl)
