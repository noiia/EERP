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

  it('ships Account as a default section, linked from the hub', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/account')).toBe(true)
    render(<SettingsHub />)
    expect(screen.getByRole('link', { name: /^account/i })).toHaveAttribute(
      'href',
      '/settings/account',
    )
  })

  it('ships Translations as a default section, linked from the hub', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/translations')).toBe(true)
    render(<SettingsHub />)
    expect(screen.getByRole('link', { name: /translations/i })).toHaveAttribute(
      'href',
      '/settings/translations',
    )
  })

  it('ships Views as a default section, linked from the hub', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/views')).toBe(true)
    render(<SettingsHub />)
    expect(screen.getByRole('link', { name: /^views/i })).toHaveAttribute(
      'href',
      '/settings/views',
    )
  })

  it('ships Users as a default section, linked from the hub', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/users')).toBe(true)
    render(<SettingsHub />)
    expect(screen.getByRole('link', { name: /^users/i })).toHaveAttribute(
      'href',
      '/settings/users',
    )
  })

  it('ships Developer as a default section, linked from the hub', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.path === '/settings/developer')).toBe(true)
    render(<SettingsHub />)
    expect(screen.getByRole('link', { name: /^developer/i })).toHaveAttribute(
      'href',
      '/settings/developer',
    )
  })
})
