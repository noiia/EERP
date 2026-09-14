'use client'
import { useMemo, type ReactNode } from 'react'
import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider } from '@mui/material/styles'
import { buildAppTheme, useUiStore } from '@eerp/core-front'

// Applies the MUI theme built from the user's brand palette + mode, both held in the
// persisted `useUiStore`. A Client Component because it subscribes to that store: when
// the user edits a color in Settings → Appearance, the theme rebuilds and the whole
// app re-themes live. On the server (and the first client paint, before localStorage
// rehydrates) the store holds DEFAULT_PALETTE, so SSR and the default UI agree.
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const palette = useUiStore((s) => s.palette)
  const mode = useUiStore((s) => s.theme)
  const theme = useMemo(() => buildAppTheme(palette, mode), [palette, mode])

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  )
}
