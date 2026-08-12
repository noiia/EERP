'use client'
import { useState, type MouseEvent } from 'react'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import ListItemText from '@mui/material/ListItemText'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import { menuActionRegistry } from './menu-actions'
import type { MenuNode } from './descriptor'

// The form actions menu (docs/adr/ADR-011): default chrome for every
// `viewType: 'form'` route (rendered by FormRenderer's top toolbar, alongside
// Save/Reset — see renderers.tsx), superseding the one-off ReportExportButton.
// Content comes entirely from ViewDescriptor.actions (a MenuNode tree); a
// leaf's handler is looked up by name in menuActionRegistry (menu-actions.ts)
// at click time — registration (validateMenuActions) already proved the name
// resolves, so a missing handler here would be an engine bug, not a
// user-facing error.

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
        <FontAwesomeIcon icon={byPrefixAndName.fas['ellipsis-vertical']} />
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
        <FontAwesomeIcon icon={byPrefixAndName.fas['chevron-right']} size="sm" />
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
