import { create } from 'zustand'

// Session-only "records of this entity changed via a host action" signal —
// the event-driven counterpart to recently-changed-store.ts's per-id badge
// marker. A header button handler (header-button-actions.ts) mutates another
// entity through relationOps/attachment clients OUTSIDE the mutated widget's
// own fetch effect (e.g. propertymanagement.generateRentReceipt creates a
// property_management_rent_receipt row the property form's own
// RelationListWidget has no way to know about) — bump(entity) after such a
// mutation, and any mounted widget whose own fetch effect depends on
// bumps[entity] re-fetches. No polling, no full page/router refresh: only
// the widgets actually showing that entity's data re-run their own fetch.
export interface EntityRefreshState {
  bumps: Readonly<Record<string, number>>
  bump: (entity: string) => void
}

export const useEntityRefreshStore = create<EntityRefreshState>((set, get) => ({
  bumps: {},
  bump: (entity) => set({ bumps: { ...get().bumps, [entity]: (get().bumps[entity] ?? 0) + 1 } }),
}))
