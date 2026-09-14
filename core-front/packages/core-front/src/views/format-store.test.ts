import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_NUMBER_FORMAT,
  formatNumber,
  parseNumber,
  useFormatStore,
  type NumberFormatConfig,
} from './format-store'

const anglo: NumberFormatConfig = { decimalSeparator: '.', thousandsSeparator: ',' }
const european: NumberFormatConfig = { decimalSeparator: ',', thousandsSeparator: ' ' }
const plain: NumberFormatConfig = { decimalSeparator: '.', thousandsSeparator: '' }

describe('formatNumber', () => {
  it('formats against both separator configs', () => {
    expect(formatNumber(1234567.5, anglo, { decimals: 2 })).toBe('1,234,567.50')
    expect(formatNumber(1234567.5, european, { decimals: 2 })).toBe('1 234 567,50')
  })

  it('pads and rounds to the requested decimals', () => {
    expect(formatNumber(1.005, anglo, { decimals: 1 })).toBe('1.0')
    expect(formatNumber(2, anglo, { decimals: 2 })).toBe('2.00')
    expect(formatNumber(2.567, anglo, { decimals: 2 })).toBe('2.57')
  })

  it('renders integers without a decimal mark when decimals is omitted', () => {
    expect(formatNumber(1000, anglo)).toBe('1,000')
    expect(formatNumber(1000, plain)).toBe('1000')
  })

  it('keeps the sign out of the grouping', () => {
    expect(formatNumber(-1234.5, anglo, { decimals: 2 })).toBe('-1,234.50')
    expect(formatNumber(-1234.5, european, { decimals: 2 })).toBe('-1 234,50')
  })

  it('renders non-finite values as empty', () => {
    expect(formatNumber(NaN, anglo)).toBe('')
    expect(formatNumber(Infinity, anglo)).toBe('')
  })
})

describe('parseNumber', () => {
  it('round-trips formatted output in both configs', () => {
    expect(parseNumber('1,234,567.50', anglo)).toBe(1234567.5)
    expect(parseNumber('1 234 567,50', european)).toBe(1234567.5)
  })

  it('accepts ungrouped input and bare integers', () => {
    expect(parseNumber('1234,5', european)).toBe(1234.5)
    expect(parseNumber('42', anglo)).toBe(42)
    expect(parseNumber('-7', anglo)).toBe(-7)
  })

  it('returns NaN for junk and empties', () => {
    expect(parseNumber('abc', anglo)).toBeNaN()
    expect(parseNumber('', anglo)).toBeNaN()
    expect(parseNumber('-', anglo)).toBeNaN()
  })
})

describe('useFormatStore', () => {
  beforeEach(() => {
    useFormatStore.setState({ ...DEFAULT_NUMBER_FORMAT })
  })

  it('starts on the built-in default and applies a new config', () => {
    expect(useFormatStore.getState().decimalSeparator).toBe('.')
    useFormatStore.getState().setNumberFormat(european)
    expect(useFormatStore.getState().decimalSeparator).toBe(',')
    expect(useFormatStore.getState().thousandsSeparator).toBe(' ')
  })

  it('persists under the eerp-format key', () => {
    useFormatStore.getState().setNumberFormat(european)
    const raw = localStorage.getItem('eerp-format')
    expect(raw).toContain('","')
  })
})
