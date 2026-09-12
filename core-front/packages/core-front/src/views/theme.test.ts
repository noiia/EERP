import { describe, expect, it } from 'vitest'
import { getContrastRatio } from '@mui/material/styles'
import { DEFAULT_PALETTE, isHexColor } from './palette'
import { buildAppTheme } from './theme'
import { neutral, radius } from './tokens'

describe('palette', () => {
  it('ships the five brand defaults', () => {
    expect(DEFAULT_PALETTE).toEqual({
      deepOcean: '#1E293B',
      goBlue: '#00ADD8',
      softWhite: '#F8FAFC',
      steelGrey: '#64748B',
      successGreen: '#10B981',
    })
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
    expect(theme.palette.primary.main).toBe('#00ADD8') // Go Blue → CTA / accent
    expect(theme.palette.secondary.main).toBe('#1E293B') // Deep Ocean → structure
    expect(theme.palette.success.main).toBe('#10B981') // Success Green
    expect(theme.palette.background.default).toBe(neutral[50]) // Soft White surface
    expect(theme.palette.text.primary).toBe(neutral[800]) // Deep Ocean text
    expect(theme.palette.text.secondary).toBe(neutral[500]) // Steel Grey
  })

  it('flips the reading surface in dark mode', () => {
    const theme = buildAppTheme(DEFAULT_PALETTE, 'dark')
    expect(theme.palette.mode).toBe('dark')
    expect(theme.palette.background.default).toBe(neutral[900])
    expect(theme.palette.background.paper).toBe(neutral[800]) // Deep Ocean = dark surface
    expect(theme.palette.text.primary).toBe(neutral[50])
    expect(theme.palette.primary.main).toBe('#00ADD8') // brand hue unchanged
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
    expect(buildAppTheme().palette.primary.main).toBe('#00ADD8')
  })

  it('derives WCAG-AA contrast text for the (light) brand accent', () => {
    // #00ADD8 fails AA against white, so MUI must pick the darker text. The pair must
    // clear the 4.5:1 normal-text threshold — the centralized accessibility fix.
    const theme = buildAppTheme(DEFAULT_PALETTE, 'light')
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
