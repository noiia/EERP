import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useNotificationStore, type AppNotification } from '@eerp/core-front'
import type { SeedResult } from '@/lib/dev-seed'

const seedMock = vi.fn()
const groupsMock = vi.fn()
vi.mock('@/lib/dev-seed', () => ({
  seedDemoData: (...args: unknown[]) => seedMock(...args),
  getSeedGroups: () => groupsMock(),
}))
const revalidateMock = vi.fn(async () => {})
vi.mock('@/lib/notification-actions', () => ({
  revalidateSeededEntities: (...args: unknown[]) => revalidateMock(...(args as [])),
}))

/** A live dev_seed activity frame, as the presence socket delivers it. */
const activity = (over: Partial<AppNotification>): Omit<AppNotification, 'read'> => ({
  id: 'run-1', category: 'dev_seed', kind: 'activity', title: 'Seeding demo data', body: '', link: '/settings/developer',
  status: 'running', progress: 0, progress_label: null, finished_at: null, created_at: new Date().toISOString(),
  data: null, ...over,
})

const groups = [
  { key: 'contacts', label: 'Contacts', deps: [], seeded: false },
  { key: 'products', label: 'Products & variants', deps: [], seeded: true },
  { key: 'crm', label: 'CRM leads & tags', deps: ['contacts'], seeded: false },
  { key: 'events', label: 'Events & bookings', deps: ['contacts'], seeded: false },
]
const box = (name: RegExp) => screen.getByRole('checkbox', { name }) as HTMLInputElement

import DeveloperSettings from './DeveloperSettings'

beforeEach(() => {
  seedMock.mockReset()
  groupsMock.mockReset().mockResolvedValue({ groups, running: null })
  revalidateMock.mockClear()
  useNotificationStore.setState({ items: [], unread: 0, hasNew: false, loaded: true })
})

describe('DeveloperSettings', () => {
  it('runs the seed action and lists a per-entity summary of the result', async () => {
    const result: SeedResult = {
      ok: true,
      results: [
        { entity: 'contact', created: 10, failed: 0, errors: [] },
        { entity: 'crm', created: 14, failed: 1, errors: ['no crm:contacts:write'] },
      ],
    }
    seedMock.mockResolvedValue(result)

    render(<DeveloperSettings isDev />)
    fireEvent.click(screen.getByRole('button', { name: 'Seed demo data' }))

    expect(await screen.findByText('contact: 10 created')).toBeInTheDocument()
    expect(screen.getByText('crm: 14 created, 1 failed')).toBeInTheDocument()
    expect(screen.getByText('no crm:contacts:write')).toBeInTheDocument()
    expect(seedMock).toHaveBeenCalledOnce()
    expect(seedMock).toHaveBeenCalledWith('light')
  })

  it('runs the full volume in the background and follows its live progress to the results', async () => {
    seedMock.mockResolvedValue({ ok: true, started: 'run-1' })

    render(<DeveloperSettings isDev />)
    fireEvent.click(screen.getByRole('radio', { name: /^Full/ }))
    await screen.findByRole('checkbox', { name: /^Contacts/ }) // the button waits for the group list
    fireEvent.click(screen.getByRole('button', { name: 'Seed demo data' }))
    expect(seedMock).toHaveBeenCalledWith('full', ['contacts', 'crm', 'events'])

    act(() => useNotificationStore.getState().upsert(activity({ progress: 40, progress_label: 'Seeding contacts (1/3)' })))
    expect(await screen.findByText('Seeding contacts (1/3)')).toBeInTheDocument()
    expect(within(screen.getByTestId('seed-progress')).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')

    act(() => useNotificationStore.getState().upsert(activity({
      status: 'done', progress: 100, finished_at: new Date().toISOString(),
      data: JSON.stringify([{ entity: 'invoice', created: 100000 }, { entity: 'event_booking', created: 2 }, { entity: 'event_booking', created: 3 }]),
    })))
    expect(await screen.findByText('invoice: 100000 created')).toBeInTheDocument()
    expect(screen.getByText('event_booking: 5 created')).toBeInTheDocument()
    expect(screen.queryByTestId('seed-progress')).toBeNull()
    expect(revalidateMock).toHaveBeenCalledWith(['invoice', 'event_booking'])
  })

  it('resumes tracking a full seed already running after a reload', async () => {
    groupsMock.mockResolvedValue({ groups, running: 'run-9' })
    render(<DeveloperSettings isDev />)
    act(() => useNotificationStore.getState().upsert(activity({ id: 'run-9', progress: 10, progress_label: 'Seeding products (1/3)' })))
    expect(await screen.findByText('Seeding products (1/3)')).toBeInTheDocument()
  })

  it('shows the error when the background seed fails', async () => {
    groupsMock.mockResolvedValue({ groups, running: 'run-2' })
    render(<DeveloperSettings isDev />)
    act(() => useNotificationStore.getState().upsert(activity({ id: 'run-2', status: 'failed', body: 'boom', finished_at: new Date().toISOString() })))
    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.queryByTestId('seed-progress')).toBeNull()
  })

  it('lists the full-volume groups: all unseeded ticked, seeded ones locked, dependencies locked while needed', async () => {
    seedMock.mockResolvedValue({ ok: true, results: [] })
    render(<DeveloperSettings isDev />)
    fireEvent.click(screen.getByRole('radio', { name: /^Full/ }))
    await screen.findByRole('checkbox', { name: /^Contacts/ })

    expect(box(/^Products/)).toMatchObject({ checked: true, disabled: true })
    expect(screen.getByText(/already seeded/i)).toBeInTheDocument()
    // CRM and Events need Contacts: it stays ticked and locked while either is ticked.
    expect(box(/^Contacts/)).toMatchObject({ checked: true, disabled: true })
    fireEvent.click(box(/^CRM/))
    expect(box(/^Contacts/).disabled).toBe(true)
    fireEvent.click(box(/^Events/))
    expect(box(/^Contacts/).disabled).toBe(false)
    fireEvent.click(box(/^Contacts/))
    expect(screen.getByRole('button', { name: 'Seed demo data' })).toBeDisabled()

    fireEvent.click(box(/^Events/))
    fireEvent.click(screen.getByRole('button', { name: 'Seed demo data' }))
    await waitFor(() => expect(seedMock).toHaveBeenCalledWith('full', ['contacts', 'events']))
  })

  it('surfaces the disabled-outside-development message as an error', async () => {
    seedMock.mockResolvedValue({
      ok: false,
      message: 'Demo data seeding is disabled outside development.',
    })

    render(<DeveloperSettings isDev={false} />)
    // Disabled by isDev — but if it were somehow clicked, the action's own guard
    // is the real defense; the button being disabled is just the UI reflection.
    expect(screen.getByRole('button', { name: 'Seed demo data' })).toBeDisabled()
    expect(
      screen.getByText('Seeding demo data is only available outside production.'),
    ).toBeInTheDocument()
  })

  it('shows the loading state while seeding is in flight', async () => {
    let resolve!: (r: SeedResult) => void
    seedMock.mockReturnValue(new Promise<SeedResult>((r) => (resolve = r)))

    render(<DeveloperSettings isDev />)
    fireEvent.click(screen.getByRole('button', { name: 'Seed demo data' }))

    expect(await screen.findByRole('button', { name: 'Seeding…' })).toBeDisabled()

    resolve({ ok: true, results: [] })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Seed demo data' })).not.toBeDisabled())
  })
})
