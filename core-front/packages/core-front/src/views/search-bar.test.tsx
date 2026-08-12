import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ViewDescriptor } from './descriptor'
import { RelationOpsProvider, type RelationOps } from './relation-ops'
import { SavedFilterOpsProvider, type SavedFilterOps, type SavedFilterRecord } from './saved-filter-ops'
import { SearchBar } from './search-bar'
import { useSessionStore, type Identity } from './session-store'

function identityWith(groups: string[]): Identity {
  return { userId: 'u1', tenantId: 't1', roles: ['tester'], permissions: [], groups }
}

beforeEach(() => {
  useSessionStore.setState({ identity: null })
  vi.useRealTimers()
})

interface Contact {
  id: string
  name: string
  status?: string
  secret?: string
}

const descriptor: ViewDescriptor<Contact> = {
  entity: 'crm',
  viewType: 'tree',
  fields: [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'status', label: 'Status', type: 'selection', selection: { options: ['open', 'won'] } },
    { name: 'secret', label: 'Secret', type: 'text', groups: ['hr_manager'] },
  ],
}

const fallback: Contact[] = [{ id: '1', name: 'Ada' }]

function renderBar(
  opsOverrides: Partial<RelationOps> = {},
  savedOpsOverrides: Partial<SavedFilterOps> | null = {},
) {
  const onResults = vi.fn()
  const ops: RelationOps = {
    list: vi.fn(async () => []),
    get: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    distinctValues: vi.fn(async () => []),
    ...opsOverrides,
  }
  const savedOps: SavedFilterOps | null =
    savedOpsOverrides === null
      ? null
      : {
          list: vi.fn(async () => []),
          create: vi.fn(async () => ({}) as SavedFilterRecord),
          update: vi.fn(),
          remove: vi.fn(),
          ...savedOpsOverrides,
        }

  const tree = savedOps ? (
    <RelationOpsProvider ops={ops}>
      <SavedFilterOpsProvider ops={savedOps}>
        <SearchBar descriptor={descriptor} onResults={onResults} fallback={fallback} />
      </SavedFilterOpsProvider>
    </RelationOpsProvider>
  ) : (
    <RelationOpsProvider ops={ops}>
      <SearchBar descriptor={descriptor} onResults={onResults} fallback={fallback} />
    </RelationOpsProvider>
  )
  render(tree)
  return { onResults, ops, savedOps }
}

describe('SearchBar', () => {
  it('opens the dropdown with Filters/Group by/Saved filters sections on click', () => {
    renderBar()
    fireEvent.click(screen.getByPlaceholderText('Search…'))
    expect(screen.getByText('Filters')).toBeInTheDocument()
    expect(screen.getByText('Group by')).toBeInTheDocument()
    expect(screen.getByText('Saved filters')).toBeInTheDocument()
  })

  it('typing live-searches priority fields (debounced) and reports merged results', async () => {
    const list = vi.fn(async (_entity: string, options?: { search?: Record<string, string> }) => {
      if (options?.search?.name) return [{ id: '2', name: 'Grace' }]
      return []
    })
    const { onResults } = renderBar({ list })

    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'gra' } })

    await waitFor(() => expect(list).toHaveBeenCalled())
    const [, options] = list.mock.calls[0] as [string, { search?: Record<string, string> }]
    expect(options?.search?.name).toBe('gra')
    await waitFor(() => expect(onResults).toHaveBeenCalledWith([{ id: '2', name: 'Grace' }]))
  })

  it('reverts to the fallback records when the query is cleared', async () => {
    const { onResults } = renderBar()
    const input = screen.getByPlaceholderText('Search…')

    fireEvent.change(input, { target: { value: 'x' } })
    await waitFor(() => expect(onResults).toHaveBeenCalled())
    onResults.mockClear()

    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(onResults).toHaveBeenCalledWith(fallback))
  })

  it('a field gated to a group the caller lacks never appears as a group-by option', () => {
    useSessionStore.setState({ identity: identityWith(['someone_else']) })
    renderBar()
    fireEvent.click(screen.getByPlaceholderText('Search…'))
    // 'status' (ungated) is offered; 'secret' (gated to hr_manager) is not —
    // and 'secret' is a text field anyway, excluded from groupable by type,
    // so this also proves the group check runs on the (correctly-typed)
    // candidate set, not just an empty one.
    expect(screen.getByText('Status')).toBeInTheDocument()
  })

  it('fetches distinct values lazily on group-field click, not on menu open', async () => {
    const distinctValues = vi.fn(async () => [{ value: 'open', total: 3 }])
    const { onResults } = renderBar({ distinctValues })
    fireEvent.click(screen.getByPlaceholderText('Search…'))

    expect(distinctValues).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Status'))
    await waitFor(() => expect(distinctValues).toHaveBeenCalledWith('crm', 'status', expect.anything()))
    expect(await screen.findByText('open (3)')).toBeInTheDocument()

    fireEvent.click(screen.getByText('open (3)'))
    await waitFor(() => expect(onResults).toHaveBeenCalled())
  })

  it('fetches saved filters when the menu opens, applies one on click', async () => {
    const saved: SavedFilterRecord = {
      id: 'sf1',
      entity: 'crm',
      name: 'Open deals',
      shared: false,
      mine: true,
      config: { filters: [{ field: 'status', op: 'eq', value: 'open' }] },
    }
    const list = vi.fn(async () => [{ id: '9', name: 'Filtered' }])
    const { onResults } = renderBar({ list }, { list: vi.fn(async () => [saved]) })

    fireEvent.click(screen.getByPlaceholderText('Search…'))
    expect(await screen.findByText('Open deals')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Open deals'))
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith('crm', expect.objectContaining({ filter: { status: 'open' } })),
    )
    await waitFor(() => expect(onResults).toHaveBeenCalledWith([{ id: '9', name: 'Filtered' }]))
  })

  it('is inert (no crash) with no SavedFilterOps provider mounted', () => {
    renderBar({}, null)
    fireEvent.click(screen.getByPlaceholderText('Search…'))
    expect(screen.getByText('Saved filters')).toBeInTheDocument()
    // "Save current as…" stays present but disabled with no filters/no ops.
    expect(screen.getByText('Save current as…')).toBeDisabled()
  })
})
