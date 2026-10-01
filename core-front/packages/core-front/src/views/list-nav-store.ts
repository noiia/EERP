import { create } from 'zustand'
import type { EntityListOptions } from '../api/list-options'

// Session-only "the list the user last browsed", per entity — lets a form's </>
// navigator (renderers.tsx's FormListNav) step through the SAME filtered/searched/
// grouped order List/Kanban/Calendar just showed, without a round trip back to the
// list view. Same shape as entity-refresh-store.ts: no persistence, just a live
// mirror TreeRenderer keeps in sync with its own `liveRecords`.
export interface ListNav {
  /** The loaded page's ids, in list order. */
  ids: string[]
  /** Position of ids[0] in the whole result set (page × page size). */
  offset: number
  /** Rows matching the active filter — Go's count when server-paged, else ids.length. */
  total: number
  /** Set when server-paged: the filter and page size to fetch the neighboring pages with. */
  paging?: { options?: EntityListOptions; pageSize: number }
}

export interface ListNavState {
  nav: Readonly<Record<string, ListNav>>
  setNav: (entity: string, nav: ListNav) => void
}

export const useListNavStore = create<ListNavState>((set, get) => ({
  nav: {},
  setNav: (entity, nav) => set({ nav: { ...get().nav, [entity]: nav } }),
}))
