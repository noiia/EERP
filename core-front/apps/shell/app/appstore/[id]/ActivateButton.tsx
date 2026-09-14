'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import {
  ErrorAlert,
  toApiError,
  serializeError,
  useRecentlyChangedStore,
  usePermission,
  useT,
  type SerializedError,
} from '@eerp/core-front'
import { setModuleActive } from '@/lib/module-actions'

// The ONE write affordance on the App Store's form (docs/roadmaps/
// app-store.md, decision #6) — host chrome rendered BESIDE the generic,
// entirely read-only LayoutForm, never inside it (CreateBar's exact
// posture). Its own Server Action, entirely independent of the record
// form's store/commit — every field on this form is readOnly, so that path
// never fires regardless. Optimistic flip + revert-and-ErrorAlert, the same
// posture use-optimistic-field-move.ts established for Kanban/Calendar.
//
// The write is now LIVE: PUT /api/v1/modules/:id flips the backend's runtime
// active-gate before it even writes module.json (internal/module/
// runtime.go), so there is nothing to tell the operator to come back for —
// no more "requires restart" notice.
export function ActivateButton({ name, active }: { name: string; active: boolean }) {
  const t = useT()
  const router = useRouter()
  const allowed = usePermission('modules:modules:write')
  const [pending, startTransition] = useTransition()
  const [optimisticActive, setOptimisticActive] = useState(active)
  const [error, setError] = useState<SerializedError | null>(null)
  const markChanged = useRecentlyChangedStore((s) => s.markChanged)

  // Hidden entirely without the permission — CreateBar's posture, not a
  // disabled affordance (the hooks above still run unconditionally either way).
  if (!allowed) return null

  // Mirrors the backend's self-protection: the store must not brick its own UI.
  const selfProtected = name === 'appstore' && optimisticActive

  const onClick = () => {
    const next = !optimisticActive
    setError(null)
    setOptimisticActive(next)
    startTransition(async () => {
      try {
        const result = await setModuleActive(name, next)
        setOptimisticActive(result.active)
        markChanged(name)
        router.refresh()
      } catch (e) {
        setOptimisticActive(!next)
        setError(serializeError(toApiError(e)))
      }
    })
  }

  const button = (
    <Button
      variant="contained"
      color={optimisticActive ? 'error' : 'primary'}
      disabled={pending || selfProtected}
      onClick={onClick}
    >
      {optimisticActive ? t('Deactivate') : t('Activate')}
    </Button>
  )

  return (
    <Stack spacing={1} sx={{ alignItems: 'flex-end' }}>
      {selfProtected ? (
        <Tooltip title={t('The App Store cannot deactivate itself.')}>
          <span>{button}</span>
        </Tooltip>
      ) : (
        button
      )}
      {error ? <ErrorAlert error={error} /> : null}
    </Stack>
  )
}
