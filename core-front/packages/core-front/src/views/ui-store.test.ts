import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PALETTE, LEGACY_DEFAULT_PALETTE } from './palette'
import { useUiStore } from './ui-store'

describe('useUiStore palette', () => {
  beforeEach(() => {
    useUiStore.getState().resetPalette()
    useUiStore.getState().setTheme('light')
  })

  it('defaults to the brand palette', () => {
    expect(useUiStore.getState().palette).toEqual(DEFAULT_PALETTE)
  })

  it('overrides a single brand color without touching the rest', () => {
    useUiStore.getState().setPaletteColor('goBlue', '#123456')
    const { palette } = useUiStore.getState()
    expect(palette.goBlue).toBe('#123456')
    expect(palette.deepOcean).toBe(DEFAULT_PALETTE.deepOcean)
  })

  it('resets to defaults', () => {
    useUiStore.getState().setPaletteColor('goBlue', '#123456')
    useUiStore.getState().resetPalette()
    expect(useUiStore.getState().palette).toEqual(DEFAULT_PALETTE)
  })

  it('upgrades a browser still on the previous default palette, keeps a customized one', async () => {
    const stored = (palette: object) =>
      localStorage.setItem('eerp-ui', JSON.stringify({ state: { palette }, version: 1 }))

    stored({ ...LEGACY_DEFAULT_PALETTE, goBlue: LEGACY_DEFAULT_PALETTE.goBlue.toLowerCase() })
    await useUiStore.persist.rehydrate()
    expect(useUiStore.getState().palette).toEqual(DEFAULT_PALETTE)

    stored({ ...LEGACY_DEFAULT_PALETTE, goBlue: '#123456' })
    await useUiStore.persist.rehydrate()
    expect(useUiStore.getState().palette).toEqual({ ...LEGACY_DEFAULT_PALETTE, goBlue: '#123456' })
    localStorage.removeItem('eerp-ui')
  })

  it('toggles theme mode', () => {
    useUiStore.getState().setTheme('dark')
    expect(useUiStore.getState().theme).toBe('dark')
  })
})

describe('useUiStore viewMode', () => {
  it('defaults to no stored mode per entity', () => {
    expect(useUiStore.getState().viewMode).toEqual({})
  })

  it('sets a mode for one entity without touching others', () => {
    useUiStore.getState().setViewMode('crm', 'kanban')
    useUiStore.getState().setViewMode('contact', 'calendar')
    expect(useUiStore.getState().viewMode).toEqual({ crm: 'kanban', contact: 'calendar' })
  })

  it('overwrites a previously set mode for the same entity', () => {
    useUiStore.getState().setViewMode('crm', 'kanban')
    useUiStore.getState().setViewMode('crm', 'graph')
    expect(useUiStore.getState().viewMode.crm).toBe('graph')
  })
})
