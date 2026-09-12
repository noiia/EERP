'use client'
import { useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'
import { evaluateCondition, type HeaderButtonDescriptor } from './descriptor'
import { headerButtonRegistry } from './header-button-actions'
import { useRelationOps } from './relation-ops'

// The header-button-container (docs — sale's Quote Confirm/Send/Accept/
// Decline is the first user): real, always-visible workflow buttons in the
// form's top toolbar, right of the options menu (FormActionsMenu) — as
// opposed to a menu item behind a click, these are meant to be the primary
// next action on the record. Content comes entirely from
// ViewDescriptor.headerButtons; each entry's `states.visible` (the SAME
// Condition DSL FieldDescriptor.states already uses) is reevaluated against
// the CURRENT DRAFT on every render, so several entries with different
// conditions is how one visual slot appears to "change label" across a
// workflow — only the entries whose condition currently holds render at all.

export interface HeaderButtonContainerProps {
  entity: string
  buttons: HeaderButtonDescriptor[]
  /** The form route's :id — 'new' for an unsaved draft, which renders
   * nothing: every header button acts on a real, saved record (same posture
   * FormActionsMenu takes for its options menu). */
  recordId: string
  draft: Record<string, unknown>
  /** Patch field(s) on the current record and commit via the form's own
   * commit path — see HeaderButtonContext.setFieldAndCommit. */
  onFieldsCommit: (patch: Record<string, unknown>) => Promise<Record<string, unknown> | null>
}

export function HeaderButtonContainer({
  entity,
  buttons,
  recordId,
  draft,
  onFieldsCommit,
}: HeaderButtonContainerProps) {
  const t = useT()
  const relationOps = useRelationOps()
  const [runningName, setRunningName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (recordId === 'new' || buttons.length === 0) return null

  const visible = buttons.filter((b) =>
    b.states?.visible ? evaluateCondition(b.states.visible, draft) : true,
  )
  if (visible.length === 0) return null

  const run = (name: string) => {
    const registered = headerButtonRegistry.get(name)
    if (!registered) return
    setRunningName(name)
    setError(null)
    void Promise.resolve(
      registered.handler({ entity, recordId, draft, setFieldAndCommit: onFieldsCommit, relationOps }),
    )
      .catch(() => setError(t('Action failed.')))
      .finally(() => setRunningName(null))
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      {error ? (
        <Typography variant="caption" color="error">
          {error}
        </Typography>
      ) : null}
      {visible.map((button) => {
        // readOnly renders DISABLED, not omitted — unlike visible, which
        // unmounts. "Already generated this month" should still be seen,
        // just not clickable, until the condition clears on its own.
        const readOnly = button.states?.readOnly ? evaluateCondition(button.states.readOnly, draft) : false
        return (
          <Button
            key={button.name}
            variant={button.variant === 'secondary' ? 'outlined' : 'contained'}
            disabled={runningName !== null || readOnly}
            onClick={() => run(button.name)}
            sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
          >
            {runningName === button.name && (
              <CircularProgress size={16} color="inherit" thickness={5} />
            )}
            {t(button.label)}
          </Button>
        )
      })}
    </Box>
  )
}
