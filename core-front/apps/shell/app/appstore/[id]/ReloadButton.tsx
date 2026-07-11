'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import { ErrorAlert, toApiError, serializeError, usePermission, useT, type SerializedError } from '@eerp/core-front'
import { reloadModule } from '@/lib/module-actions'

// The "upgradable directly on run" affordance (docs/roadmaps/app-store.md):
// re-instantiates a WASM module's (possibly replaced) .wasm binary and
// re-runs its migration with no restart. Hidden for Go-type modules — their
// code is compiled straight into the backend binary, so there is no binary
// to hot-swap; only a rebuild+restart actually changes their behavior
// (internal/module/runtime.go's Registry.Reload spells this constraint out).
export function ReloadButton({ name, type }: { name: string; type?: string }) {
  const t = useT()
  const router = useRouter()
  const allowed = usePermission('modules:modules:write')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<SerializedError | null>(null)

  if (!allowed || type === 'go') return null

  const onClick = () => {
    setError(null)
    startTransition(async () => {
      try {
        await reloadModule(name)
        router.refresh()
      } catch (e) {
        setError(serializeError(toApiError(e)))
      }
    })
  }

  return (
    <Stack spacing={1} sx={{ alignItems: 'flex-end' }}>
      <Tooltip title={t('Re-instantiate this module from disk — no restart.')}>
        <span>
          <Button variant="outlined" disabled={pending} onClick={onClick}>
            {t('Reload')}
          </Button>
        </span>
      </Tooltip>
      {error ? <ErrorAlert error={error} /> : null}
    </Stack>
  )
}
