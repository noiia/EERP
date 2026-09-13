import { create } from 'zustand'

// Session-only "ids of the list the user last browsed", per entity — lets a
// form's </> navigator (renderers.tsx's FormListNav) step through the SAME
// filtered/searched/grouped order List/Kanban/Calendar just showed, without a
// round trip back to the list view. Same shape as entity-refresh-store.ts:
// no persistence, no server round-trip, just a live mirror TreeRenderer keeps
// in sync with its own `liveRecords` on every filter/search/drag change.
export interface ListNavState {
  ids: Readonly<Record<string, string[]>>
  setIds: (entity: string, ids: string[]) => void
}

export const useListNavStore = create<ListNavState>((set, get) => ({
  ids: {},
  setIds: (entity, ids) => set({ ids: { ...get().ids, [entity]: ids } }),
}))
