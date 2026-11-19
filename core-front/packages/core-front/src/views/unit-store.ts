import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// The workspace's unit system (Settings → Units), client mirror — seeded by
// the shell's LocaleSync from GET /me/preferences' unit_system, persisted so a
// reload doesn't flash metric. Distances (geo widgets, Distance column) read it.

export type UnitSystem = 'metric' | 'imperial'

export interface UnitState {
  system: UnitSystem
  setSystem: (system: UnitSystem) => void
}

export const useUnitStore = create<UnitState>()(
  persist((set) => ({ system: 'metric', setSystem: (system) => set({ system }) }), {
    name: 'eerp-units',
    version: 1,
  }),
)
