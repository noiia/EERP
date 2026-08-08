'use client'
import { useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { usePermission } from '../auth/Can'
import { useT } from '../i18n/translate'

export interface ReportExportButtonProps {
  /** The ReportDescriptor's name, e.g. 'crm.statement'. */
  reportName: string
  recordId: string
  /** Same permission the report's own descriptor declares — display gating
   * only, mirroring CreateBar; Go re-checks it against the actual request. */
  permission: string
}

/**
 * "Export to PDF" (docs/adr/ADR-010, docs/roadmaps/pdf-reports.md Phase 4).
 * POSTs to this BFF's /api/reports/:name/:id — never Go directly, the same
 * posture every other write in this engine takes — which mints a short-lived
 * print URL, calls pdf-service, and uploads the result to Garage. Opens the
 * returned download_url, itself a BFF proxy path (/api/reports/pdf?key=...),
 * so the browser never talks to Go directly for the download either.
 */
export function ReportExportButton({ reportName, recordId, permission }: ReportExportButtonProps) {
  const t = useT()
  const allowed = usePermission(permission)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!allowed) return null

  const handleClick = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/reports/${encodeURIComponent(reportName)}/${encodeURIComponent(recordId)}`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error('export failed')
      const body = (await res.json()) as { download_url: string }
      window.open(body.download_url, '_blank')
    } catch {
      setError(t('Could not generate the report.'))
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
      <Button
        variant="outlined"
        disabled={busy}
        onClick={handleClick}
        startIcon={busy ? <CircularProgress size={16} color="inherit" thickness={5} /> : undefined}
      >
        {busy ? t('Exporting…') : t('Export to PDF')}
      </Button>
    </Box>
  )
}
