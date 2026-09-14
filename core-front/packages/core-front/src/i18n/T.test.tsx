import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { SOURCE_LOCALE, useI18nStore } from './i18n-store'
import { translationRegistry } from './registry'
import { T } from './T'

describe('<T>', () => {
  afterEach(() => {
    translationRegistry.clear()
    useI18nStore.setState({ locale: SOURCE_LOCALE, enabledLocales: [] })
  })

  it('renders server-computed text through the client-side catalog', () => {
    translationRegistry.register({ locale: 'fr', module: 'shell', entries: { List: 'Liste' } })
    useI18nStore.setState({ locale: 'fr', enabledLocales: ['fr'] })
    render(<span>{<T text="List" />}</span>)
    expect(screen.getByText('Liste')).toBeInTheDocument()
  })

  it('falls back to the source text and follows locale switches', () => {
    translationRegistry.register({ locale: 'fr', module: 'shell', entries: { List: 'Liste' } })
    render(<span>{<T text="List" />}</span>)
    expect(screen.getByText('List')).toBeInTheDocument()
    act(() => useI18nStore.getState().setLocale('fr'))
    expect(screen.getByText('Liste')).toBeInTheDocument()
  })
})
