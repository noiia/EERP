'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Server Actions for the Event app's workspace settings (Go: GET|PUT
// /api/v1/settings/events, modules/event/reminders.go).

export interface EventSettings {
  /** Hours before the start a confirmed booking gets its reminder email; 0 = none. */
  reminder_hours: number
  /** How long a waiting-list offer stays claimable, in hours (1–168). */
  waitlist_claim_hours: number
}

export type SaveResult = { ok: true } | { ok: false; message: string }

export async function getEventSettings(): Promise<EventSettings | null> {
  try {
    return await apiRequest<EventSettings>('GET', '/settings/events')
  } catch {
    return null
  }
}

export async function saveEventSettings(s: EventSettings): Promise<SaveResult> {
  try {
    await apiRequest('PUT', '/settings/events', s)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : '' }
  }
}

// The caller's private staff calendar feed (Go: /api/v1/me/event_feed).

export async function getMyEventFeed(): Promise<{ enabled: boolean } | null> {
  try {
    return await apiRequest<{ enabled: boolean }>('GET', '/me/event_feed')
  } catch {
    return null
  }
}

/** A new secret link (the previous one stops working); `path` is shown once. */
export async function createMyEventFeed(): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  try {
    return { ok: true, path: (await apiRequest<{ path: string }>('POST', '/me/event_feed')).path }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : '' }
  }
}

export async function revokeMyEventFeed(): Promise<boolean> {
  try {
    await apiRequest('DELETE', '/me/event_feed')
    return true
  } catch {
    return false
  }
}
