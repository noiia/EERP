'use client'
import { useState, type MouseEvent } from 'react'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import ListItemText from '@mui/material/ListItemText'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'
import { evaluateCondition, type MenuNode } from './descriptor'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import { menuActionRegistry } from './menu-actions'
import { useRelationOps } from './relation-ops'

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
  /**
   * Built-in Delete entry — engine chrome, not a module-declared
   * ViewDescriptor.action, so every form gets it with no per-descriptor
   * opt-in (same posture Save/Reset already take). Omitted (no handler)
   * hides the entry entirely: the caller (FormRenderer) only passes one when
   * both `${entity}:${entity}:delete` is granted AND the bound
   * EntityActions.remove exists (it's optional — a host that never wired a
   * remove Server Action just doesn't get the entry). Rendered last, below a
   * Divider when custom actions exist above it.
   */
  onDelete?: () => void
  /**
   * The record's current draft — threaded into each action's
   * MenuActionContext (menu-actions.ts) and used to evaluate a
   * MenuActionNode's own `states.readOnly` condition, the same parity
   * HeaderButtonContainer already has with its own buttons.
   */
  draft: Record<string, unknown>
  /** Patch field(s) on this record and commit via the form's own commit
   * path — see MenuActionContext.setFieldAndCommit. */
  onFieldsCommit: (patch: Record<string, unknown>) => Promise<Record<string, unknown> | null>
}

export function FormActionsMenu({
  entity,
  actions,
  recordId,
  onDelete,
  draft,
  onFieldsCommit,
}: FormActionsMenuProps) {
  const t = useT()
  const relationOps = useRelationOps()
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasRecord = recordId !== 'new'
  const hasAnyItem = actions.length > 0 || onDelete != null

  const run = (name: string) => {
    setAnchorEl(null)
    const action = menuActionRegistry.get(name)
    if (!action) return
    setBusy(true)
    setError(null)
    void Promise.resolve(
      action.handler({ entity, recordId, draft, setFieldAndCommit: onFieldsCommit, relationOps }),
    )
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
        disabled={!hasAnyItem || !hasRecord || busy}
        onClick={(event: MouseEvent<HTMLElement>) => setAnchorEl(event.currentTarget)}
      >
        <FontAwesomeIcon icon={byPrefixAndName.fas['ellipsis-vertical']} />
      </IconButton>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
        {actions.map((node, i) => (
          <MenuNodeItem key={i} node={node} onRun={run} draft={draft} />
        ))}
        {onDelete
          ? [
              actions.length > 0 ? <Divider key="delete-divider" /> : null,
              <MenuItem
                key="delete"
                onClick={() => {
                  setAnchorEl(null)
                  onDelete()
                }}
                sx={{ color: 'error.main' }}
              >
                <FontAwesomeIcon icon={byPrefixAndName.fas['trash']} size="sm" style={{ marginRight: 8 }} />
                {t('Delete')}
              </MenuItem>,
            ]
          : null}
      </Menu>
    </>
  )
}

/** Exported for reuse by list-selection.tsx's bulk actions menu — the SAME
 * recursive MenuNode rendering, just fed a different `onRun`. `draft` is
 * optional and only ever supplied by FormActionsMenu (a single real
 * record) — the bulk actions menu has none to offer, so a MenuActionNode's
 * own `states.readOnly` condition just never disables there (see
 * MenuActionNode's own doc comment). */
export function MenuNodeItem({
  node,
  onRun,
  draft,
}: {
  node: MenuNode
  onRun: (name: string) => void
  draft?: Record<string, unknown>
}) {
  const t = useT()
  const [subAnchor, setSubAnchor] = useState<HTMLElement | null>(null)

  if (node.kind === 'action') {
    const readOnly = node.states?.readOnly && draft ? evaluateCondition(node.states.readOnly, draft) : false
    return (
      <MenuItem onClick={() => onRun(node.action)} disabled={readOnly}>
        {t(node.label)}
      </MenuItem>
    )
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
          <MenuNodeItem key={i} node={child} onRun={onRun} draft={draft} />
        ))}
      </Menu>
    </>
  )
}
