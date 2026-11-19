import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { useTheme } from '@mui/material/styles'
import { DEFAULT_PALETTE, useUiStore } from '@eerp/core-front'
import { AppThemeProvider } from './AppThemeProvider'

// Probe child: surfaces the active MUI theme's primary color so we can assert the
// provider built the theme from the store's palette.
function ThemeProbe() {
  const theme = useTheme()
  return (
    <>
      <span data-testid="primary">{theme.palette.primary.main}</span>
      <span data-testid="mode">{theme.palette.mode}</span>
    </>
  )
}

describe('AppThemeProvider', () => {
  beforeEach(() => {
    useUiStore.getState().resetPalette()
    useUiStore.getState().setTheme('light')
  })

  it('themes children from the store palette', () => {
    render(
      <AppThemeProvider>
        <ThemeProbe />
      </AppThemeProvider>,
    )
    expect(screen.getByTestId('primary')).toHaveTextContent(DEFAULT_PALETTE.goBlue)
  })

  it('reflects a palette edit', () => {
    useUiStore.getState().setPaletteColor('goBlue', '#abcdef')
    render(
      <AppThemeProvider>
        <ThemeProbe />
      </AppThemeProvider>,
    )
    expect(screen.getByTestId('primary')).toHaveTextContent('#abcdef')
  })

  it('renders on the server with the theme the cookie carries, not the store default', () => {
    // The server's store never sees the browser's localStorage: it holds the defaults.
    const html = renderToString(
      <AppThemeProvider initial={{ mode: 'dark', palette: DEFAULT_PALETTE }}>
        <ThemeProbe />
      </AppThemeProvider>,
    )
    expect(html).toContain('>dark<')
    // The palette too (light mode: dark mode lightens the primary for contrast).
    const custom = renderToString(
      <AppThemeProvider initial={{ mode: 'light', palette: { ...DEFAULT_PALETTE, goBlue: '#123456' } }}>
        <ThemeProbe />
      </AppThemeProvider>,
    )
    expect(custom).toContain('#123456')
  })

  it('stores the theme in the cookie the server reads, on load and on every change', () => {
    render(
      <AppThemeProvider>
        <ThemeProbe />
      </AppThemeProvider>,
    )
    expect(document.cookie).toContain('eerp_theme=')
    act(() => useUiStore.getState().setTheme('dark'))
    expect(screen.getByTestId('mode')).toHaveTextContent('dark')
    expect(decodeURIComponent(document.cookie)).toContain('"mode":"dark"')
  })
})
