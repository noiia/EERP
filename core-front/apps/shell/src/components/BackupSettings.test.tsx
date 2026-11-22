import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { BackupRun, BackupStatus } from '@/lib/backups'

const m = {
  getBackups: vi.fn(),
  getBackupDatabases: vi.fn(),
  getBackupRuns: vi.fn(),
  saveBackupSettings: vi.fn(),
  runBackupNow: vi.fn(),
  cancelBackup: vi.fn(),
  cleanupBackups: vi.fn(),
}
vi.mock('@/lib/backups', () => ({
  getBackups: () => m.getBackups(),
  getBackupDatabases: () => m.getBackupDatabases(),
  getBackupRuns: () => m.getBackupRuns(),
  saveBackupSettings: (...a: unknown[]) => m.saveBackupSettings(...a),
  runBackupNow: () => m.runBackupNow(),
  cancelBackup: () => m.cancelBackup(),
  cleanupBackups: () => m.cleanupBackups(),
}))

import BackupSettings from './BackupSettings'

const status = (over: Partial<BackupStatus> = {}): BackupStatus => ({
  settings: {
    enabled: false, frequency: 'daily', every_hours: 24, time: '02:00', timezone: 'UTC', weekdays: null,
    month_day: 1, databases: null, include_s3: true, retention_days: 14,
  },
  backup_dir: '/app/backups', running: null, next_run: null, last_success: null, last_failure: null,
  local_count: 0, local_bytes: 0, ...over,
})

const run = (over: Partial<BackupRun> = {}): BackupRun => ({
  id: '2026-11-22T020000Z', trigger: 'schedule', started_at: '2026-11-22T02:00:00Z',
  finished_at: '2026-11-22T02:01:30Z', status: 'success', databases: [], total_bytes: 2048, ...over,
})

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.getBackups.mockResolvedValue(status())
  m.getBackupDatabases.mockResolvedValue(['poc', 'client_a'])
  m.getBackupRuns.mockResolvedValue([])
  m.saveBackupSettings.mockResolvedValue({ ok: true })
  m.runBackupNow.mockResolvedValue({ ok: true })
  m.cancelBackup.mockResolvedValue(true)
  m.cleanupBackups.mockResolvedValue({ ok: true, removed: [] })
})

describe('BackupSettings', () => {
  it('says so when the server has no backup folder', async () => {
    m.getBackups.mockResolvedValue(null)
    render(<BackupSettings />)
    expect(await screen.findByText(/not configured on this server/)).toBeInTheDocument()
  })

  it('saves the picked databases and settings', async () => {
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'poc' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable automated backups' }))
    fireEvent.change(screen.getByLabelText('Keep local backups (days)'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(m.saveBackupSettings).toHaveBeenCalled())
    expect(m.saveBackupSettings.mock.calls[0][0]).toMatchObject({ enabled: true, databases: ['poc'], retention_days: 30 })
  })

  it('drops a selected database that no longer exists, so saving still works', async () => {
    const st = status()
    st.settings.databases = ['poc', 'gone']
    m.getBackups.mockResolvedValue(st)
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(m.saveBackupSettings).toHaveBeenCalled())
    expect(m.saveBackupSettings.mock.calls[0][0]).toMatchObject({ databases: ['poc'] })
  })

  it('shows Go\'s refusal of the settings', async () => {
    m.saveBackupSettings.mockResolvedValue({ ok: false, message: 'select at least one database' })
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText('select at least one database')).toBeInTheDocument()
  })

  it('asks for weekdays on a weekly schedule', async () => {
    render(<BackupSettings />)
    expect(await screen.findByRole('checkbox', { name: 'poc' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Monday' })).toBeNull()
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Frequency' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Weekly' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Monday' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(m.saveBackupSettings).toHaveBeenCalled())
    expect(m.saveBackupSettings.mock.calls[0][0]).toMatchObject({ frequency: 'weekly', weekdays: [1] })
  })

  it('offers Cancel instead of Run now while a backup runs', async () => {
    m.getBackups.mockResolvedValue(status({ running: run({ status: 'running', current: 'poc', finished_at: undefined }) }))
    render(<BackupSettings />)
    expect(await screen.findByText(/Writing poc/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel backup' }))
    await waitFor(() => expect(m.cancelBackup).toHaveBeenCalled())
  })

  it('runs now and reports a refusal', async () => {
    m.runBackupNow.mockResolvedValue({ ok: false, message: 'a run is already in progress' })
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
    expect(await screen.findByText('a run is already in progress')).toBeInTheDocument()
  })

  it('cleans up and says how many bundles went', async () => {
    m.cleanupBackups.mockResolvedValue({ ok: true, removed: ['2026/01/a', '2026/01/b'] })
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Clean up now' }))
    expect(await screen.findByText('Removed 2 expired backups.')).toBeInTheDocument()
  })

  it('lists the history with status and error', async () => {
    m.getBackupRuns.mockResolvedValue([
      run({ id: 'b', status: 'failed', error: 'poc: disk full' }),
      run({ id: 'a', databases: [{ name: 'poc', file: 'poc.zip', size: 2048, sha256: 'x', s3_objects: 3 }] }),
    ])
    render(<BackupSettings />)
    const table = await screen.findByRole('table', { name: 'Backup history' })
    const rows = within(table).getAllByRole('row')
    expect(within(rows[1]).getByText('Failed')).toBeInTheDocument()
    expect(within(rows[1]).getByText('poc: disk full')).toBeInTheDocument()
    expect(within(rows[2]).getByText('Success')).toBeInTheDocument()
    expect(within(rows[2]).getByText('poc')).toBeInTheDocument()
    expect(within(rows[2]).getByText('2.0 KB')).toBeInTheDocument()
    expect(within(rows[2]).getByText('1 min 30 s')).toBeInTheDocument()
  })
})
