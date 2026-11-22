'use client'
import { useCallback, useEffect, useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormGroup from '@mui/material/FormGroup'
import FormLabel from '@mui/material/FormLabel'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { Banner, BannerScope, BannerSlot, useT, ViewBanner } from '@eerp/core-front'
import {
  cancelBackup,
  cleanupBackups,
  getBackupDatabases,
  getBackupRuns,
  getBackups,
  runBackupNow,
  saveBackupSettings,
  type BackupRun,
  type BackupSettings as Settings,
  type BackupStatus,
} from '@/lib/backups'

// Settings → Developer → Automated backups (docs/adr/ADR-044-automated-backups.md):
// the schedule, which databases go in each bundle, and the run history. Go
// writes the bundles to its backup_dir for Backrest to snapshot; whether
// Backrest then uploaded them is Backrest's own status, never shown here.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const FREQUENCIES: { value: Settings['frequency']; label: string }[] = [
  { value: 'hours', label: 'Every X hours' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
]
const STATUS_LABEL: Record<BackupRun['status'], string> = {
  running: 'Running',
  success: 'Success',
  failed: 'Failed',
  cancelled: 'Cancelled',
}
const STATUS_COLOR = {
  running: 'info',
  success: 'success',
  failed: 'error',
  cancelled: 'warning',
} as const
const POLL_MS = 5000

function timezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return ['UTC']
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

function duration(from: string, to?: string): string {
  if (!to) return '—'
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '—')

export default function BackupSettings() {
  const t = useT()
  const [status, setStatus] = useState<BackupStatus | null | undefined>(undefined)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [databases, setDatabases] = useState<string[]>([])
  const [runs, setRuns] = useState<BackupRun[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (withDraft: boolean) => {
    const [s, dbs, history] = await Promise.all([
      getBackups(),
      getBackupDatabases(),
      getBackupRuns(),
    ])
    setStatus(s)
    setDatabases(dbs)
    setRuns(history)
    // A selected database deleted since has no checkbox to untick: drop it, or Go refuses every save.
    if (withDraft && s)
      setDraft({
        ...s.settings,
        databases: (s.settings.databases ?? []).filter((d) => dbs.includes(d)),
      })
  }, [])

  useEffect(() => {
    void refresh(true)
  }, [refresh])

  // Follow a running backup until it ends.
  const running = Boolean(status?.running)
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => void refresh(false), POLL_MS)
    return () => clearInterval(id)
  }, [running, refresh])

  if (status === undefined) return null
  if (status === null || !draft) {
    return (
      <Banner>
        {t(
          'Automated backups are not configured on this server (backup_dir in the configuration file).',
        )}
      </Banner>
    )
  }

  const set = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch })
  const picked = new Set(draft.databases ?? [])
  const days = new Set(draft.weekdays ?? [])

  // Runs one action; `notice` (a success message) and `message` (Go's refusal) come back with it.
  async function act(fn: () => Promise<{ ok: boolean; message?: string; notice?: string }>) {
    setBusy(true)
    setError(null)
    setNotice(null)
    const res = await fn()
    if (res.ok) setNotice(res.notice ?? null)
    else setError(res.message || t('Action failed.'))
    await refresh(false)
    setBusy(false)
  }

  const save = () =>
    act(async () => ({ ...(await saveBackupSettings(draft)), notice: t('Saved.') }))
  // A run reads the SAVED settings: save what's on screen first, or ticking a
  // database then clicking Run now would back up the previous selection.
  const runNow = () =>
    act(async () => {
      const saved = await saveBackupSettings(draft)
      if (!saved.ok) return saved
      return { ...(await runBackupNow()), notice: t('Backup started.') }
    })
  const cancel = () =>
    act(async () => ({ ok: await cancelBackup(), message: t('Nothing to cancel.') }))
  const cleanup = () =>
    act(async () => {
      const res = await cleanupBackups()
      return res.ok
        ? {
            ok: true,
            notice: t('Removed {n} expired backups.').replace('{n}', String(res.removed.length)),
          }
        : res
    })

  // Its own banner scope: the page's slot sits above every section, out of
  // sight of these buttons.
  return (
    <BannerScope>
      <Stack spacing={2}>
        <BannerSlot />
        <ViewBanner status="error" open={Boolean(error)}>
          {error}
        </ViewBanner>
        <ViewBanner open={Boolean(notice)} onClose={() => setNotice(null)}>
          {notice}
        </ViewBanner>

        <Typography variant="body2" color="text.secondary">
          {t('Each run writes one restorable zip per database (S3 files included) into')}{' '}
          <code>{status.backup_dir}</code>.{' '}
          {t(
            'Point Backrest at that folder, mounted read-only: its snapshots are separate from these runs.',
          )}
        </Typography>

        <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Typography variant="body2">
            {t('Scheduler')}: <strong>{draft.enabled ? t('Enabled') : t('Disabled')}</strong>
          </Typography>
          <Typography variant="body2">
            {t('Next run')}: {when(status.next_run)}
          </Typography>
          <Typography variant="body2">
            {t('Last success')}: {when(status.last_success)}
          </Typography>
          <Typography variant="body2">
            {t('Last failure')}: {when(status.last_failure?.at)}
          </Typography>
          <Typography variant="body2">
            {t('Local backups')}: {status.local_count} ({formatBytes(status.local_bytes)})
          </Typography>
        </Stack>
        {status.running && (
          <Typography variant="body2" role="status">
            {t('Backup running.')}{' '}
            {status.running.current
              ? t('Writing {db}…').replace('{db}', status.running.current)
              : ''}
          </Typography>
        )}

        <FormControlLabel
          control={
            <Checkbox
              checked={draft.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
          }
          label={t('Enable automated backups')}
        />

        <FormGroup aria-label={t('Databases')}>
          <FormLabel>{t('Databases')}</FormLabel>
          {databases.map((db) => (
            <FormControlLabel
              key={db}
              label={db}
              control={
                <Checkbox
                  checked={picked.has(db)}
                  onChange={(e) =>
                    set({
                      databases: databases.filter((d) =>
                        d === db ? e.target.checked : picked.has(d),
                      ),
                    })
                  }
                />
              }
            />
          ))}
          <FormControlLabel
            control={
              <Checkbox
                checked={draft.include_s3}
                onChange={(e) => set({ include_s3: e.target.checked })}
              />
            }
            label={t('Include S3 files')}
          />
        </FormGroup>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField
            select
            label={t('Frequency')}
            value={draft.frequency}
            onChange={(e) => set({ frequency: e.target.value as Settings['frequency'] })}
            sx={{ minWidth: 180 }}
          >
            {FREQUENCIES.map((f) => (
              <MenuItem key={f.value} value={f.value}>
                {t(f.label)}
              </MenuItem>
            ))}
          </TextField>
          {draft.frequency === 'hours' && (
            <TextField
              type="number"
              label={t('Every (hours)')}
              value={draft.every_hours}
              onChange={(e) => set({ every_hours: Number(e.target.value) })}
              slotProps={{ htmlInput: { min: 1, max: 168 } }}
            />
          )}
          {draft.frequency === 'monthly' && (
            <TextField
              type="number"
              label={t('Day of the month')}
              value={draft.month_day}
              onChange={(e) => set({ month_day: Number(e.target.value) })}
              slotProps={{ htmlInput: { min: 1, max: 28 } }}
            />
          )}
          <TextField
            type="time"
            label={draft.frequency === 'hours' ? t('Starting at') : t('Time')}
            value={draft.time}
            onChange={(e) => set({ time: e.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <Autocomplete
            options={timezones()}
            value={draft.timezone}
            disableClearable
            onChange={(_, v) => set({ timezone: v })}
            sx={{ minWidth: 220 }}
            renderInput={(params) => <TextField {...params} label={t('Timezone')} />}
          />
        </Stack>
        {draft.frequency === 'weekly' && (
          <FormGroup row aria-label={t('Days')}>
            {WEEKDAYS.map((d, i) => (
              <FormControlLabel
                key={d}
                label={t(d)}
                control={
                  <Checkbox
                    checked={days.has(i)}
                    onChange={(e) =>
                      set({
                        weekdays: WEEKDAYS.map((_, j) => j).filter((j) =>
                          j === i ? e.target.checked : days.has(j),
                        ),
                      })
                    }
                  />
                }
              />
            ))}
          </FormGroup>
        )}

        <TextField
          type="number"
          label={t('Keep local backups (days)')}
          value={draft.retention_days}
          onChange={(e) => set({ retention_days: Number(e.target.value) })}
          helperText={t(
            "Keep this well above Backrest's snapshot interval. The newest backup is always kept.",
          )}
          slotProps={{ htmlInput: { min: 1, max: 3650 } }}
          sx={{ maxWidth: 420 }}
        />

        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button variant="contained" onClick={save} disabled={busy}>
            {t('Save')}
          </Button>
          <Button variant="outlined" onClick={runNow} disabled={busy || running}>
            {t('Run now')}
          </Button>
          {running && (
            <Button variant="outlined" color="warning" onClick={cancel}>
              {t('Cancel backup')}
            </Button>
          )}
          <Button variant="text" onClick={cleanup} disabled={busy}>
            {t('Clean up now')}
          </Button>
        </Stack>

        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label={t('Backup history')}>
            <TableHead>
              <TableRow>
                <TableCell>{t('ID')}</TableCell>
                <TableCell>{t('Started')}</TableCell>
                <TableCell>{t('Ended')}</TableCell>
                <TableCell>{t('Duration')}</TableCell>
                <TableCell>{t('Status')}</TableCell>
                <TableCell>{t('Databases')}</TableCell>
                <TableCell>{t('Size')}</TableCell>
                <TableCell>{t('Details')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {runs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8}>{t('No backup has run yet.')}</TableCell>
                </TableRow>
              )}
              {runs.map((r) => (
                <TableRow key={`${r.id}-${r.started_at}`}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.id}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{when(r.started_at)}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{when(r.finished_at)}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    {duration(r.started_at, r.finished_at)}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      color={STATUS_COLOR[r.status]}
                      label={t(STATUS_LABEL[r.status])}
                    />
                  </TableCell>
                  <TableCell>{(r.databases ?? []).map((d) => d.name).join(', ') || '—'}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatBytes(r.total_bytes)}</TableCell>
                  <TableCell>
                    {[r.error, ...(r.warnings ?? [])].filter(Boolean).join(' · ') || '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Stack>
    </BannerScope>
  )
}
