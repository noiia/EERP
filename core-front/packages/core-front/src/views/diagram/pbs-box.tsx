import { memo, useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { useT } from '../../i18n/translate'
import { byPrefixAndName, FontAwesomeIcon } from '../icons'
import { useGraphPalette } from '../graph-widgets'
import { useDetailed } from './task-box'

// One box of a PBS chart: a deliverable the project's tasks produce, with its
// name, color and the progress of the tasks producing it (rolled up over the
// box's descendants, or the row's stored counts when the task read is capped).
// The count opens the task list filtered to the project and the deliverable.

export const PBS_BOX_SIZE = { w: 220, h: 110 }

export interface PbsRow {
  id: string
  parent_id: string | null
  name: string
  description: string | null
  color: string | null
  x: number
  y: number
  task_count: number
  done_count: number
}

export interface PbsBoxData extends Record<string, unknown> {
  row: PbsRow
  /** The roll-up over the item's own tasks and its descendants'. */
  progress: { done: number; total: number }
  editable: boolean
  /** Settles once the write is done (refused or not). */
  onColor: (color: string | null) => Promise<void>
  onDelete: () => void
  onEdit: () => void
  /** Opens the task list pinned to the item's project and deliverable. */
  onOpenTasks: () => void
}

export const PbsBox = memo(function PbsBox({ data, positionAbsoluteX, positionAbsoluteY }: NodeProps<Node<PbsBoxData>>) {
  const t = useT()
  const theme = useTheme()
  const palette = useGraphPalette()
  const detailed = useDetailed({ x: positionAbsoluteX, y: positionAbsoluteY, ...PBS_BOX_SIZE })
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  // The color being picked shows at once; one write goes out when the pick is committed.
  const [draft, setDraft] = useState<string | null>(null)
  const { row, progress, editable } = data
  const commit = (color: string | null) => {
    setDraft(color)
    void data.onColor(color).finally(() => setDraft(null))
  }
  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  })
  // React's onChange fires on every `input` while dragging in the picker; the native
  // `change` event fires once, when the pick is done.
  const colorInput = useCallback((el: HTMLInputElement | null) => {
    el?.addEventListener('change', () => commitRef.current(el.value))
  }, [])
  const color = draft ?? row.color
  const bg = color ?? theme.palette.background.paper
  const fg = color ? theme.palette.getContrastText(color) : theme.palette.text.primary
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  const stop = (e: MouseEvent) => e.stopPropagation()
  return (
    <Paper
      variant="outlined"
      data-testid="pbs-box"
      onDoubleClick={editable ? data.onEdit : undefined}
      sx={{ width: PBS_BOX_SIZE.w, height: PBS_BOX_SIZE.h, boxSizing: 'border-box', overflow: 'hidden', position: 'relative', p: 1, pr: editable ? 4 : 1 }}
      style={{ backgroundColor: bg, color: fg }}
    >
      <Handle type="target" position={Position.Top} />
      {detailed ? (
        <>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>{row.name}</Typography>
          {progress.total > 0 ? (
            <>
              <Box sx={{ mt: 0.5, height: 8, borderRadius: 1, bgcolor: 'action.disabledBackground', overflow: 'hidden' }}>
                <Box sx={{ width: `${pct}%`, height: '100%' }} style={{ backgroundColor: palette.categorical[0] }} />
              </Box>
              <Typography data-testid="pbs-count" variant="caption" sx={{ cursor: 'pointer' }} onClick={data.onOpenTasks}>
                {progress.done} / {progress.total}
              </Typography>
            </>
          ) : (
            // A leaf no task produces yet: the warning, not a bar (single hue plus the
            // label — never color alone).
            <Typography data-testid="pbs-count" variant="caption" sx={{ cursor: 'pointer' }} style={{ color: theme.palette.warning.main }} onClick={data.onOpenTasks}>
              {t('No task produces this')}
            </Typography>
          )}
          {editable ? (
            <Box className="nodrag" onDoubleClick={stop} sx={{ position: 'absolute', top: 2, right: 2, display: 'flex', flexDirection: 'column' }}>
              <IconButton size="small" aria-label={t('Color')} onClick={(e) => setMenu(e.currentTarget)} sx={{ color: 'inherit' }}>
                <FontAwesomeIcon icon={byPrefixAndName.fas['palette']} />
              </IconButton>
              <IconButton size="small" aria-label={t('Delete')} onClick={data.onDelete} sx={{ color: 'inherit' }}>
                <FontAwesomeIcon icon={byPrefixAndName.fas['trash']} />
              </IconButton>
              <Menu open={!!menu} anchorEl={menu} onClose={() => setMenu(null)}>
                <Box sx={{ px: 2, py: 1 }}>
                  <input ref={colorInput} type="color" aria-label={t('Pick a color')} defaultValue={row.color ?? '#ffffff'} onInput={(e) => setDraft(e.currentTarget.value)} />
                </Box>
                <MenuItem onClick={() => { setMenu(null); commit(null) }}>{t('Clear color')}</MenuItem>
              </Menu>
            </Box>
          ) : null}
        </>
      ) : (
        <Typography noWrap sx={{ fontSize: 28, lineHeight: 1.4, fontWeight: 600 }}>{row.name}</Typography>
      )}
      <Handle type="source" position={Position.Bottom} />
    </Paper>
  )
})
