import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { translationRegistry, useI18nStore } from '@eerp/core-front'
import TranslationSettings from './TranslationSettings'

// The generated manifest is aliased to an empty stub in vitest.config.ts (it is a
// gitignored build artefact); tests seed the registry directly instead, so they
// control exactly which catalogs exist.

describe('TranslationSettings', () => {
  beforeEach(() => {
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

  it('adds a translation, making it selectable as the language', () => {
    render(<TranslationSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Add fr' }))
    expect(useI18nStore.getState().enabledLocales).toEqual(['fr'])

    fireEvent.mouseDown(screen.getByLabelText('Language'))
    const listbox = within(screen.getByRole('listbox'))
    expect(listbox.getByText('français')).toBeInTheDocument()
    expect(listbox.queryByText('Deutsch')).not.toBeInTheDocument()

    fireEvent.click(listbox.getByText('français'))
    expect(useI18nStore.getState().locale).toBe('fr')
  })

  it('removes an enabled translation and falls back to the source language', () => {
    useI18nStore.setState({ locale: 'fr', enabledLocales: ['fr'] })
    render(<TranslationSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove fr' }))
    expect(useI18nStore.getState().enabledLocales).toEqual([])
    expect(useI18nStore.getState().locale).toBeNull()
  })

  it('ignores persisted locales whose catalogs no longer ship', () => {
    useI18nStore.setState({ locale: 'xx', enabledLocales: ['xx'] })
    render(<TranslationSettings />)
    // 'xx' is not in the pool: the selector falls back to the source entry.
    expect(screen.getByLabelText('Language')).toHaveTextContent('English (source)')
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
