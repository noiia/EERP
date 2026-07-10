import { create } from 'zustand'

// Session-only "this record was just mutated by a host action" marker (docs/
// roadmaps/app-store.md, Phase 4: the App Store's catalog badges any row the
// Activate/Deactivate button touched THIS session). Deliberately NOT
// persisted (no zustand/middleware `persist`) — it must clear on reload, the
// same way the notice itself ("takes effect after the next rebuild") stops
// being relevant once you've actually reloaded. Generic on purpose: any
// future action that mutates a record OUTSIDE the generic form commit (the
// same shape as Activate/Deactivate — decision #6 of the roadmap) can mark
// it here and a catalog row picks up the badge with no wiring of its own.

export interface RecentlyChangedState {
  ids: ReadonlySet<string>
  markChanged: (id: string) => void
}

export const useRecentlyChangedStore = create<RecentlyChangedState>((set, get) => ({
  ids: new Set(),
  markChanged: (id) => set({ ids: new Set(get().ids).add(id) }),
}))
