'use client'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { usePermission, usePictureClient, useSessionStore, useT, type PictureMeta } from '@eerp/core-front'

// Go's anchor for it: pictures.WorkspaceTable / FaviconField, record = tenant id.
// Served anonymously at /api/v1/public/favicon (the root layout's icon link).
const TABLE = 'workspace'
const FIELD = 'favicon'

/** Settings → Global settings → Favicon: the browser-tab icon of the ERP and the site. */
export function FaviconSettings() {
  const t = useT()
  const pictures = usePictureClient()
  const tenantId = useSessionStore((s) => s.identity?.tenantId ?? '')
  const canEdit = usePermission('pictures:pictures:write')
  const input = useRef<HTMLInputElement>(null)
  const [current, setCurrent] = useState<PictureMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!tenantId) return
    let live = true
    pictures.find({ table: TABLE, recordId: tenantId, field: FIELD }).then((p) => live && setCurrent(p), () => {})
    return () => { live = false }
  }, [pictures, tenantId])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not save.'))
    } finally {
      setBusy(false)
    }
  }
  const upload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) void run(async () => setCurrent(await pictures.upload({ table: TABLE, recordId: tenantId, field: FIELD }, file, file.name)))
  }

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {t('The small icon shown in browser tabs, for the ERP and the public website. A square PNG (e.g. 64×64) works best; browsers may keep the old one for a few minutes.')}
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
        <Box sx={{ width: 48, height: 48, border: 1, borderColor: 'divider', borderRadius: 1, display: 'grid', placeItems: 'center' }}>
          {current && <Box component="img" src={`${pictures.url(current.id)}?v=${current.size}`} alt={t('Favicon')} sx={{ maxWidth: 32, maxHeight: 32 }} />}
        </Box>
        {canEdit && (
          <>
            <Button variant="outlined" disabled={busy || !tenantId} onClick={() => input.current?.click()}>
              {t(current ? 'Replace' : 'Upload')}
            </Button>
            {current && (
              <Button color="error" disabled={busy} onClick={() => void run(async () => { await pictures.remove(current.id); setCurrent(null) })}>
                {t('Remove')}
              </Button>
            )}
            <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={upload} />
          </>
        )}
      </Stack>
    </Stack>
  )
}
