'use client'
import { useSyncExternalStore } from 'react'
import type { SiteLocalization } from './public-api'

// The client mirror of the visitor's site preferences. Kept apart from
// site-prefs.ts because useSyncExternalStore is client-only, and the server
// (site layout, Server Actions) imports site-prefs.ts.

export interface SitePrefsState extends Pick<SiteLocalization, 'base' | 'rates'> {
  currency: string
  dateFormat: string | null
}

// A module-level store (no dependency): SitePrefsSync writes it, blocks read it.
let state: SitePrefsState = { base: '', rates: {}, currency: '', dateFormat: null }
const listeners = new Set<() => void>()

export const sitePrefsStore = {
  get: (): SitePrefsState => state,
  set(patch: Partial<SitePrefsState>) {
    state = { ...state, ...patch }
    listeners.forEach((l) => l())
  },
  subscribe(l: () => void) {
    listeners.add(l)
    return () => { listeners.delete(l) }
  },
}

/** The current site preferences; re-renders on change. */
export function useSitePrefs(): SitePrefsState {
  return useSyncExternalStore(sitePrefsStore.subscribe, sitePrefsStore.get, sitePrefsStore.get)
}
