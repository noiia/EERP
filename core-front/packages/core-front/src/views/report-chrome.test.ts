import { describe, expect, it } from 'vitest'
import { DEFAULT_COLORS, DEFAULT_PADDING_PX, resolveReportChrome, type ReportPageFormatRow } from './report-chrome'

const noGlobal = { footer: '', address: '' }

const format: ReportPageFormatRow = {
  name: 'A4 Invoice',
  width: 21,
  height: 29.7,
  unit: 'cm',
  padding: null,
  color_text: null,
  color_text_muted: null,
  color_border: null,
  color_accent: null,
  footer: null,
  address: null,
}

describe('resolveReportChrome', () => {
  it('falls back to built-in defaults when no page format is set', () => {
    const effective = resolveReportChrome(noGlobal, null)
    expect(effective).toEqual({
      paddingPx: DEFAULT_PADDING_PX,
      colors: DEFAULT_COLORS,
      footer: '',
      address: '',
      pageSizeCss: null,
    })
  })

  it('a page format present but with every override null still inherits every default', () => {
    const effective = resolveReportChrome(noGlobal, format)
    expect(effective.paddingPx).toBe(DEFAULT_PADDING_PX)
    expect(effective.colors).toEqual(DEFAULT_COLORS)
    expect(effective.footer).toBe('')
    expect(effective.address).toBe('')
  })

  it('a page format supplies its own size regardless of overrides', () => {
    const effective = resolveReportChrome(noGlobal, format)
    expect(effective.pageSizeCss).toBe('21cm 29.7cm')
  })

  it('global footer/address apply when the page format leaves them unset', () => {
    const global = { footer: 'Thank you.', address: '1 Rue de la Paix' }
    const effective = resolveReportChrome(global, format)
    expect(effective.footer).toBe('Thank you.')
    expect(effective.address).toBe('1 Rue de la Paix')
  })

  it('a page format overriding a subset of fields leaves the rest inherited', () => {
    const partial: ReportPageFormatRow = {
      ...format,
      padding: 40,
      color_accent: '#ffcc00',
      footer: 'Custom footer for this format only.',
    }
    const global = { footer: 'Global footer.', address: 'Global address.' }
    const effective = resolveReportChrome(global, partial)

    expect(effective.paddingPx).toBe(40)
    expect(effective.colors.accent).toBe('#ffcc00')
    expect(effective.colors.text).toBe(DEFAULT_COLORS.text)
    expect(effective.footer).toBe('Custom footer for this format only.')
    expect(effective.address).toBe('Global address.')
  })

  it('renders each unit into the @page size string verbatim', () => {
    expect(resolveReportChrome(noGlobal, { ...format, width: 816, height: 1056, unit: 'px' }).pageSizeCss).toBe(
      '816px 1056px',
    )
    expect(resolveReportChrome(noGlobal, { ...format, width: 8.5, height: 11, unit: 'in' }).pageSizeCss).toBe(
      '8.5in 11in',
    )
  })
})
