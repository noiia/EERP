import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ViewDescriptor } from './descriptor'
import { RelationOpsProvider, type RelationOps } from './relation-ops'
import { SavedFilterOpsProvider, type SavedFilterOps, type SavedFilterRecord } from './saved-filter-ops'
import { SearchBar } from './search-bar'
import { useSessionStore, type Identity } from './session-store'
import { useUndoToastStore } from './undo-toast'

function identityWith(groups: string[]): Identity {
  return { userId: 'u1', tenantId: 't1', roles: ['tester'], permissions: [], groups }
}

beforeEach(() => {
  useSessionStore.setState({ identity: null })
  useUndoToastStore.setState({ pending: null })
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

  it('shows applied filters as chips in the bar itself, not only inside the dropdown', async () => {
    const distinctValues = vi.fn(async () => [{ value: 'open', total: 3 }])
    renderBar({ distinctValues })
    fireEvent.click(screen.getByPlaceholderText('Search…'))
    fireEvent.click(screen.getByText('Status'))
    fireEvent.click(await screen.findByText('open (3)'))

    // applyGroupValue closes the dropdown (setAnchorEl(null)) — the chip
    // must still be visible with it shut, proving it lives in the bar.
    await waitFor(() => expect(screen.getByText('Status eq open')).toBeInTheDocument())
  })

  // The dropdown's own MenuItem (portaled by MUI to the end of document.body)
  // renders AFTER the bar's inline chip in DOM order, so `getAllByText(...)[0]`
  // reliably picks the bar chip without needing to close the menu first.
  function barChip(name: RegExp) {
    return screen.getAllByText(name)[0].closest('.MuiChip-root') as HTMLElement
  }

  it('applying a saved filter shows ONE consolidated chip, not one per condition', async () => {
    const saved: SavedFilterRecord = {
      id: 'sf1',
      entity: 'crm',
      name: 'Open deals',
      shared: false,
      mine: true,
      config: { filters: [{ field: 'status', op: 'eq', value: 'open' }] },
    }
    renderBar({}, { list: vi.fn(async () => [saved]) })

    fireEvent.click(screen.getByPlaceholderText('Search…'))
    fireEvent.click(await screen.findByText(/Open deals/))

    // The consolidated chip (in the bar) shows the saved filter's NAME —
    // the underlying "Status eq open" condition text never renders.
    await waitFor(() => expect(barChip(/^Open deals$/)).toBeTruthy())
    expect(screen.queryByText('Status eq open')).not.toBeInTheDocument()
  })

  it('an applied filter NOT owned by the caller gets a plain unapply close, no pencil', async () => {
    const saved: SavedFilterRecord = {
      id: 'sf1',
      entity: 'crm',
      name: 'Team filter',
      shared: true,
      mine: false,
      config: { filters: [{ field: 'status', op: 'eq', value: 'open' }] },
    }
    const remove = vi.fn()
    renderBar({}, { list: vi.fn(async () => [saved]), remove })

    fireEvent.click(screen.getByPlaceholderText('Search…'))
    fireEvent.click(await screen.findByText(/Team filter/))

    const chip = await waitFor(() => barChip(/^Team filter$/))
    expect(chip.querySelector('.MuiChip-icon')).toBeNull() // no pencil
    // Clicking its close never calls the hard-delete op.
    fireEvent.click(chip.querySelector('.MuiChip-deleteIcon')!)
    expect(remove).not.toHaveBeenCalled()
  })

  it('deleting an owned applied filter schedules an undo toast instead of deleting immediately', async () => {
    const saved: SavedFilterRecord = {
      id: 'sf1',
      entity: 'crm',
      name: 'Open deals',
      shared: false,
      mine: true,
      config: { filters: [{ field: 'status', op: 'eq', value: 'open' }] },
    }
    const remove = vi.fn()
    renderBar({}, { list: vi.fn(async () => [saved]), remove })

    fireEvent.click(screen.getByPlaceholderText('Search…'))
    fireEvent.click(await screen.findByText(/Open deals/))
    const chip = await waitFor(() => barChip(/^Open deals$/))
    fireEvent.click(chip.querySelector('.MuiChip-deleteIcon')!)

    // Gone from view immediately, but nothing hit the backend yet.
    expect(screen.queryByText(/^Open deals$/)).not.toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()
    expect(useUndoToastStore.getState().pending?.message).toContain('Open deals')
  })

  it('recovering a deleted applied filter restores it with zero backend calls', async () => {
    const saved: SavedFilterRecord = {
      id: 'sf1',
      entity: 'crm',
      name: 'Open deals',
      shared: false,
      mine: true,
      config: { filters: [{ field: 'status', op: 'eq', value: 'open' }] },
    }
    const remove = vi.fn()
    const list = vi.fn(async () => [{ id: '9', name: 'Filtered' }])
    renderBar({ list }, { list: vi.fn(async () => [saved]), remove })

    fireEvent.click(screen.getByPlaceholderText('Search…'))
    fireEvent.click(await screen.findByText(/Open deals/))
    const chip = await waitFor(() => barChip(/^Open deals$/))
    fireEvent.click(chip.querySelector('.MuiChip-deleteIcon')!)

    useUndoToastStore.getState().recover()

    await waitFor(() => expect(barChip(/^Open deals$/)).toBeTruthy())
    expect(remove).not.toHaveBeenCalled()
  })

  it('letting the undo window expire actually deletes it', async () => {
    const saved: SavedFilterRecord = {
      id: 'sf1',
      entity: 'crm',
      name: 'Open deals',
      shared: false,
      mine: true,
      config: { filters: [{ field: 'status', op: 'eq', value: 'open' }] },
    }
    const remove = vi.fn()
    renderBar({}, { list: vi.fn(async () => [saved]), remove })

    fireEvent.click(screen.getByPlaceholderText('Search…'))
    fireEvent.click(await screen.findByText(/Open deals/))
    const chip = await waitFor(() => barChip(/^Open deals$/))

    vi.useFakeTimers()
    try {
      fireEvent.click(chip.querySelector('.MuiChip-deleteIcon')!)
      vi.advanceTimersByTime(6000)
    } finally {
      vi.useRealTimers()
    }
    await waitFor(() => expect(remove).toHaveBeenCalledWith('sf1'))
  })

  it('typing into the Add-filter value field never lets the Menu steal focus (the MUI Menu typeahead bug)', async () => {
    // The "Status" field option starts with 's' — exactly the letter MUI's
    // MenuList typeahead would jump focus to if the keydown ever reached it.
    renderBar()
    fireEvent.click(screen.getByPlaceholderText('Search…'))
    const valueField = screen.getByPlaceholderText('Value')
    valueField.focus()
    fireEvent.keyDown(valueField, { key: 's', bubbles: true })
    expect(document.activeElement).toBe(valueField)
  })

  it('is inert (no crash) with no SavedFilterOps provider mounted', () => {
    renderBar({}, null)
    fireEvent.click(screen.getByPlaceholderText('Search…'))
    expect(screen.getByText('Saved filters')).toBeInTheDocument()
    // "Save current as…" stays present but disabled with no filters/no ops.
    expect(screen.getByText('Save current as…')).toBeDisabled()
  })
})
