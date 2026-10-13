'use server'
import { revalidateTag } from 'next/cache'
import { apiRequest } from '@eerp/core-front/server'
import type { AppNotification } from '@eerp/core-front'

// The bell's BFF: the caller's own feed and read marks (Go scopes both to the
// session's user — internal/notify). Never cached: per-user data.

export async function loadNotifications(): Promise<{ items: AppNotification[]; unread: number } | null> {
  try {
    const res = await apiRequest<{ data?: AppNotification[]; unread?: number }>('GET', '/notifications')
    return { items: res.data ?? [], unread: res.unread ?? 0 }
  } catch {
    return null
  }
}

export async function markNotificationsRead(ids: string[] | 'all'): Promise<void> {
  try {
    await apiRequest('POST', '/notifications/read', ids === 'all' ? { all: true } : { ids })
  } catch {
    // Best effort: the badge reconciles on the next feed read.
  }
}

/** After a background full seed: drop the cached list pages of what Go wrote. */
export async function revalidateSeededEntities(entities: string[]): Promise<void> {
  for (const e of entities) if (/^[a-z0-9_]+$/.test(e)) revalidateTag(e, 'max')
}
