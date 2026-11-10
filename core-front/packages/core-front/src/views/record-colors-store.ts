import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { useSessionStore } from './session-store'

// The colors last read for each record (useRecordColors), kept for the tab's
// session — sessionStorage, so a reload draws them at once — and handed out
// immediately on the next display while useRecordColors re-reads them in the
// background (stale-while-revalidate: another user's change still shows up).
// Wiped on logout and never served to another user (`owner`).

/** Per color config (entity, junction, columns), per record id: its colors. */
type Entries = Record<string, Record<string, string[]>>

/** Records kept per color config; the oldest go first past it. */
export const RECORD_COLORS_CAP = 5000

interface RecordColorsState {
  owner: string | null
  entries: Entries
  /** Stores the colors read for `ids` (an id absent from `colors` has none). */
  put: (config: string, ids: string[], colors: Map<string, string[]>) => void
  clear: () => void
}

const currentUser = () => useSessionStore.getState().identity?.userId ?? null

export const useRecordColorsStore = create<RecordColorsState>()(
  persist(
    (set, get) => ({
      owner: null,
      entries: {},
      put: (config, ids, colors) => {
        const user = currentUser()
        const state = get()
        const previous = state.owner === user ? (state.entries[config] ?? {}) : {}
        const next: Record<string, string[]> = { ...previous }
        for (const id of ids) {
          delete next[id] // re-inserted last: insertion order is the age order
          next[id] = colors.get(id) ?? []
        }
        const keys = Object.keys(next)
        for (const id of keys.slice(0, Math.max(0, keys.length - RECORD_COLORS_CAP))) delete next[id]
        set({
          owner: user,
          entries: { ...(state.owner === user ? state.entries : {}), [config]: next },
        })
      },
      clear: () => set({ owner: null, entries: {} }),
    }),
    { name: 'eerp-record-colors', storage: createJSONStorage(() => sessionStorage) },
  ),
)

/** The cached colors of `ids` (only those cached, only for the current user). */
export function cachedColors(config: string, ids: string[]): Map<string, string[]> {
  const { owner, entries } = useRecordColorsStore.getState()
  const out = new Map<string, string[]>()
  if (owner === null || owner !== currentUser()) return out
  const byId = entries[config] ?? {}
  for (const id of ids) if (byId[id]?.length) out.set(id, byId[id])
  return out
}

// Logout (or another user signing in) drops everything cached.
useSessionStore.subscribe((s) => {
  const { owner, clear } = useRecordColorsStore.getState()
  if (owner !== null && s.identity?.userId !== owner) clear()
})
