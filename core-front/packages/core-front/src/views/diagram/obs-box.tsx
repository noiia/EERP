'use client'
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import { BaseEdge, Handle, Position, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import { useT } from '../../i18n/translate'
import { byPrefixAndName, FontAwesomeIcon } from '../icons'
import { useRelationOps } from '../relation-ops'
import { GRID_BUS_DROP } from './auto-layout'
import { SimpleExport, useDetailed } from './task-box'

// One box of an OBS chart: a contact, a user or free text, with its role title and color.
// The contact/user label is read through the canvas's cached RelationOps.get.

export const OBS_BOX_SIZE = { w: 220, h: 110 }

export interface ObsRow {
  id: string
  parent_id: string | null
  kind: 'contact' | 'user' | 'text'
  contact_id: string | null
  user_id: string | null
  title: string | null
  text: string | null
  color: string | null
  x: number
  y: number
}

export interface ObsBoxData extends Record<string, unknown> {
  row: ObsRow
  editable: boolean
  /** Settles once the write is done (refused or not). */
  onColor: (color: string | null) => Promise<void>
  onDelete: () => void
  onEdit: () => void
  /** Set when the box has children: folds or unfolds its branch (`hidden` boxes under it while folded). */
  chevron?: { folded: boolean; hidden: number; onToggle: () => void }
}

/** The lines under the title: the contact's name and email, the user's name, or the text. */
function useLines(row: ObsRow): string[] {
  const t = useT()
  const ops = useRelationOps()
  const [ref, missing] = row.kind === 'contact' ? [row.contact_id, t('Deleted contact')] : row.kind === 'user' ? [row.user_id, t('Unknown user')] : [null, '']
  const entity = row.kind === 'contact' ? 'contact' : 'users'
  const [lines, setLines] = useState<string[]>([])
  useEffect(() => {
    if (!ref || !ops) return
    let cancelled = false
    ops.get(entity, ref).then(
      (r) => {
        if (cancelled) return
        const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
        setLines(entity === 'contact'
          ? [str(r.name), str(r.email)].filter((x): x is string => !!x)
          : [str(r.display_name) ?? str(r.email) ?? ''])
      },
      () => !cancelled && setLines([missing]),
    )
    return () => {
      cancelled = true
    }
  }, [ops, entity, ref, missing])
  return row.kind === 'text' ? (row.text ? [row.text] : []) : lines
}

const FAR_MAX_FONT = 28
const FAR_MIN_FONT = 10

/** The zoomed-out (and simple export) title: wrapped on words, its font shrunk from 28px
 * until every line and every word fits the box, so nothing is cropped. */
export function FarTitle({ text }: { text: string }) {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let size = FAR_MAX_FONT
    el.style.fontSize = `${size}px`
    // overflowWrap normal: a word longer than the box overflows sideways (caught here) instead of splitting.
    while (size > FAR_MIN_FONT && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) {
      size -= 1
      el.style.fontSize = `${size}px`
    }
  }, [text])
  return (
    <Typography
      ref={ref}
      data-testid="obs-box-far"
      sx={{ height: '100%', overflow: 'hidden', lineHeight: 1.2, fontWeight: 600, whiteSpace: 'normal', overflowWrap: 'normal', wordBreak: 'normal' }}
    >
      {text}
    </Typography>
  )
}

export const ObsBox = memo(function ObsBox({ data, positionAbsoluteX, positionAbsoluteY, targetPosition }: NodeProps<Node<ObsBoxData>>) {
  const t = useT()
  const theme = useTheme()
  const detailed = useDetailed({ x: positionAbsoluteX, y: positionAbsoluteY, ...OBS_BOX_SIZE })
  // A simple export prints every box as its zoomed-out form: its color and title only.
  const simple = useContext(SimpleExport)
  const lines = useLines(data.row)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  // The color being picked shows at once; one write goes out when the pick is committed.
  const [draft, setDraft] = useState<string | null>(null)
  const { row, editable, chevron } = data
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
  const stop = (e: MouseEvent) => e.stopPropagation()
  return (
    <Paper
      variant="outlined"
      data-testid="obs-box"
      onDoubleClick={editable ? data.onEdit : undefined}
      sx={{ width: OBS_BOX_SIZE.w, height: OBS_BOX_SIZE.h, boxSizing: 'border-box', overflow: 'hidden', position: 'relative', p: 1, pr: detailed && !simple && (editable || chevron) ? 4 : 1 }}
      style={{ backgroundColor: bg, color: fg }}
    >
      {/* A box in a grid of siblings is entered from the left (the renderer sets targetPosition). */}
      <Handle type="target" position={targetPosition ?? Position.Top} />
      {detailed && !simple ? (
        <>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>{row.title}</Typography>
          {lines.map((l, i) => (
            <Typography key={i} variant="body2" sx={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{l}</Typography>
          ))}
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
          {chevron ? (
            <Box className="nodrag" onDoubleClick={stop} sx={{ position: 'absolute', bottom: 2, right: 2, display: 'flex', alignItems: 'center' }}>
              {chevron.folded ? <Typography variant="caption" sx={{ fontWeight: 600 }}>{`+${chevron.hidden}`}</Typography> : null}
              <IconButton size="small" aria-label={chevron.folded ? t('Expand') : t('Collapse')} onClick={chevron.onToggle} sx={{ color: 'inherit' }}>
                <FontAwesomeIcon icon={byPrefixAndName.fas[chevron.folded ? 'chevron-right' : 'chevron-down']} />
              </IconButton>
            </Box>
          ) : null}
        </>
      ) : (
        <FarTitle text={row.title || lines[0] || ''} />
      )}
      <Handle type="source" position={Position.Bottom} />
    </Paper>
  )
})

export type BusEdgeType = Edge<{ trunk: number }, 'bus'>

/** The line to a child laid out in a grid (layoutTreeGrid): down from the parent to the bus
 * GRID_BUS_DROP below it, across to the trunk `trunk` px left of the child, down to the child's
 * middle, then into its left side. Relative to both ends, so it follows a hand move. */
export function BusEdge({ sourceX, sourceY, targetX, targetY, data, markerEnd, style, interactionWidth }: EdgeProps<BusEdgeType>) {
  const busY = sourceY + GRID_BUS_DROP
  const trunkX = targetX - (data?.trunk ?? 0)
  return <BaseEdge path={`M${sourceX},${sourceY}V${busY}H${trunkX}V${targetY}H${targetX}`} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth} />
}
