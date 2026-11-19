'use client'
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
  /** Settles once the write is done (refused or not). */
  onColor: (color: string | null) => Promise<void>
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
  // The color being picked shows at once; one write goes out when the pick is committed.
  const [draft, setDraft] = useState<string | null>(null)
  const { row, editable } = data
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
                  <input ref={colorInput} type="color" aria-label={t('Pick a color')} defaultValue={row.color ?? '#ffffff'} onInput={(e) => setDraft(e.currentTarget.value)} />
                </Box>
                <MenuItem onClick={() => { setMenu(null); commit(null) }}>{t('Clear color')}</MenuItem>
              </Menu>
            </Box>
          ) : null}
        </>
      ) : (
        <Typography noWrap sx={{ fontSize: 28, lineHeight: 1.4, fontWeight: 600 }}>{row.title || lines[0]}</Typography>
      )}
      <Handle type="source" position={Position.Bottom} />
    </Paper>
  )
})
