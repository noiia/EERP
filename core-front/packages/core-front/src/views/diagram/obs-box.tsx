'use client'
import { memo, useEffect, useState, type MouseEvent } from 'react'
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
import { useRelationOps } from '../relation-ops'
import { useDetailed } from './task-box'

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
  onColor: (color: string | null) => void
  onDelete: () => void
  onEdit: () => void
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

export const ObsBox = memo(function ObsBox({ data, positionAbsoluteX, positionAbsoluteY }: NodeProps<Node<ObsBoxData>>) {
  const t = useT()
  const theme = useTheme()
  const detailed = useDetailed({ x: positionAbsoluteX, y: positionAbsoluteY, ...OBS_BOX_SIZE })
  const lines = useLines(data.row)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const { row, editable } = data
  const bg = row.color ?? theme.palette.background.paper
  const fg = row.color ? theme.palette.getContrastText(row.color) : theme.palette.text.primary
  const stop = (e: MouseEvent) => e.stopPropagation()
  return (
    <Paper
      variant="outlined"
      data-testid="obs-box"
      onDoubleClick={editable ? data.onEdit : undefined}
      sx={{ width: OBS_BOX_SIZE.w, height: OBS_BOX_SIZE.h, boxSizing: 'border-box', overflow: 'hidden', position: 'relative', p: 1, pr: editable ? 4 : 1 }}
      style={{ backgroundColor: bg, color: fg }}
    >
      <Handle type="target" position={Position.Top} />
      {detailed ? (
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
                  <input type="color" aria-label={t('Pick a color')} value={row.color ?? '#ffffff'} onChange={(e) => data.onColor(e.target.value)} />
                </Box>
                <MenuItem onClick={() => { setMenu(null); data.onColor(null) }}>{t('Clear color')}</MenuItem>
              </Menu>
            </Box>
          ) : null}
        </>
      ) : (
        <Typography noWrap sx={{ fontSize: 28, lineHeight: 1.4, fontWeight: 600 }}>{row.title}</Typography>
      )}
      <Handle type="source" position={Position.Bottom} />
    </Paper>
  )
})
