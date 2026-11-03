import { describe, expect, it } from 'vitest'
import { underpricedCurrencies } from './LocalizationForm'

describe('underpricedCurrencies', () => {
  it('flags only hand-set rates below the live one', () => {
    expect(underpricedCurrencies({
      currencies: ['USD', 'GBP', 'CHF', 'JPY'],
      overrides: { USD: 1.0, GBP: 0.9, JPY: 150 },
      live: { USD: 1.1, GBP: 0.85 },
    })).toEqual(['USD'])
  })
})
