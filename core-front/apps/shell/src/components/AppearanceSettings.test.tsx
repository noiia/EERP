import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_PALETTE, useUiStore } from '@eerp/core-front'
import AppearanceSettings from './AppearanceSettings'

describe('AppearanceSettings', () => {
  beforeEach(() => {
    useUiStore.getState().resetPalette()
    useUiStore.getState().setTheme('light')
  })

  it('renders an editor for each color labeled by its software role, seeded from the store', () => {
    render(<AppearanceSettings />)
    // Query by heading role: "Primary action" also appears as the preview button label.
    expect(screen.getByRole('heading', { name: 'Primary action' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Headings & navigation bar' })).toBeInTheDocument()
    expect(screen.getByLabelText('Primary action hex')).toHaveValue(DEFAULT_PALETTE.goBlue)
  })

  it('edits a color through the hex field', () => {
    render(<AppearanceSettings />)
    fireEvent.change(screen.getByLabelText('Primary action hex'), { target: { value: '#123456' } })
    expect(useUiStore.getState().palette.goBlue).toBe('#123456')
  })

  it('flags an invalid hex value', () => {
    render(<AppearanceSettings />)
    fireEvent.change(screen.getByLabelText('Headings & navigation bar hex'), {
      target: { value: 'nope' },
    })
    expect(screen.getByText(/enter a hex color/i)).toBeInTheDocument()
  })

  it('toggles dark mode', () => {
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByLabelText('Dark mode'))
    expect(useUiStore.getState().theme).toBe('dark')
  })

  it('resets the palette to defaults', () => {
    useUiStore.getState().setPaletteColor('goBlue', '#000000')
    render(<AppearanceSettings />)
    fireEvent.click(screen.getByRole('button', { name: /reset to defaults/i }))
    expect(useUiStore.getState().palette).toEqual(DEFAULT_PALETTE)
  })
})
