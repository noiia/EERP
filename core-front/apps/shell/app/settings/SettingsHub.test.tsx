import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import SettingsHub, { SETTINGS_SECTIONS } from './SettingsHub'

// SettingsPage is an async, auth-gated Server Component; its rendering surface is the
// pure <SettingsHub>, which is what we unit-test here (the redirect path is covered by
// the requireAuth guard).

describe('SettingsHub', () => {
  it('lists the settings sections as links', () => {
    render(<SettingsHub />)
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /appearance/i })
    expect(link).toHaveAttribute('href', '/settings/appearance')
  })

  it('ships Appearance as a default section', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/appearance')).toBe(true)
  })
})
