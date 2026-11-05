import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { resolveServerTree } from '@/test/server-tree'

const permissions = vi.hoisted(() => ({ value: ['*:*:*'] as string[] }))
const requireAuth = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/lib/session', () => ({ requireAuth, getEffectivePermissions: async () => permissions.value }))
const moduleGet = vi.hoisted(() => vi.fn())
vi.mock('@eerp/core-front/server', () => ({ createServerApiClient: () => ({ get: moduleGet }), toApiError: (e: unknown) => e }))
vi.mock('@/generated/generated-modules', () => ({}))
vi.mock('@/lib/module-state', () => ({ activeModuleNames: async () => new Set(['crm', 'event']) }))
vi.mock('@/lib/view-fields', () => ({ getEntityViewFields: async (e: string) => ({ entity: e }) }))
vi.mock('@/lib/chatter-visibility', () => ({ getEntityChatterVisibility: async () => null }))
vi.mock('@/lib/status-bar-config', () => ({ getEntityStatusBarConfig: async () => null }))
vi.mock('@/lib/app-settings', () => ({ getModulePictureSize: async (m: string) => (m === 'base' ? { width: 200 } : null) }))
const settings = vi.hoisted(() => ({ event: null as unknown, warehouse: null as unknown, pm: null as unknown }))
vi.mock('@/lib/event-settings', () => ({ getEventSettings: async () => settings.event }))
vi.mock('@/lib/warehouse-settings', () => ({ getWarehouseSettings: async () => settings.warehouse }))
vi.mock('@/lib/propertymanagement-settings', () => ({ getPropertyManagementSettings: async () => settings.pm }))
vi.mock('../../views/registry', () => ({
  treeViewEntities: () => [
    { entity: 'crm', module: 'crm', kanbanFields: [], dateFields: [], defaults: {} },
    { entity: 'sale', module: 'sale', kanbanFields: [], dateFields: [], defaults: {} },
  ],
  formViewEntities: () => [
    { entity: 'crm', module: 'crm', showChatterDefault: true, statusBarField: 'stage', selectionFields: [] },
    { entity: 'crm_note', module: 'crm', showChatterDefault: undefined, statusBarField: undefined, selectionFields: [] },
  ],
}))
// Each settings component as a stub naming the props it got.
vi.mock('@/components/FormatSettings', async () => ({ default: (await import('@/test/props-stub')).propsStub('format') }))
vi.mock('@/components/PictureSizeSettings', async () => ({ default: (await import('@/test/props-stub')).propsStub('picture') }))
vi.mock('@/components/ViewsSettings', async () => ({ default: (await import('@/test/props-stub')).propsStub('views') }))
vi.mock('@/components/ChatterSettings', async () => ({ default: (await import('@/test/props-stub')).propsStub('chatter') }))
vi.mock('@/components/StatusBarSettings', async () => ({ default: (await import('@/test/props-stub')).propsStub('statusbar') }))
vi.mock('@/components/EventSettings', async () => ({ default: (await import('@/test/props-stub')).propsStub('event') }))
vi.mock('@/components/WarehouseSettings', async () => ({ default: (await import('@/test/props-stub')).propsStub('warehouse') }))
vi.mock('@/components/PropertyManagementSettings', async () => ({ default: (await import('@/test/props-stub')).propsStub('pm') }))

import AppSettingsPage from './page'

const show = async (module: string) =>
  render(<>{await resolveServerTree(await AppSettingsPage({ params: Promise.resolve({ module }) }))}</>)
const props = (id: string) => JSON.parse(screen.getByTestId(id).textContent ?? '{}')

beforeEach(() => {
  permissions.value = ['*:*:*']
  moduleGet.mockReset().mockResolvedValue({ display_name: 'CRM' })
  settings.event = { reminder_hours: 24 }
  settings.warehouse = { auto_reference: true }
  settings.pm = { display_taxes: false }
})

describe('Settings → Apps → :module', () => {
  it('base: the workspace-wide formats and picture size', async () => {
    await show('base')
    expect(requireAuth).toHaveBeenCalledWith('/settings/apps/base')
    expect(screen.getByRole('heading', { name: 'Base' })).toBeTruthy()
    expect(props('format')).toEqual({ canEdit: true })
    expect(props('picture')).toMatchObject({ module: 'base', initialOverride: { width: 200 }, base: null })
    expect(moduleGet).not.toHaveBeenCalled()
    expect(screen.queryByTestId('views')).toBeNull()
  })

  it("a module: its name, picture size over the base, and only its own active entities' views", async () => {
    await show('crm')
    expect(screen.getByRole('heading', { name: 'CRM' })).toBeTruthy()
    expect(props('picture')).toMatchObject({ module: 'crm', initialOverride: null, base: { width: 200 } })
    expect(props('views').rows.map((r: { entity: string }) => r.entity)).toEqual(['crm'])
    expect(props('statusbar').rows).toEqual([{ entity: 'crm', moduleField: 'stage', fields: [], config: null }])
    expect(props('chatter').rows.map((r: { entity: string }) => r.entity)).toEqual(['crm', 'crm_note'])
    expect(screen.queryByTestId('event')).toBeNull()
  })

  it('falls back to the slug when the module record cannot be read, and is read-only without rights', async () => {
    moduleGet.mockRejectedValue(new Error('down'))
    permissions.value = []
    await show('sale')
    expect(screen.getByRole('heading', { name: 'sale' })).toBeTruthy()
    expect(props('picture').canEdit).toBe(false)
    expect(props('views')).toEqual({ rows: [], canEdit: false }) // sale isn't active
    expect(screen.queryByTestId('statusbar')).toBeNull()
    expect(screen.queryByTestId('chatter')).toBeNull()
  })

  it.each([
    ['event', 'event'],
    ['warehouse', 'warehouse'],
    ['propertymanagement', 'pm'],
  ])('%s adds its own settings', async (module, id) => {
    await show(module)
    expect(props(id).canEdit).toBe(true)
  })

  it('an app whose settings fail to load shows none', async () => {
    settings.event = null
    settings.warehouse = null
    settings.pm = null
    for (const [m, id] of [['event', 'event'], ['warehouse', 'warehouse'], ['propertymanagement', 'pm']]) {
      const { unmount } = await show(m)
      expect(screen.queryByTestId(id)).toBeNull()
      unmount()
    }
  })
})
