'use client'
import { useState } from 'react'
import Badge from '@mui/material/Badge'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'
import type { MenuNode } from './descriptor'
import { MenuNodeItem } from './form-actions-menu'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import { menuActionRegistry } from './menu-actions'

// The list view's row-selection toolbar — right of the search bar (only for
// the flat DataGrid branch, which is also where TreeRenderer turns on
// checkboxSelection). Two pieces:
//   - A "Select all" button badged with how many of the currently loaded
//     rows are checked. Clicking it toggles between selecting every row the
//     filter/search currently returned (liveRecords — there's no separate
//     "every row across every page" fetch: paging IS the search bar's own
//     rows-per-page control, so "all" means all of what that fetch already
//     loaded) and clearing the selection.
//   - A bulk actions menu, appearing once at least one row is selected,
//     reusing the SAME ViewDescriptor.actions / menuActionRegistry a form's
//     own FormActionsMenu already runs (menu-actions.ts) — just invoked once
//     per selected id instead of once for the single record a form edits.

export interface SelectionBarProps {
  entity: string
  actions: MenuNode[]
  selectedIds: string[]
  /** How many rows are currently loaded (liveRecords.length) — the "all" in
   * "Select all" toggles against this count, not some cross-page total. */
  totalLoaded: number
  onSelectAll: () => void
}

export function SelectionBar({ entity, actions, selectedIds, totalLoaded, onSelectAll }: SelectionBarProps) {
  const t = useT()
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (totalLoaded === 0) return null

  const allSelected = selectedIds.length > 0 && selectedIds.length === totalLoaded

  const run = async (name: string) => {
    setAnchorEl(null)
    const action = menuActionRegistry.get(name)
    if (!action) return
    setBusy(true)
    setError(null)
    try {
      await Promise.all(selectedIds.map((recordId) => action.handler({ entity, recordId })))
    } catch {
      setError(t('Action failed.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      {error ? (
        <Typography variant="caption" color="error">
          {error}
        </Typography>
      ) : null}
      <Badge badgeContent={selectedIds.length} color="primary" max={999}>
        <Button size="small" variant={allSelected ? 'contained' : 'outlined'} onClick={onSelectAll}>
          {t('Select all')}
        </Button>
      </Badge>
      {selectedIds.length > 0 && (
        <>
          <IconButton
            aria-label={t('Actions')}
            disabled={actions.length === 0 || busy}
            onClick={(e) => setAnchorEl(e.currentTarget)}
          >
            <FontAwesomeIcon icon={byPrefixAndName.fas['ellipsis-vertical']} />
          </IconButton>
          <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
            {actions.map((node, i) => (
              <MenuNodeItem key={i} node={node} onRun={(name) => void run(name)} />
            ))}
          </Menu>
        </>
      )}
    </Box>
  )
}
