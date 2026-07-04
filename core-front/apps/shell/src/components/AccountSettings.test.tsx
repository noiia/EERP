import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { translationRegistry, useI18nStore } from '@eerp/core-front'
import type { LocalePreferences } from '@/lib/locale'

// The preference save is a Server Action; the component only sees its result object.
const setMyPreferredLocaleMock = vi.fn()
vi.mock('@/lib/preferences', () => ({
  setMyPreferredLocale: (locale: string | null) => setMyPreferredLocaleMock(locale),
}))

import AccountSettings from './AccountSettings'

function prefs(preferred: string | null, fallback: string | null): LocalePreferences {
  return { preferred_locale: preferred, default_locale: fallback }
}

describe('AccountSettings', () => {
  beforeEach(() => {
    setMyPreferredLocaleMock.mockReset()
    setMyPreferredLocaleMock.mockResolvedValue({ ok: true })
    translationRegistry.register({ module: 'crm', locale: 'fr', entries: { Name: 'Nom' } })
    translationRegistry.register({ module: 'crm', locale: 'de', entries: { Name: 'Name' } })
    useI18nStore.setState({ locale: null, enabledLocales: ['fr'] })
  })

  afterEach(() => {
    translationRegistry.clear()
    useI18nStore.setState({ locale: null, enabledLocales: [] })
  })

  it('offers workspace default, source, and the enabled translations', () => {
    render(<AccountSettings preferences={prefs(null, 'de')} />)

    fireEvent.mouseDown(screen.getByLabelText('Display language'))
    const listbox = within(screen.getByRole('listbox'))
    expect(listbox.getByText(/Workspace default — Deutsch/)).toBeInTheDocument()
    expect(listbox.getByText('English (source)')).toBeInTheDocument()
    expect(listbox.getByText('français')).toBeInTheDocument()
    // 'de' ships but was never enabled in Settings → Translations.
    expect(listbox.queryByText('Deutsch', { exact: true })).not.toBeInTheDocument()
  })

  it('saves a picked language and applies it immediately', async () => {
    render(<AccountSettings preferences={prefs(null, null)} />)

    fireEvent.mouseDown(screen.getByLabelText('Display language'))
    fireEvent.click(within(screen.getByRole('listbox')).getByText('français'))

    await waitFor(() => expect(setMyPreferredLocaleMock).toHaveBeenCalledWith('fr'))
    expect(useI18nStore.getState().locale).toBe('fr')
  })

  it('"Workspace default" saves null and falls back to the tenant default', async () => {
    useI18nStore.setState({ locale: 'fr', enabledLocales: ['fr'] })
    render(<AccountSettings preferences={prefs('fr', 'de')} />)

    fireEvent.mouseDown(screen.getByLabelText('Display language'))
    fireEvent.click(within(screen.getByRole('listbox')).getByText(/Workspace default/))

    await waitFor(() => expect(setMyPreferredLocaleMock).toHaveBeenCalledWith(null))
    // The inherited default 'de' ships, so it becomes the active locale.
    expect(useI18nStore.getState().locale).toBe('de')
  })

  it('"English (source)" saves the reserved "source" value and clears the locale', async () => {
    useI18nStore.setState({ locale: 'fr', enabledLocales: ['fr'] })
    render(<AccountSettings preferences={prefs('fr', 'fr')} />)

    fireEvent.mouseDown(screen.getByLabelText('Display language'))
    fireEvent.click(within(screen.getByRole('listbox')).getByText('English (source)'))

    await waitFor(() => expect(setMyPreferredLocaleMock).toHaveBeenCalledWith('source'))
    expect(useI18nStore.getState().locale).toBeNull()
  })

  it('reverts the pick and surfaces the backend message when the save fails', async () => {
    setMyPreferredLocaleMock.mockResolvedValue({ ok: false, message: 'Validation failed' })
    render(<AccountSettings preferences={prefs(null, null)} />)

    fireEvent.mouseDown(screen.getByLabelText('Display language'))
    fireEvent.click(within(screen.getByRole('listbox')).getByText('français'))

    expect(await screen.findByText('Validation failed')).toBeInTheDocument()
    expect(screen.getByLabelText('Display language')).toHaveTextContent(/Workspace default/)
    expect(useI18nStore.getState().locale).toBeNull()
  })

  it('renders read-only with a warning when preferences could not be read', () => {
    render(<AccountSettings preferences={null} />)
    expect(screen.getByLabelText('Display language')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument()
  })
})
