'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Server Actions for Settings → Developer → Automated backups (Go:
// /api/v1/backups, internal/backup; docs/adr/ADR-044-automated-backups.md).

export interface BackupSettings {
  enabled: boolean
  frequency: 'hours' | 'daily' | 'weekly' | 'monthly'
  every_hours: number
  /** HH:MM, local to `timezone`. */
  time: string
  timezone: string
  /** 0 = Sunday. */
  weekdays: number[] | null
  month_day: number
  databases: string[] | null
  include_s3: boolean
  retention_days: number
  updated_at?: string
}

export interface BackupDatabaseResult {
  name: string
  file: string
  size: number
  sha256: string
  s3_objects: number
}

export interface BackupRun {
  id: string
  trigger: 'schedule' | 'manual'
  slot?: string
  started_at: string
  finished_at?: string
  status: 'running' | 'success' | 'failed' | 'cancelled'
  current?: string
  error?: string
  path?: string
  databases: BackupDatabaseResult[] | null
  warnings?: string[]
  total_bytes: number
}

export interface BackupStatus {
  settings: BackupSettings
  backup_dir: string
  running: BackupRun | null
  next_run: string | null
  last_success: string | null
  last_failure: { at: string; error: string } | null
  local_count: number
  local_bytes: number
}

export type BackupResult = { ok: true } | { ok: false; message: string }

const message = (e: unknown) => (e instanceof ApiError ? e.message : '')

/** Null when automated backups aren't configured (no backup_dir) or not allowed. */
export async function getBackups(): Promise<BackupStatus | null> {
  try {
    return await apiRequest<BackupStatus>('GET', '/backups')
  } catch {
    return null
  }
}

export async function saveBackupSettings(s: BackupSettings): Promise<BackupResult> {
  try {
    await apiRequest('PUT', '/backups', s)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: message(e) }
  }
}

export async function getBackupDatabases(): Promise<string[]> {
  try {
    return (await apiRequest<{ data: string[] }>('GET', '/backups/databases')).data ?? []
  } catch {
    return []
  }
}

export async function getBackupRuns(): Promise<BackupRun[]> {
  try {
    return (await apiRequest<{ data: BackupRun[] }>('GET', '/backups/runs')).data ?? []
  } catch {
    return []
  }
}

export async function runBackupNow(): Promise<BackupResult> {
  try {
    await apiRequest('POST', '/backups/run')
    return { ok: true }
  } catch (e) {
    return { ok: false, message: message(e) }
  }
}

export async function cancelBackup(): Promise<boolean> {
  try {
    return (await apiRequest<{ cancelled: boolean }>('POST', '/backups/cancel')).cancelled
  } catch {
    return false
  }
}

export async function cleanupBackups(): Promise<{ ok: true; removed: string[] } | { ok: false; message: string }> {
  try {
    return { ok: true, removed: (await apiRequest<{ removed: string[] }>('POST', '/backups/cleanup')).removed ?? [] }
  } catch (e) {
    return { ok: false, message: message(e) }
  }
}
