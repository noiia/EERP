import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

// The flat list navigates to a record's form on row click via the App Router.
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

import { ChatterOpsProvider, type ChatterMessageRecord, type ChatterOps } from './chatter-ops'
import type { ViewDescriptor } from './descriptor'
import { GraphOpsProvider } from './graph-ops'
import { useRecordLabelStore } from './record-label-store'
import { CreateBar, EntityView } from './renderers'
import { useSessionStore, type Identity } from './session-store'
import { useUiStore } from './ui-store'
import type { EntityActions } from './stores'

function identityWith(permissions: string[]): Identity {
  return { userId: 'u1', tenantId: 't1', roles: ['tester'], permissions }
}

beforeEach(() => {
  pushMock.mockClear()
  useSessionStore.setState({ identity: null })
  useUiStore.setState({ viewMode: {} })
  useRecordLabelStore.setState({ id: null, label: null })
})

interface Contact {
  id: string
  name: string
  parent_id?: string | null
}

const noopActions: EntityActions<Contact> = {
  create: vi.fn(async (b) => ({ id: 'x', name: '', ...b }) as Contact),
  update: vi.fn(async (id, b) => ({ id, name: '', ...b }) as Contact),
}

const formDescriptor: ViewDescriptor<Contact> = {
  entity: 'crm',
  viewType: 'form',
  fields: [{ name: 'name', label: 'Name', type: 'text' }],
}

describe('EntityView', () => {
  it('renders an error alert with the code and request id, no renderer', () => {
    render(
      <EntityView
        descriptor={formDescriptor}
        initialData={[]}
        actions={noopActions}
        error={{ code: 'FORBIDDEN', message: 'nope', requestId: '01J-req' }}
      />,
    )
    expect(screen.getByText('FORBIDDEN')).toBeInTheDocument()
    expect(screen.getByText('nope')).toBeInTheDocument()
    expect(screen.getByText(/01J-req/)).toBeInTheDocument()
    // The form's Save button must not render when the view short-circuits to the error.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('renders the form for viewType "form" with Save disabled until a field changes', () => {
    render(<EntityView descriptor={formDescriptor} initialData={[]} actions={noopActions} />)

    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()

    // 'name' is the only text field, so the default form anatomy renders it
    // as the big TITLE field (placeholder label, not a boxed one) —
    // docs/roadmaps/responsive-displays.md, Phase 3.
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Ada' } })
    expect(save).toBeEnabled()
  })

  it('reports the record\'s title-field value to record-label-store, for the shell breadcrumb', async () => {
    render(
      <EntityView
        descriptor={formDescriptor}
        initialData={[{ id: 'c1', name: 'Ada Lovelace' }]}
        actions={noopActions}
      />,
    )
    await waitFor(() =>
      expect(useRecordLabelStore.getState()).toMatchObject({ id: 'c1', label: 'Ada Lovelace' }),
    )

    // Live: an edit to the title field itself updates the reported label too.
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Ada' } })
    await waitFor(() => expect(useRecordLabelStore.getState().label).toBe('Ada'))
  })

  it('does not report a label for a brand-new record (no id yet)', () => {
    render(<EntityView descriptor={formDescriptor} initialData={[]} actions={noopActions} />)
    expect(useRecordLabelStore.getState()).toEqual({ id: null, label: null, setLabel: expect.any(Function) })
  })

  it('threads the pictureSize prop down to a boolean/picture field (Settings -> Apps override)', async () => {
    const pictureDescriptor: ViewDescriptor<Contact> = {
      entity: 'crm',
      viewType: 'form',
      fields: [
        { name: 'name', label: 'Name', type: 'text' },
        { name: 'photo', label: 'Photo', type: 'boolean', widget: 'picture' },
      ],
    }
    render(
      <EntityView
        descriptor={pictureDescriptor}
        initialData={[{ id: 'c1', name: 'Ada' }]}
        actions={noopActions}
        pictureSize={{ width: 300, height: 300 }}
      />,
    )
    const placeholder = await screen.findByTestId('picture-tile')
    expect(placeholder).toHaveStyle({ width: '300px', height: '300px' })
  })

  // docs/roadmaps/app-store.md, Phase 2: readOnly never blocks a commit — it
  // just means that ONE field can't be the thing that makes the form dirty.
  it('a readOnly field never blocks commit: editing another field alone enables Save and commits cleanly', async () => {
    interface ModuleRecord {
      id: string
      display_name: string
      version: string
    }
    const update = vi.fn(
      async (id: string, body: Partial<ModuleRecord>) => ({ id, ...body }) as ModuleRecord,
    )
    const actions: EntityActions<ModuleRecord> = {
      create: vi.fn(async (b) => b as ModuleRecord),
      update,
    }
    const descriptor: ViewDescriptor<ModuleRecord> = {
      entity: 'modules',
      viewType: 'form',
      fields: [
        { name: 'display_name', label: 'Display name', type: 'text' },
        { name: 'version', label: 'Version', type: 'text', readOnly: true },
      ],
    }
    render(
      <EntityView
        descriptor={descriptor}
        initialData={[{ id: 'crm', display_name: 'CRM', version: '0.0.1' }]}
        actions={actions}
      />,
    )

    const version = screen.getByLabelText('Version')
    expect(version).toBeDisabled()
    expect(version).toHaveValue('0.0.1')

    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()

    // 'display_name' is the only non-readOnly text field, so it becomes the
    // synthesized title field (placeholder-labeled) — same anatomy rule as
    // the test above.
    fireEvent.change(screen.getByPlaceholderText('Display name'), { target: { value: 'CRM v2' } })
    expect(save).toBeEnabled()
    fireEvent.click(save)

    // The commit sends the WHOLE draft (readOnly doesn't strip a field from
    // the payload, only from editing) — version round-trips UNCHANGED,
    // because nothing ever touched it.
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('crm', {
        id: 'crm',
        display_name: 'CRM v2',
        version: '0.0.1',
      }),
    )
  })

  it('an explicit layout groups/reorders the form — normalizeLayout drives it, not fields declaration order', () => {
    const laidOut: ViewDescriptor<Contact & { email: string }> = {
      entity: 'crm',
      viewType: 'form',
      // Declared name-then-email...
      fields: [
        { name: 'name', label: 'Name', type: 'text' },
        { name: 'email', label: 'Email', type: 'text' },
      ],
      // ...but the layout puts email first, inside a titled section.
      layout: [
        {
          kind: 'section',
          title: 'Contact',
          children: [{ kind: 'field', name: 'email' }, { kind: 'field', name: 'name' }],
        },
      ],
    }
    render(
      <EntityView
        descriptor={laidOut}
        initialData={[]}
        actions={noopActions as unknown as EntityActions<Contact & { email: string }>}
      />,
    )
    expect(screen.getByText('Contact')).toBeInTheDocument()
    const inputs = screen.getAllByRole('textbox')
    expect(inputs[0]).toBe(screen.getByLabelText('Email'))
    expect(inputs[1]).toBe(screen.getByLabelText('Name'))
  })

  it('offers Reset once dirty, and resetting re-disables Save', () => {
    render(<EntityView descriptor={formDescriptor} initialData={[]} actions={noopActions} />)

    const save = screen.getByRole('button', { name: 'Save' })
    const reset = screen.getByRole('button', { name: 'Reset' })
    expect(reset).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Ada' } })
    expect(reset).toBeEnabled()
    expect(save).toBeEnabled()

    fireEvent.click(reset)
    expect(save).toBeDisabled()
    expect(reset).toBeDisabled()
  })

  it('renders a flat grid for a "tree" view with no hierarchy', () => {
    const treeDescriptor: ViewDescriptor<Contact> = { ...formDescriptor, viewType: 'tree' }
    render(
      <EntityView
        descriptor={treeDescriptor}
        initialData={[{ id: '1', name: 'Ada' }]}
        actions={noopActions}
      />,
    )
    expect(screen.getByRole('grid')).toBeInTheDocument()
    expect(screen.getByText('Ada')).toBeInTheDocument()
  })

  it("offers the DataGrid's own built-in columns panel, right-aligned above the grid, to choose which fields display", async () => {
    const wideDescriptor: ViewDescriptor<Contact & { email?: string }> = {
      entity: 'crm',
      viewType: 'tree',
      fields: [
        { name: 'name', label: 'Name', type: 'text' },
        { name: 'email', label: 'Email', type: 'text' },
      ],
    }
    render(
      <EntityView
        descriptor={wideDescriptor}
        initialData={[{ id: '1', name: 'Ada', email: 'ada@example.com' }]}
        actions={noopActions as unknown as EntityActions<Contact & { email?: string }>}
      />,
    )
    expect(screen.getByRole('columnheader', { name: 'Email' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Choose columns' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Email' }))

    await waitFor(() =>
      expect(screen.queryByRole('columnheader', { name: 'Email' })).not.toBeInTheDocument(),
    )
    // Hiding a column is a display choice only — the underlying record is untouched.
    expect(screen.getByText('Ada')).toBeInTheDocument()
  })

  it('navigates to the record form on row click when the descriptor sets formPath', () => {
    const treeDescriptor: ViewDescriptor<Contact> = {
      ...formDescriptor,
      viewType: 'tree',
      formPath: '/crm/:id',
    }
    render(
      <EntityView
        descriptor={treeDescriptor}
        initialData={[{ id: '42', name: 'Ada' }]}
        actions={noopActions}
      />,
    )
    fireEvent.click(screen.getByText('Ada'))
    expect(pushMock).toHaveBeenCalledWith('/crm/42')
  })

  it('keeps rows inert when the descriptor has no formPath', () => {
    const treeDescriptor: ViewDescriptor<Contact> = { ...formDescriptor, viewType: 'tree' }
    render(
      <EntityView
        descriptor={treeDescriptor}
        initialData={[{ id: '42', name: 'Ada' }]}
        actions={noopActions}
      />,
    )
    fireEvent.click(screen.getByText('Ada'))
    expect(pushMock).not.toHaveBeenCalled()
  })

  describe('form chatter panel', () => {
    function chatterOps(): ChatterOps {
      return {
        list: vi.fn(async () => [] as ChatterMessageRecord[]),
        create: vi.fn(async (_table: string, _record: string, kind: 'message' | 'log', body: string) => ({
          id: 'm1',
          author: 'me@x.com',
          kind,
          body,
          createdAt: '2026-01-01T00:00:00Z',
        })),
      }
    }

    it('renders the panel beside/below the form once a ChatterOpsProvider is mounted', () => {
      const ops = chatterOps()
      render(
        <ChatterOpsProvider ops={ops}>
          <EntityView
            descriptor={formDescriptor}
            initialData={[{ id: '1', name: 'Ada' }]}
            actions={noopActions}
          />
        </ChatterOpsProvider>,
      )
      expect(screen.getByText('Activity')).toBeInTheDocument()
    })

    it('renders nothing extra with no ChatterOpsProvider — the form itself is unaffected', () => {
      render(
        <EntityView
          descriptor={formDescriptor}
          initialData={[{ id: '1', name: 'Ada' }]}
          actions={noopActions}
        />,
      )
      expect(screen.queryByText('Activity')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    })

    it('posts a chatter log summarizing the change after saving an EDIT to an existing record', async () => {
      const ops = chatterOps()
      const update = vi.fn(async (id: string, b: Partial<Contact>) => ({ id, name: 'Ada', ...b }) as Contact)
      render(
        <ChatterOpsProvider ops={ops}>
          <EntityView
            descriptor={formDescriptor}
            initialData={[{ id: '1', name: 'Ada' }]}
            actions={{ create: noopActions.create, update }}
          />
        </ChatterOpsProvider>,
      )
      fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Ada Lovelace' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(update).toHaveBeenCalled())
      await waitFor(() =>
        expect(ops.create).toHaveBeenCalledWith('crm', '1', 'log', 'Name: Ada → Ada Lovelace'),
      )
    })

    it('does not post a log entry when the save is a first-time CREATE, not an edit', async () => {
      const ops = chatterOps()
      render(
        <ChatterOpsProvider ops={ops}>
          <EntityView descriptor={formDescriptor} initialData={[]} actions={noopActions} />
        </ChatterOpsProvider>,
      )
      fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Ada' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(noopActions.create).toHaveBeenCalled())
      expect(ops.create).not.toHaveBeenCalled()
    })

    it('a save with no actual field change posts no log entry', async () => {
      const ops = chatterOps()
      const update = vi.fn(async (id: string, b: Partial<Contact>) => ({ id, name: 'Ada', ...b }) as Contact)
      render(
        <ChatterOpsProvider ops={ops}>
          <EntityView
            descriptor={formDescriptor}
            initialData={[{ id: '1', name: 'Ada' }]}
            actions={{ create: noopActions.create, update }}
          />
        </ChatterOpsProvider>,
      )
      // Round-trip back to the original value: dirty (any setField marks it
      // so) but no real diff once committed. Two real DOM value changes —
      // jsdom never fires a change event for a no-op "same value" set.
      const input = screen.getByPlaceholderText('Name')
      fireEvent.change(input, { target: { value: 'Ada Lovelace' } })
      fireEvent.change(input, { target: { value: 'Ada' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(update).toHaveBeenCalled())
      expect(ops.create).not.toHaveBeenCalled()
    })
  })

  describe('display-mode switcher (Kanban/Calendar/Graph)', () => {
    const treeDescriptor: ViewDescriptor<Contact> = { ...formDescriptor, viewType: 'tree' }

    it('defaults to List only — Kanban/Calendar/Graph stay unrendered, not merely disabled, until configured', () => {
      render(
        <EntityView
          descriptor={treeDescriptor}
          initialData={[{ id: '1', name: 'Ada' }]}
          actions={noopActions}
        />,
      )
      expect(screen.getByRole('button', { name: 'List', pressed: true })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Kanban' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Calendar' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Graph' })).not.toBeInTheDocument()
      // The List mode itself is unaffected — still the same grid as before.
      expect(screen.getByRole('grid')).toBeInTheDocument()
    })

    it('shows Kanban/Calendar/Graph once their field/flag is configured via Settings -> Views', () => {
      render(
        <EntityView
          descriptor={treeDescriptor}
          initialData={[{ id: '1', name: 'Ada' }]}
          actions={noopActions}
          viewFields={{ kanbanStatusField: 'status', calendarDateField: 'due_date', enableGraphs: true }}
        />,
      )
      expect(screen.getByRole('button', { name: 'Kanban' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Calendar' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Graph' })).toBeEnabled()
    })

    it("shows Kanban/Calendar/Graph from the module's own viewModeDefaults, with no Settings override at all", () => {
      const defaultedDescriptor: ViewDescriptor<Contact> = {
        ...treeDescriptor,
        viewModeDefaults: { kanbanStatusField: 'status', calendarDateField: 'due_date', enableGraphs: true },
      }
      render(
        <EntityView
          descriptor={defaultedDescriptor}
          initialData={[{ id: '1', name: 'Ada' }]}
          actions={noopActions}
        />,
      )
      expect(screen.getByRole('button', { name: 'Kanban' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Calendar' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Graph' })).toBeEnabled()
    })

    it('a non-null Settings override wins over the module default (including turning a mode back off)', () => {
      const defaultedDescriptor: ViewDescriptor<Contact> = {
        ...treeDescriptor,
        viewModeDefaults: { kanbanStatusField: 'status', enableGraphs: true },
      }
      render(
        <EntityView
          descriptor={defaultedDescriptor}
          initialData={[{ id: '1', name: 'Ada' }]}
          actions={noopActions}
          viewFields={{ kanbanStatusField: 'priority', calendarDateField: null, enableGraphs: false }}
        />,
      )
      expect(screen.getByRole('button', { name: 'Kanban' })).toBeEnabled()
      expect(screen.queryByRole('button', { name: 'Graph' })).not.toBeInTheDocument()
    })

    it('switching to Kanban with a configured status field renders real columns, not a placeholder', () => {
      const dealDescriptor: ViewDescriptor<Contact & { status?: string | null }> = {
        entity: 'crm',
        viewType: 'tree',
        fields: [
          { name: 'name', label: 'Name', type: 'text' },
          { name: 'status', label: 'Status', type: 'selection', selection: { options: ['open', 'won'] } },
        ],
      }
      render(
        <EntityView
          descriptor={dealDescriptor}
          initialData={[{ id: '1', name: 'Ada', status: 'open' }]}
          actions={noopActions as unknown as EntityActions<Contact & { status?: string | null }>}
          viewFields={{ kanbanStatusField: 'status', calendarDateField: null }}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Kanban' }))
      expect(screen.queryByText(/Kanban view is coming soon/)).not.toBeInTheDocument()
      expect(screen.getByRole('group', { name: 'open' })).toHaveTextContent('Ada')
    })

    it('switching to Calendar with a configured date field renders a real month grid, not a placeholder', () => {
      const taskDescriptor: ViewDescriptor<Contact & { due_date?: string | null }> = {
        entity: 'crm',
        viewType: 'tree',
        fields: [
          { name: 'name', label: 'Name', type: 'text' },
          { name: 'due_date', label: 'Due date', type: 'date' },
        ],
      }
      render(
        <EntityView
          descriptor={taskDescriptor}
          initialData={[{ id: '1', name: 'Ada', due_date: null }]}
          actions={noopActions as unknown as EntityActions<Contact & { due_date?: string | null }>}
          viewFields={{ kanbanStatusField: null, calendarDateField: 'due_date' }}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }))
      expect(screen.queryByText(/Calendar view is coming soon/)).not.toBeInTheDocument()
      expect(screen.getByRole('group', { name: 'Unscheduled' })).toHaveTextContent('Ada')
    })

    it('switching to Graph (enabled via Settings) swaps the content, not the grid — inert with no GraphOpsProvider', () => {
      render(
        <EntityView
          descriptor={treeDescriptor}
          initialData={[{ id: '1', name: 'Ada' }]}
          actions={noopActions}
          viewFields={{ kanbanStatusField: null, calendarDateField: null, enableGraphs: true }}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
      expect(screen.queryByRole('grid')).not.toBeInTheDocument()
      // No GraphOpsProvider mounted in this test tree — same inert-not-crashing
      // posture RelationOps takes for a host with no relation wiring.
      expect(screen.getByText(/Graph layouts are not available/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Graph', pressed: true })).toBeInTheDocument()
    })

    it('switching to Graph with a GraphOpsProvider renders the real canvas, not the placeholder', async () => {
      const get = vi.fn(async () => ({ tiles: [] }))
      render(
        <GraphOpsProvider ops={{ get, save: vi.fn(async () => ({ ok: true }) as const) }}>
          <EntityView
            descriptor={treeDescriptor}
            initialData={[{ id: '1', name: 'Ada' }]}
            actions={noopActions}
            viewFields={{ kanbanStatusField: null, calendarDateField: null, enableGraphs: true }}
          />
        </GraphOpsProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
      await waitFor(() => expect(get).toHaveBeenCalledWith('crm'))
      expect(screen.queryByText(/Graph layouts are not available/)).not.toBeInTheDocument()
    })

    it('a Kanban drag is reflected in Graph mode without a page reload', async () => {
      // Regression guard: Graph used to read the page's ORIGINAL initialData
      // snapshot, unaffected by a Kanban/Calendar drag done in the same
      // client session (no navigation) — switching to Graph afterward showed
      // stale data until the next real page load. TreeRenderer now lifts a
      // single `liveRecords` state every mode reads from and Kanban/Calendar
      // report their optimistic updates back into it.
      const dealDescriptor: ViewDescriptor<Contact & { status?: string | null }> = {
        entity: 'crm',
        viewType: 'tree',
        fields: [
          { name: 'name', label: 'Name', type: 'text' },
          { name: 'status', label: 'Status', type: 'selection', selection: { options: ['open', 'won'] } },
        ],
      }
      const update = vi.fn(
        async (id: string, b: Partial<Contact & { status?: string | null }>) =>
          ({ id, name: 'Ada', ...b }) as Contact & { status?: string | null },
      )
      const actions: EntityActions<Contact & { status?: string | null }> = {
        create: vi.fn(async (b) => ({ id: 'x', name: '', ...b }) as Contact & { status?: string | null }),
        update,
      }
      const get = vi.fn(async () => ({
        tiles: [{ id: 't1', x: 0, y: 0, w: 6, h: 6, type: 'pie' as const, config: { groupByField: 'status' } }],
      }))
      render(
        <GraphOpsProvider ops={{ get, save: vi.fn(async () => ({ ok: true }) as const) }}>
          <EntityView
            descriptor={dealDescriptor}
            initialData={[{ id: '1', name: 'Ada', status: 'open' }]}
            actions={actions}
            viewFields={{ kanbanStatusField: 'status', calendarDateField: null, enableGraphs: true }}
          />
        </GraphOpsProvider>,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Kanban' }))
      fireEvent.dragStart(screen.getByTestId('kanban-card-1'))
      fireEvent.dragOver(screen.getByRole('group', { name: 'won' }))
      fireEvent.drop(screen.getByRole('group', { name: 'won' }))
      await waitFor(() => expect(update).toHaveBeenCalledWith('1', { status: 'won' }))

      fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
      await waitFor(() => expect(get).toHaveBeenCalledWith('crm'))
      expect(screen.getByText('won')).toBeInTheDocument()
      expect(screen.queryByText('open')).not.toBeInTheDocument()
    })

    it('persists the chosen mode per entity across remounts (useUiStore)', () => {
      const graphEnabled = { kanbanStatusField: null, calendarDateField: null, enableGraphs: true }
      const { unmount } = render(
        <EntityView
          descriptor={treeDescriptor}
          initialData={[{ id: '1', name: 'Ada' }]}
          actions={noopActions}
          viewFields={graphEnabled}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
      unmount()

      render(
        <EntityView
          descriptor={treeDescriptor}
          initialData={[{ id: '1', name: 'Ada' }]}
          actions={noopActions}
          viewFields={graphEnabled}
        />,
      )
      expect(screen.getByRole('button', { name: 'Graph', pressed: true })).toBeInTheDocument()
    })
  })

  describe('Create button', () => {
    const creatableList: ViewDescriptor<Contact> = {
      ...formDescriptor,
      viewType: 'tree',
      formPath: '/crm/:id',
      createPermission: 'crm:contacts:write',
    }

    it('is exported for the host title row and opens the empty form when granted', () => {
      useSessionStore.setState({ identity: identityWith(['crm:contacts:write']) })
      render(<CreateBar descriptor={creatableList} />)
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
      expect(pushMock).toHaveBeenCalledWith('/crm/new')
    })

    it('honors role wildcards from the session mirror', () => {
      useSessionStore.setState({ identity: identityWith(['*:*:*']) })
      render(<CreateBar descriptor={creatableList} />)
      expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
    })

    it('stays hidden when the session lacks the permission', () => {
      useSessionStore.setState({ identity: identityWith(['crm:contacts:read']) })
      render(<CreateBar descriptor={creatableList} />)
      expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
    })

    it('stays hidden when the descriptor declares no createPermission (default-closed)', () => {
      useSessionStore.setState({ identity: identityWith(['*:*:*']) })
      const readOnly: ViewDescriptor<Contact> = { ...creatableList, createPermission: undefined }
      render(<CreateBar descriptor={readOnly} />)
      expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
    })

    it('is NOT rendered by the tree view itself — the host owns its title-row placement', () => {
      useSessionStore.setState({ identity: identityWith(['*:*:*']) })
      render(
        <EntityView
          descriptor={creatableList}
          initialData={[{ id: '1', name: 'Ada' }]}
          actions={noopActions}
        />,
      )
      expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
    })

    it('is NOT rendered on dashboards — tree views only', () => {
      useSessionStore.setState({ identity: identityWith(['*:*:*']) })
      const dash: ViewDescriptor<Contact> = { ...creatableList, viewType: 'dashboard' }
      render(
        <EntityView
          descriptor={dash}
          initialData={[]}
          actions={noopActions}
          widgets={[{ id: 'w1', title: 'Contacts', href: '/crm/list', count: 1 }]}
        />,
      )
      expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
    })
  })

  it('renders a hierarchical tree when records carry parent links', () => {
    const treeDescriptor: ViewDescriptor<Contact> = { ...formDescriptor, viewType: 'tree' }
    render(
      <EntityView
        descriptor={treeDescriptor}
        initialData={[
          { id: 'root', name: 'Root', parent_id: null },
          { id: 'child', name: 'Child', parent_id: 'root' },
        ]}
        actions={noopActions}
      />,
    )
    expect(screen.getByRole('tree')).toBeInTheDocument()
    expect(screen.getByText('Root')).toBeInTheDocument()
  })

  it('renders a dashboard block per list view with its name and entry count', () => {
    const dashDescriptor: ViewDescriptor<Contact> = { ...formDescriptor, viewType: 'dashboard' }
    render(
      <EntityView
        descriptor={dashDescriptor}
        initialData={[]}
        actions={noopActions}
        widgets={[{ id: 'w1', title: 'Contacts', href: '/crm/list', count: 12 }]}
      />,
    )
    expect(screen.getByText('Contacts')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    // The block links to its list view.
    expect(screen.getByRole('link')).toHaveAttribute('href', '/crm/list')
  })

  it('shows a dash for a dashboard block whose count failed to load', () => {
    const dashDescriptor: ViewDescriptor<Contact> = { ...formDescriptor, viewType: 'dashboard' }
    render(
      <EntityView
        descriptor={dashDescriptor}
        initialData={[]}
        actions={noopActions}
        widgets={[{ id: 'w1', title: 'Contacts', href: '/crm/list', count: null }]}
      />,
    )
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
