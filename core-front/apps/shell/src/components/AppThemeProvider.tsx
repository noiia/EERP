'use client'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider } from '@mui/material/styles'
import { buildAppTheme, useUiStore } from '@eerp/core-front'
import { writeThemeCookie, type InitialTheme } from '@/lib/theme-cookie'

// Applies the MUI theme built from the user's brand palette + mode, held in the
// persisted `useUiStore`: editing a color or the mode in Settings re-themes the app
// live. The server can't read that store (it's the browser's localStorage), so the
// root layout passes `initial` — the theme the client last mirrored into the
// eerp_theme cookie. The server render and the client's first (hydration) render
// both use it, so the page arrives in the right theme with no light flash; once
// mounted, the store takes over, and every change is written back to the cookie.
export function AppThemeProvider({ initial, children }: { initial?: InitialTheme | null; children: ReactNode }) {
  const storePalette = useUiStore((s) => s.palette)
  const storeMode = useUiStore((s) => s.theme)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const palette = mounted || !initial ? storePalette : initial.palette
  const mode = mounted || !initial ? storeMode : initial.mode
  const theme = useMemo(() => buildAppTheme(palette, mode), [palette, mode])

  // Keep the cookie in step with the store (also seeds it for users whose choice
  // predates the cookie), so the next page load renders server-side in this theme.
  useEffect(() => {
    if (mounted) writeThemeCookie(storeMode, storePalette)
  }, [mounted, storeMode, storePalette])

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline enableColorScheme />
      {children}
    </ThemeProvider>
  )
}
