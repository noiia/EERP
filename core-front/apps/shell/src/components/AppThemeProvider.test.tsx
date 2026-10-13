import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useTheme } from '@mui/material/styles'
import { DEFAULT_PALETTE, useUiStore } from '@eerp/core-front'
import { AppThemeProvider } from './AppThemeProvider'

// Probe child: surfaces the active MUI theme's primary color so we can assert the
// provider built the theme from the store's palette.
function ThemeProbe() {
  const theme = useTheme()
  return <span data-testid="primary">{theme.palette.primary.main}</span>
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
})
