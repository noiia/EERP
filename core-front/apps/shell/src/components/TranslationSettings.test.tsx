import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { translationRegistry, useI18nStore } from '@eerp/core-front'

// The workspace-default save is a Server Action; the component only sees its
// result object.
const saveDefaultLocaleMock = vi.fn()
vi.mock('@/lib/preferences', () => ({
  setDefaultLocale: (locale: string | null) => saveDefaultLocaleMock(locale),
}))

import TranslationSettings from './TranslationSettings'

// The generated manifest is aliased to an empty stub in vitest.config.ts (it is a
// gitignored build artefact); tests seed the registry directly instead, so they
// control exactly which catalogs exist.

describe('TranslationSettings', () => {
  beforeEach(() => {
    saveDefaultLocaleMock.mockReset()
    saveDefaultLocaleMock.mockResolvedValue({ ok: true })
    translationRegistry.registerTemplate({ module: 'crm', keys: ['Name', 'Email', 'Status'] })
    translationRegistry.register({
      locale: 'fr',
      module: 'crm',
      entries: { Name: 'Nom', Email: 'Courriel' },
    })
    translationRegistry.register({ locale: 'de', module: 'shell', entries: { Name: 'Name' } })
  })

  afterEach(() => {
    translationRegistry.clear()
    useI18nStore.setState({ locale: null, enabledLocales: [] })
  })

  it('lists every discovered translation with coverage and source modules', () => {
    render(<TranslationSettings />)
    expect(screen.getByRole('heading', { name: 'Translations' })).toBeInTheDocument()
    expect(screen.getByText('français')).toBeInTheDocument()
    expect(screen.getByText(/2 \/ 3 strings · from crm/)).toBeInTheDocument()
    expect(screen.getByText(/1 \/ 3 strings · from shell/)).toBeInTheDocument()
  })

  it('adds and removes translations from the enabled set', () => {
    render(<TranslationSettings canEditDefault />)
    fireEvent.click(screen.getByRole('button', { name: 'Add fr' }))
    expect(useI18nStore.getState().enabledLocales).toEqual(['fr'])

    fireEvent.click(screen.getByRole('button', { name: 'Remove fr' }))
    expect(useI18nStore.getState().enabledLocales).toEqual([])
  })

  it('removing the active translation falls back to the source language', () => {
    useI18nStore.setState({ locale: 'fr', enabledLocales: ['fr'] })
    render(<TranslationSettings canEditDefault />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove fr' }))
    expect(useI18nStore.getState().locale).toBeNull()
  })

  describe('workspace default language', () => {
    it('offers the whole build-time pool and persists the pick server-side', async () => {
      render(<TranslationSettings canEditDefault preferredLocale="de" />)

      fireEvent.mouseDown(screen.getByLabelText('Default language'))
      const listbox = within(screen.getByRole('listbox'))
      // The default offers everything shipped, independent of the enabled set.
      expect(listbox.getByText('Deutsch')).toBeInTheDocument()
      fireEvent.click(listbox.getByText('français'))

      await waitFor(() => expect(saveDefaultLocaleMock).toHaveBeenCalledWith('fr'))
      // The caller has their own preference ('de') — their active locale is untouched.
      expect(useI18nStore.getState().locale).toBeNull()
    })

    it('applies the new default immediately to a caller who inherits it', async () => {
      render(<TranslationSettings canEditDefault preferredLocale={null} />)

      fireEvent.mouseDown(screen.getByLabelText('Default language'))
      fireEvent.click(within(screen.getByRole('listbox')).getByText('français'))

      await waitFor(() => expect(useI18nStore.getState().locale).toBe('fr'))
      expect(useI18nStore.getState().enabledLocales).toContain('fr')
    })

    it('reverts the pick and surfaces the backend message when the save fails', async () => {
      saveDefaultLocaleMock.mockResolvedValue({ ok: false, message: 'Missing permission' })
      render(<TranslationSettings canEditDefault defaultLocale="de" preferredLocale={null} />)

      fireEvent.mouseDown(screen.getByLabelText('Default language'))
      fireEvent.click(within(screen.getByRole('listbox')).getByText('français'))

      expect(await screen.findByText('Missing permission')).toBeInTheDocument()
      expect(screen.getByLabelText('Default language')).toHaveTextContent('Deutsch')
      expect(useI18nStore.getState().locale).toBeNull()
    })

    it('is read-only without settings:i18n:write', () => {
      render(<TranslationSettings defaultLocale="fr" />)
      expect(screen.getByLabelText('Default language')).toHaveAttribute('aria-disabled', 'true')
      expect(screen.getByText(/requires the settings:i18n:write permission/)).toBeInTheDocument()
    })

    it('shows the source language when the stored default no longer ships', () => {
      render(<TranslationSettings canEditDefault defaultLocale="xx" />)
      expect(screen.getByLabelText('Default language')).toHaveTextContent('English (source)')
    })
  })

  it('shows an empty state when no module ships translations', () => {
    translationRegistry.clear()
    render(<TranslationSettings />)
    expect(screen.getByText(/No translations found/)).toBeInTheDocument()
  })

  it('renders itself in the active language', () => {
    translationRegistry.register({
      locale: 'fr',
      module: 'shell',
      entries: { Translations: 'Traductions' },
    })
    useI18nStore.setState({ locale: 'fr', enabledLocales: ['fr'] })
    render(<TranslationSettings />)
    expect(screen.getByRole('heading', { name: 'Traductions' })).toBeInTheDocument()
  })

  describe('export', () => {
    // jsdom implements neither createObjectURL nor a navigating click; capture both.
    let blobs: Blob[]
    let filenames: string[]

    beforeEach(() => {
      blobs = []
      filenames = []
      URL.createObjectURL = vi.fn((blob: Blob) => {
        blobs.push(blob)
        return `blob:${blobs.length}`
      })
      URL.revokeObjectURL = vi.fn()
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        filenames.push(this.download)
      })
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('downloads one .po per module for the selected target language', async () => {
      render(<TranslationSettings />)

      // Pick French as the target (default is the first discovered locale, 'de').
      fireEvent.mouseDown(screen.getByLabelText('Target language'))
      fireEvent.click(within(screen.getByRole('listbox')).getByText(/français \(fr\)/))
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))

      // Every module is pre-selected: one file per contributing module (crm ships
      // the template, shell a catalog).
      expect(filenames).toEqual(['crm-fr.po', 'shell-fr.po'])

      const crmPo = await blobs[0].text()
      // Existing fr translations pre-filled; untranslated template keys left blank.
      expect(crmPo).toContain('"Language: fr\\n"')
      expect(crmPo).toContain('msgid "Name"\nmsgstr "Nom"')
      expect(crmPo).toContain('msgid "Status"\nmsgstr ""')

      // The shell module has no fr catalog here: a blank, translator-ready export.
      const shellPo = await blobs[1].text()
      expect(shellPo).toContain('msgid "Name"\nmsgstr ""')
    })

    it('exports only the modules left selected', async () => {
      render(<TranslationSettings />)

      // Deselect 'shell' in the module multi-select (all modules start checked).
      fireEvent.mouseDown(screen.getByLabelText('Modules'))
      fireEvent.click(within(screen.getByRole('listbox')).getByText('shell'))
      fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })

      fireEvent.mouseDown(screen.getByLabelText('Target language'))
      fireEvent.click(within(screen.getByRole('listbox')).getByText(/français \(fr\)/))
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))

      expect(filenames).toEqual(['crm-fr.po'])
      expect(await blobs[0].text()).toContain('msgid "Name"\nmsgstr "Nom"')
    })

    it('disables Export when no module is selected', () => {
      render(<TranslationSettings />)
      fireEvent.mouseDown(screen.getByLabelText('Modules'))
      const listbox = screen.getByRole('listbox')
      fireEvent.click(within(listbox).getByText('crm'))
      fireEvent.click(within(listbox).getByText('shell'))
      fireEvent.keyDown(listbox, { key: 'Escape' })
      expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
    })

    it('offers suggested languages beyond the discovered ones', () => {
      render(<TranslationSettings />)
      fireEvent.mouseDown(screen.getByLabelText('Target language'))
      const listbox = within(screen.getByRole('listbox'))
      // 'es' ships no catalog — offered anyway so a new translation can start blank.
      expect(listbox.getByText(/español \(es\)/)).toBeInTheDocument()
    })
  })
})
