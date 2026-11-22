import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@eerp/core-front/server'

const apiRequestMock = vi.fn()
vi.mock('@eerp/core-front/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eerp/core-front/server')>()
  return { ...actual, apiRequest: (...args: unknown[]) => apiRequestMock(...args) }
})

import {
  cancelBackup, cleanupBackups, getBackupDatabases, getBackupRuns, getBackups, runBackupNow, saveBackupSettings,
  type BackupSettings,
} from './backups'

const conflict = new ApiError({ code: 'BACKUP_RUNNING', message: 'a run is already in progress', status: 409 })

beforeEach(() => {
  apiRequestMock.mockReset()
})

describe('backups server actions', () => {
  it('reads the overview, null when unavailable (backup_dir unset → 404)', async () => {
    apiRequestMock.mockResolvedValueOnce({ backup_dir: '/b' })
    await expect(getBackups()).resolves.toEqual({ backup_dir: '/b' })
    expect(apiRequestMock).toHaveBeenCalledWith('GET', '/backups')
    apiRequestMock.mockRejectedValueOnce(new ApiError({ code: 'NOT_FOUND', message: 'x', status: 404 }))
    await expect(getBackups()).resolves.toBeNull()
  })

  it('saves the settings with PUT and surfaces Go\'s message', async () => {
    const s = { enabled: true } as BackupSettings
    apiRequestMock.mockResolvedValueOnce({})
    await expect(saveBackupSettings(s)).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith('PUT', '/backups', s)
    apiRequestMock.mockRejectedValueOnce(new ApiError({ code: 'VALIDATION_ERROR', message: 'unknown timezone', status: 400 }))
    await expect(saveBackupSettings(s)).resolves.toEqual({ ok: false, message: 'unknown timezone' })
  })

  it('lists databases and runs, empty on failure', async () => {
    apiRequestMock.mockResolvedValueOnce({ data: ['poc'] }).mockResolvedValueOnce({ data: [{ id: 'r' }], total: 1 })
    await expect(getBackupDatabases()).resolves.toEqual(['poc'])
    await expect(getBackupRuns()).resolves.toEqual([{ id: 'r' }])
    expect(apiRequestMock).toHaveBeenLastCalledWith('GET', '/backups/runs')
    apiRequestMock.mockRejectedValue(new Error('down'))
    await expect(getBackupDatabases()).resolves.toEqual([])
    await expect(getBackupRuns()).resolves.toEqual([])
  })

  it('runs now, mapping a 409 to its message', async () => {
    apiRequestMock.mockResolvedValueOnce({ id: 'r' })
    await expect(runBackupNow()).resolves.toEqual({ ok: true })
    expect(apiRequestMock).toHaveBeenCalledWith('POST', '/backups/run')
    apiRequestMock.mockRejectedValueOnce(conflict)
    await expect(runBackupNow()).resolves.toEqual({ ok: false, message: 'a run is already in progress' })
    apiRequestMock.mockRejectedValueOnce(new Error('boom'))
    await expect(runBackupNow()).resolves.toEqual({ ok: false, message: '' })
  })

  it('cancels and cleans up', async () => {
    apiRequestMock.mockResolvedValueOnce({ cancelled: true }).mockResolvedValueOnce({ removed: ['2026/01/x'] })
    await expect(cancelBackup()).resolves.toBe(true)
    await expect(cleanupBackups()).resolves.toEqual({ ok: true, removed: ['2026/01/x'] })
    expect(apiRequestMock).toHaveBeenLastCalledWith('POST', '/backups/cleanup')
    apiRequestMock.mockRejectedValue(conflict)
    await expect(cancelBackup()).resolves.toBe(false)
    await expect(cleanupBackups()).resolves.toEqual({ ok: false, message: 'a run is already in progress' })
  })
})
