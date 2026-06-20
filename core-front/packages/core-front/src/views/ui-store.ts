import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Cross-cutting UI state, persisted to localStorage so preferences survive reloads.
// Pure interaction state — no data, no session secrets.

export type ThemeMode = 'light' | 'dark'

export interface UiState {
  theme: ThemeMode
  sidebarOpen: boolean
  lastRoute: string | null
  setTheme: (theme: ThemeMode) => void
  toggleSidebar: () => void
  setSidebar: (open: boolean) => void
  setLastRoute: (route: string | null) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'light',
      sidebarOpen: true,
      lastRoute: null,
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebar: (sidebarOpen) => set({ sidebarOpen }),
      setLastRoute: (lastRoute) => set({ lastRoute }),
    }),
    { name: 'eerp-ui' },
  ),
)
