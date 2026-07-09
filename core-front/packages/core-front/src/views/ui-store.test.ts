import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PALETTE } from './palette'
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
