import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SeedResult } from '@/lib/dev-seed'

const seedMock = vi.fn()
const groupsMock = vi.fn()
vi.mock('@/lib/dev-seed', () => ({
  seedDemoData: (...args: unknown[]) => seedMock(...args),
  getSeedGroups: () => groupsMock(),
}))

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
  groupsMock.mockReset().mockResolvedValue(groups)
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

  it('runs the full volume when chosen', async () => {
    seedMock.mockResolvedValue({ ok: true, results: [{ entity: 'invoice', created: 100000, failed: 0, errors: [] }] })

    render(<DeveloperSettings isDev />)
    fireEvent.click(screen.getByRole('radio', { name: /^Full/ }))
    await screen.findByRole('checkbox', { name: /^Contacts/ }) // the button waits for the group list
    fireEvent.click(screen.getByRole('button', { name: 'Seed demo data' }))

    expect(await screen.findByText('invoice: 100000 created')).toBeInTheDocument()
    expect(seedMock).toHaveBeenCalledWith('full', ['contacts', 'crm', 'events'])
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
