'use client'
import { useState, type MouseEvent } from 'react'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import ListItemText from '@mui/material/ListItemText'
import SvgIcon from '@mui/material/SvgIcon'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'
import { menuActionRegistry } from './menu-actions'
import type { MenuNode } from './descriptor'

// The form actions menu (docs/adr/ADR-011): default chrome for every
// `viewType: 'form'` route (rendered unconditionally by the catch-all, in
// the title row's old spot — see apps/shell/app/[...module]/page.tsx),
// superseding the one-off ReportExportButton. Content comes entirely from
// ViewDescriptor.actions (a MenuNode tree); a leaf's handler is looked up by
// name in menuActionRegistry (menu-actions.ts) at click time — registration
// (validateMenuActions) already proved the name resolves, so a missing
// handler here would be an engine bug, not a user-facing error.

/** Material "more_vert" glyph inlined — one icon does not justify an icons dependency. */
function MoreVertIcon(props: React.ComponentProps<typeof SvgIcon>) {
  return (
    <SvgIcon {...props}>
      <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
    </SvgIcon>
  )
}

/** Material "chevron_right" glyph inlined, same call as MoreVertIcon above. */
function ChevronRightIcon(props: React.ComponentProps<typeof SvgIcon>) {
  return (
    <SvgIcon {...props}>
      <path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
    </SvgIcon>
  )
}

export interface FormActionsMenuProps {
  entity: string
  actions: MenuNode[]
  /** The form route's :id — 'new' for an unsaved draft, which disables the
   * button entirely: every action here acts on a real, saved record. */
  recordId: string
}

export function FormActionsMenu({ entity, actions, recordId }: FormActionsMenuProps) {
  const t = useT()
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasRecord = recordId !== 'new'

  const run = (name: string) => {
    setAnchorEl(null)
    const action = menuActionRegistry.get(name)
    if (!action) return
    setBusy(true)
    setError(null)
    void Promise.resolve(action.handler({ entity, recordId }))
      .catch(() => setError(t('Action failed.')))
      .finally(() => setBusy(false))
  }

  return (
    <>
      {error ? (
        <Typography variant="caption" color="error" sx={{ mr: 1 }}>
          {error}
        </Typography>
      ) : null}
      <IconButton
        aria-label={t('Options')}
        disabled={actions.length === 0 || !hasRecord || busy}
        onClick={(event: MouseEvent<HTMLElement>) => setAnchorEl(event.currentTarget)}
      >
        <MoreVertIcon />
      </IconButton>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
        {actions.map((node, i) => (
          <MenuNodeItem key={i} node={node} onRun={run} />
        ))}
      </Menu>
    </>
  )
}

function MenuNodeItem({ node, onRun }: { node: MenuNode; onRun: (name: string) => void }) {
  const t = useT()
  const [subAnchor, setSubAnchor] = useState<HTMLElement | null>(null)

  if (node.kind === 'action') {
    return <MenuItem onClick={() => onRun(node.action)}>{t(node.label)}</MenuItem>
  }

  return (
    <>
      <MenuItem onClick={(event: MouseEvent<HTMLElement>) => setSubAnchor(event.currentTarget)}>
        <ListItemText>{t(node.label)}</ListItemText>
        <ChevronRightIcon fontSize="small" />
      </MenuItem>
      <Menu
        anchorEl={subAnchor}
        open={Boolean(subAnchor)}
        onClose={() => setSubAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      >
        {node.children.map((child, i) => (
          <MenuNodeItem key={i} node={child} onRun={onRun} />
        ))}
      </Menu>
    </>
  )
}
