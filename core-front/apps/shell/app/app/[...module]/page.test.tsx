import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND') } }))
vi.mock('@/generated/generated-modules', () => ({}))
const requireAuth = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/lib/session', () => ({ requireAuth }))
const active = vi.hoisted(() => ({ value: new Set(['crm']) }))
vi.mock('@/lib/module-state', () => ({ activeModuleNames: async () => active.value }))
vi.mock('./actions', () => ({
  createRecord: async () => null, updateRecord: async () => null, removeRecord: async () => null,
  restoreRecord: async () => null, recordAction: async () => null,
}))
const match = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('./resolve', () => ({
  resolveModuleRoute: () => match.value,
  modulePathFromSegments: (s: string[]) => `/${s.join('/')}`,
  modulePageTitle: () => 'Leads',
  dashboardListViews: (m: string) => [{ path: `/${m}/list` }],
}))
vi.mock('@eerp/core-front/server', async () => ({ EntityViewServer: (await import('@/test/props-stub')).propsStub('view') }))

import ModulePage from './page'

const route = (viewType: string) => ({ route: { module: 'crm', descriptor: { entity: 'crm', viewType, fields: [] } }, params: { id: '42' } })
const show = async (segments: string[] = ['crm', '42']) => render(await ModulePage({ params: Promise.resolve({ module: segments }) }))
const viewProps = () => JSON.parse(screen.getByTestId('view').textContent ?? '{}')

beforeEach(() => {
  active.value = new Set(['crm'])
  match.value = route('form')
})

describe('ModulePage', () => {
  it('requires a session for the requested path, and 404s an unknown route', async () => {
    match.value = null
    await expect(show(['nope'])).rejects.toThrow('NOT_FOUND')
    expect(requireAuth).toHaveBeenCalledWith('/nope')
    await expect(ModulePage({ params: Promise.resolve({}) })).rejects.toThrow('NOT_FOUND')
  })

  it("404s a deactivated module's route", async () => {
    active.value = new Set()
    await expect(show()).rejects.toThrow('NOT_FOUND')
  })

  it('a form: no title row, the record id passed on', async () => {
    await show()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(viewProps()).toMatchObject({ recordId: '42', module: 'crm' })
    expect(viewProps().title).toBeUndefined()
    expect(viewProps().listViews).toBeUndefined()
  })

  it('a list hands its title to the view; a dashboard shows it and rolls up the list views', async () => {
    match.value = route('tree')
    const { unmount } = await show(['crm', 'list'])
    expect(screen.queryByRole('heading')).toBeNull()
    expect(viewProps().title).toBe('Leads')
    unmount()
    match.value = route('dashboard')
    await show(['crm'])
    expect(screen.getByRole('heading', { name: 'Leads' })).toBeTruthy()
    expect(viewProps().listViews).toEqual([{ path: '/crm/list' }])
  })
})
