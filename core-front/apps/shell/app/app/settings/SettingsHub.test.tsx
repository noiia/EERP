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
    const link = screen.getByRole('link', { name: /global settings/i })
    expect(link).toHaveAttribute('href', '/app/settings/appearance')
  })

  it('shows each service\'s build version under the sections, unanswered ones as unavailable', () => {
    const { rerender } = render(
      <SettingsHub
        versions={[
          { name: 'core-front', label: 'Frontend', version: '0.103.0' },
          { name: 'core', label: 'Core', version: '0.102.0' },
          { name: 'pdf-service', label: 'PDF worker', version: null },
        ]}
      />,
    )
    expect(screen.getByTestId('version-core-front')).toHaveTextContent('Frontend 0.103.0')
    expect(screen.getByTestId('version-core')).toHaveTextContent('Core 0.102.0')
    expect(screen.getByTestId('version-pdf-service')).toHaveTextContent('PDF worker unavailable')
    rerender(<SettingsHub />)
    expect(screen.queryByTestId('app-versions')).toBeNull()
  })

  it('ships Global settings (Colors + Reports, at the stable /settings/appearance path) as a default section', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/appearance')).toBe(true)
  })

  it('ships Account as a default section, linked from the hub', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/account')).toBe(true)
    render(<SettingsHub />)
    expect(screen.getByRole('link', { name: /^account/i })).toHaveAttribute(
      'href',
      '/app/settings/account',
    )
  })

  it('ships Company as a default section, linked from the hub', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/company')).toBe(true)
    render(<SettingsHub />)
    expect(screen.getByRole('link', { name: /^company/i })).toHaveAttribute('href', '/app/settings/company')
  })

  it('ships Translations as a default section, linked from the hub', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/translations')).toBe(true)
    render(<SettingsHub />)
    expect(screen.getByRole('link', { name: /translations/i })).toHaveAttribute(
      'href',
      '/app/settings/translations',
    )
  })

  it('ships Apps as a default section, linked from the hub (folds in the old Views/Formats pages)', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/apps')).toBe(true)
    render(<SettingsHub />)
    expect(screen.getByRole('link', { name: /^apps/i })).toHaveAttribute('href', '/app/settings/apps')
  })

  it('no longer ships the standalone Views/Formats sections', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/views')).toBe(false)
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/formats')).toBe(false)
  })

  it('ships Users as a default section, linked from the hub', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/users')).toBe(true)
    render(<SettingsHub />)
    expect(screen.getByRole('link', { name: /^users/i })).toHaveAttribute(
      'href',
      '/app/settings/users',
    )
  })

  it('ships Developer as a default section, linked from the hub', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/developer')).toBe(true)
    render(<SettingsHub />)
    expect(screen.getByRole('link', { name: /^developer/i })).toHaveAttribute(
      'href',
      '/app/settings/developer',
    )
  })

  it('ships Website as a section, linked from the hub', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/website')).toBe(true)
    render(<SettingsHub />)
    expect(screen.getByRole('link', { name: /^website/i })).toHaveAttribute('href', '/app/settings/website')
  })
})
