import { describe, expect, it } from 'vitest'
import { getContrastRatio } from '@mui/material/styles'
import { DEFAULT_PALETTE, isHexColor } from './palette'
import { buildAppTheme } from './theme'
import { neutral, radius } from './tokens'

describe('palette', () => {
  it('ships the five brand defaults', () => {
    expect(DEFAULT_PALETTE).toEqual({
      deepOcean: '#1A2238',
      goBlue: '#4F46E5',
      softWhite: '#F5F6FA',
      steelGrey: '#5E6B85',
      successGreen: '#0A7F5A',
    })
  })

  it('keeps every default text color AA-readable on the page background', () => {
    const bg = DEFAULT_PALETTE.softWhite
    for (const color of [DEFAULT_PALETTE.deepOcean, DEFAULT_PALETTE.steelGrey, DEFAULT_PALETTE.goBlue]) {
      expect(getContrastRatio(color, bg)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('validates hex colors', () => {
    expect(isHexColor('#1E293B')).toBe(true)
    expect(isHexColor('#fff')).toBe(true)
    expect(isHexColor('1E293B')).toBe(false)
    expect(isHexColor('#12')).toBe(false)
    expect(isHexColor('blue')).toBe(false)
  })
})

describe('buildAppTheme', () => {
  it('maps brand colors onto the MUI palette (light)', () => {
    const theme = buildAppTheme(DEFAULT_PALETTE, 'light')
    expect(theme.palette.mode).toBe('light')
    expect(theme.palette.primary.main).toBe(DEFAULT_PALETTE.goBlue) // CTA / accent
    expect(theme.palette.secondary.main).toBe(DEFAULT_PALETTE.deepOcean) // structure
    expect(theme.palette.success.main).toBe(DEFAULT_PALETTE.successGreen)
    expect(theme.palette.background.default).toBe(DEFAULT_PALETTE.softWhite) // page surface
    expect(theme.palette.text.primary).toBe(DEFAULT_PALETTE.deepOcean) // headings + body
    expect(theme.palette.text.secondary).toBe(DEFAULT_PALETTE.steelGrey)
  })

  it('flips the reading surface in dark mode', () => {
    const theme = buildAppTheme(DEFAULT_PALETTE, 'dark')
    expect(theme.palette.mode).toBe('dark')
    expect(theme.palette.background.default).toBe(neutral[900])
    expect(theme.palette.background.paper).toBe(DEFAULT_PALETTE.deepOcean) // dark surface
    expect(theme.palette.text.primary).toBe(neutral[50])
  })

  it('reads read-only (disabled) field values in neutral[100] in dark mode, leaving light mode and buttons alone', () => {
    const dark = buildAppTheme(DEFAULT_PALETTE, 'dark')
    const input = dark.components?.MuiInputBase?.styleOverrides?.root as Record<string, Record<string, string>>
    expect(input['&.Mui-disabled'].color).toBe(neutral[100])
    expect(input['& .MuiInputBase-input.Mui-disabled'].WebkitTextFillColor).toBe(neutral[100])
    const label = dark.components?.MuiFormLabel?.styleOverrides?.root as Record<string, Record<string, string>>
    expect(label['&.Mui-disabled'].color).toBe(dark.palette.text.secondary)
    // Readable on the dark surface (AA).
    expect(getContrastRatio(neutral[100], DEFAULT_PALETTE.deepOcean)).toBeGreaterThanOrEqual(4.5)
    // Disabled buttons keep text.disabled; light mode keeps MUI's own.
    expect(dark.palette.text.disabled).toBe(neutral[600])
    expect(buildAppTheme(DEFAULT_PALETTE, 'light').components?.MuiInputBase).toBeUndefined()
  })

  it('lightens a dark primary in dark mode until it reads on the dark surface', () => {
    const theme = buildAppTheme(DEFAULT_PALETTE, 'dark')
    expect(theme.palette.primary.main).not.toBe(DEFAULT_PALETTE.goBlue)
    expect(getContrastRatio(theme.palette.primary.main, DEFAULT_PALETTE.deepOcean)).toBeGreaterThanOrEqual(4.5)
    // A primary already light enough is left alone.
    expect(buildAppTheme({ ...DEFAULT_PALETTE, goBlue: '#00ADD8' }, 'dark').palette.primary.main).toBe('#00ADD8')
  })

  it('times every MUI transition from the motion tokens (in slower than out)', () => {
    const { duration } = buildAppTheme().transitions
    expect(duration.enteringScreen).toBeGreaterThan(duration.leavingScreen)
    expect(buildAppTheme().components?.MuiDialog?.defaultProps?.slots?.transition).toBeDefined()
  })

  it('does NOT cross-wire light role colors into dark text', () => {
    // Regression: editing "Page background" (Soft White) or "Secondary text" (Steel Grey)
    // must not recolor dark-mode fonts — dark text comes from the neutral ramp.
    const theme = buildAppTheme(
      { ...DEFAULT_PALETTE, softWhite: '#abcdef', steelGrey: '#fedcba' },
      'dark',
    )
    expect(theme.palette.text.primary).toBe(neutral[50])
    expect(theme.palette.text.secondary).toBe(neutral[400])
    // Deep Ocean still drives the dark surface (the part that "looked good").
    expect(theme.palette.background.paper).toBe(DEFAULT_PALETTE.deepOcean)
  })

  it('honors a custom palette', () => {
    const theme = buildAppTheme({ ...DEFAULT_PALETTE, goBlue: '#ff0000' }, 'light')
    expect(theme.palette.primary.main).toBe('#ff0000')
  })

  it('threads every brand color through to its software role (palette edits take effect)', () => {
    // Regression: background/text/divider must follow the palette, not a fixed ramp.
    const custom = {
      goBlue: '#112233', // primary / CTA
      deepOcean: '#445566', // headings + body text
      softWhite: '#fafbfc', // page background
      steelGrey: '#778899', // secondary text + dividers
      successGreen: '#223344', // success
    }
    const theme = buildAppTheme(custom, 'light')
    expect(theme.palette.primary.main).toBe('#112233')
    expect(theme.palette.text.primary).toBe('#445566')
    expect(theme.palette.background.default).toBe('#fafbfc')
    expect(theme.palette.text.secondary).toBe('#778899')
    expect(theme.palette.divider).toBe('rgba(119, 136, 153, 0.22)') // steelGrey @ 0.22
    expect(theme.palette.success.main).toBe('#223344')
  })

  it('falls back to defaults when called bare', () => {
    expect(buildAppTheme().palette.primary.main).toBe(DEFAULT_PALETTE.goBlue)
  })

  it('derives WCAG-AA contrast text for a light brand accent', () => {
    // #00ADD8 fails AA against white, so MUI must pick the darker text. The pair must
    // clear the 4.5:1 normal-text threshold — the centralized accessibility fix.
    const theme = buildAppTheme({ ...DEFAULT_PALETTE, goBlue: '#00ADD8' }, 'light')
    expect(theme.palette.primary.contrastText).not.toBe('#fff')
    expect(
      getContrastRatio(theme.palette.primary.main, theme.palette.primary.contrastText),
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('applies the token-driven shape + typography', () => {
    const theme = buildAppTheme()
    expect(theme.shape.borderRadius).toBe(radius.md) // 8 (direction B)
    expect(theme.typography.fontFamily).toContain('Inter')
    expect(theme.typography.button.textTransform).toBe('none')
  })

  it('registers the system component layer (focus, reduced-motion, surfaces)', () => {
    const theme = buildAppTheme()
    expect(theme.components?.MuiCssBaseline).toBeDefined()
    expect(theme.components?.MuiCard).toBeDefined()
    expect(theme.components?.MuiButton).toBeDefined()
    expect(theme.components?.MuiAppBar?.defaultProps).toMatchObject({ color: 'secondary' })
  })
})
