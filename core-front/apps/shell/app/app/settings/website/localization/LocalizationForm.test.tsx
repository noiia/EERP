import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

const saveWebsiteLocalization = vi.fn()
vi.mock('@/lib/website-settings', () => ({
  saveWebsiteLocalization: (...a: unknown[]) => saveWebsiteLocalization(...a),
}))

import LocalizationForm, { underpricedCurrencies } from './LocalizationForm'
import type { WebsiteLocalizationView } from '@/lib/website-settings'

describe('underpricedCurrencies', () => {
  it('flags only hand-set rates below the live one', () => {
    expect(underpricedCurrencies({
      currencies: ['USD', 'GBP', 'CHF', 'JPY'],
      overrides: { USD: 1.0, GBP: 0.9, JPY: 150 },
      live: { USD: 1.1, GBP: 0.85 },
    })).toEqual(['USD'])
  })
})

const initial: WebsiteLocalizationView = {
  default_locale: '', default_currency: 'USD', currencies: ['USD', 'JPY'], overrides: {},
  base: 'EUR', live: { USD: 1.0812345678 }, live_date: '2026-11-04',
}

const rate = (code: string) => screen.getByText(code, { selector: 'p' }).parentElement!.querySelector('input')!

describe('LocalizationForm', () => {
  beforeEach(() => saveWebsiteLocalization.mockReset().mockResolvedValue({ ok: true }))

  it('shows each offered currency with its live rate, or says it has none', () => {
    render(<LocalizationForm initial={initial} />)
    expect(screen.getByText('Live rate: 1.081235')).toBeTruthy()
    expect(screen.getByText('No live rate: set one, or the currency is not offered.')).toBeTruthy()
    expect(screen.getByText('EUR')).toBeTruthy()
  })

  it('adds a currency once, by its ISO code (Enter or the button), never the workspace one', () => {
    render(<LocalizationForm initial={initial} />)
    const input = screen.getByLabelText('Add a currency (ISO code)')
    fireEvent.change(input, { target: { value: 'gbp' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('GBP', { selector: 'p' })).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('')
    for (const bad of ['eur', 'usd', 'x1']) {
      fireEvent.change(input, { target: { value: bad } })
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
      expect((input as HTMLInputElement).value).toBe(bad) // refused: kept for correction
    }
  })

  it('warns when a hand-set rate is below the live one, and ignores a non-positive one', () => {
    render(<LocalizationForm initial={initial} />)
    fireEvent.change(rate('USD'), { target: { value: '0,9' } })
    expect(screen.getByText(/below the live rate/)).toBeTruthy()
    fireEvent.change(rate('USD'), { target: { value: '-1' } })
    expect(screen.queryByText(/below the live rate/)).toBeNull()
  })

  it('removing the default currency falls back to the workspace one; saves what is shown', async () => {
    render(<LocalizationForm initial={initial} />)
    fireEvent.change(rate('JPY'), { target: { value: '160' } })
    const row = screen.getByText('USD', { selector: 'p' }).parentElement!
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(saveWebsiteLocalization).toHaveBeenCalledWith({ default_locale: '', default_currency: '', currencies: ['JPY'], overrides: { JPY: 160 } })
  })

  it('picks the default currency and language, and shows Go\'s refusal', async () => {
    saveWebsiteLocalization.mockResolvedValue({ ok: false, message: 'Unknown currency' })
    render(<LocalizationForm initial={initial} />)
    fireEvent.mouseDown(screen.getByLabelText('Default currency'))
    fireEvent.click(await screen.findByRole('option', { name: 'EUR' }))
    fireEvent.mouseDown(screen.getByLabelText('Default language'))
    fireEvent.click(await screen.findByRole('option', { name: /English/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Unknown currency')).toBeTruthy()
    expect(saveWebsiteLocalization.mock.calls[0][0]).toMatchObject({ default_currency: '', default_locale: '' })
  })

  it('falls back to its own message on an unexpected failure', async () => {
    saveWebsiteLocalization.mockResolvedValue({ ok: false, message: '' })
    render(<LocalizationForm initial={initial} />)
    fireEvent.mouseDown(screen.getByLabelText('Default currency'))
    fireEvent.click(await screen.findByRole('option', { name: 'JPY' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Could not save.')).toBeTruthy()
    expect(saveWebsiteLocalization.mock.calls[0][0].default_currency).toBe('JPY')
  })
})
