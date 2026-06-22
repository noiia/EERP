import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_PALETTE, type BrandColorKey, type ThemePalette } from './palette'

// Cross-cutting UI state, persisted to localStorage so preferences survive reloads.
// Pure interaction state — no data, no session secrets. The theme palette lives here
// (not on the server) because it is a per-user UI preference; `buildAppTheme` turns it
// into the MUI theme the shell's <AppThemeProvider> applies (CONVENTIONS.md — the
// client owns cross-cutting UI: theme, sidebar, last route).

export type ThemeMode = 'light' | 'dark'

export interface UiState {
  theme: ThemeMode
  /** Brand colors driving the MUI theme; user-editable in Settings → Appearance. */
  palette: ThemePalette
  sidebarOpen: boolean
  lastRoute: string | null
  setTheme: (theme: ThemeMode) => void
  /** Override a single brand color (live theming). */
  setPaletteColor: (key: BrandColorKey, value: string) => void
  /** Replace the whole palette at once. */
  setPalette: (palette: ThemePalette) => void
  /** Restore the default brand palette. */
  resetPalette: () => void
  toggleSidebar: () => void
  setSidebar: (open: boolean) => void
  setLastRoute: (route: string | null) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'light',
      palette: DEFAULT_PALETTE,
      sidebarOpen: true,
      lastRoute: null,
      setTheme: (theme) => set({ theme }),
      setPaletteColor: (key, value) =>
        set((state) => ({ palette: { ...state.palette, [key]: value } })),
      setPalette: (palette) => set({ palette }),
      resetPalette: () => set({ palette: DEFAULT_PALETTE }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebar: (sidebarOpen) => set({ sidebarOpen }),
      setLastRoute: (lastRoute) => set({ lastRoute }),
    }),
    {
      name: 'eerp-ui',
      version: 1,
      // Older persisted state (pre-palette) merges with no `palette` key; fall back to
      // the default so the theme always has a complete palette.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<UiState>
        return {
          ...current,
          ...saved,
          palette: { ...DEFAULT_PALETTE, ...(saved.palette ?? {}) },
        }
      },
    },
  ),
)
