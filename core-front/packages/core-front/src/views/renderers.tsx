'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import CardContent from '@mui/material/CardContent'
import CircularProgress from '@mui/material/CircularProgress'
import Grid from '@mui/material/Grid'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import { DataGrid, type GridColDef } from '@mui/x-data-grid'
import { RichTreeView } from '@mui/x-tree-view/RichTreeView'
import type { TreeViewDefaultItemModelProperties } from '@mui/x-tree-view/models'
import type { SerializedError } from '../api/errors'
import {
  availableDisplayModes,
  DISPLAY_MODES,
  effectiveViewFields,
  EMPTY_VIEW_FIELDS,
  type DisplayMode,
  type ViewFieldsConfig,
} from '../api/view-fields'
import { usePermission } from '../auth/Can'
import { useT } from '../i18n/translate'
import { CalendarRenderer } from './calendar-renderer'
import { CatalogRenderer } from './catalog-renderer'
import {
  fieldLabel,
  layoutFieldOrder,
  normalizeLayout,
  titleFieldName,
  type ViewDescriptor,
} from './descriptor'
import { ErrorAlert } from './error-alert'
import { FormActionsMenu } from './form-actions-menu'
import { GraphRenderer } from './graph-renderer'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import { KanbanRenderer } from './kanban-renderer'
import { LayoutForm } from './layout-renderer'
import { PictureSizeProvider } from './picture-widgets'
import { useRecordLabelStore } from './record-label-store'
import { tabularNums } from './tokens'
import { useUiStore } from './ui-store'
import {
  createDashboardStore,
  createFormStore,
  createTreeStore,
  useFormDirty,
  useFormDraft,
  useFormError,
  type EntityActions,
  type HasId,
  type TreeNode,
  type Widget,
} from './stores'
import { useStore } from 'zustand'

// Client renderers. Each builds its Zustand store ONCE from the descriptor +
// server-seeded initialData (no fetch on mount), then dispatches by viewType. New
// entity = a descriptor; new view type = one store factory + one renderer here +
// one server loader path. Nothing entity-specific lives in this file.

export interface EntityViewProps<T extends HasId> {
  descriptor: ViewDescriptor<T>
  initialData: T[]
  /** Server Actions the form/refresh stores invoke; provided by the host. */
  actions: EntityActions<T>
  /** A load error surfaced by the server loader (plain object — RSC-serializable). */
  error?: SerializedError | null
  /** Dashboard seed + refresh (only meaningful for viewType 'dashboard'). */
  widgets?: Widget[]
  onRefresh?: () => Promise<Widget[]>
  /** Kanban status field / Calendar date field config (tree views only —
   * docs/roadmaps/list-view-modes.md). Absent/undefined behaves as
   * unconfigured (Kanban/Calendar disabled), never a render error. */
  viewFields?: ViewFieldsConfig
  /** Go's total row count for this entity (tree views only), when known —
   * Graph mode's aggregate widgets (Phase 5) use it to detect a
   * page_size-truncated `initialData` instead of silently aggregating a
   * partial set. Undefined is treated as "unknown", not "complete". */
  recordTotal?: number
  /** The boolean/picture widget's admin-configured box size (Settings ->
   * Apps, form views only), already resolved through the Base cascade by
   * loader.tsx's loadPictureSize. `null`/undefined means no admin setting at
   * any level — the widget falls back to its own widgetOptions/default. */
  pictureSize?: { width: number; height: number } | null
}

/** Top-level dispatcher: render a load error, otherwise the renderer for the viewType. */
export function EntityView<T extends HasId>(props: EntityViewProps<T>) {
  if (props.error) return <ErrorAlert error={props.error} />
  switch (props.descriptor.viewType) {
    case 'form':
      return <FormRenderer {...props} />
    case 'tree':
      return <TreeRenderer {...props} />
    case 'dashboard':
      return <DashboardRenderer {...props} />
    case 'catalog':
      return <CatalogRenderer descriptor={props.descriptor} initialData={props.initialData} />
  }
}

// --- create affordance (tree views) ---

/**
 * The Create button for tree (list) views — dashboards and forms deliberately
 * offer none. Default-closed: it renders only when the descriptor declares BOTH
 * formPath and createPermission AND the session's role-derived permissions grant
 * it (the client mirror — display gating only, Go re-authorizes the POST).
 * Navigates to the empty form (formPath with ':id' → 'new'); the form store
 * creates on commit since the draft has no id.
 *
 * No renderer places it: the HOST page renders it inline on the title row
 * (right side) next to the tree view — exported for exactly that.
 */
export function CreateBar<T extends HasId>({ descriptor }: { descriptor: ViewDescriptor<T> }) {
  const t = useT()
  const router = useRouter()
  const { formPath, createPermission } = descriptor
  // The hook runs unconditionally (rules of hooks); '' never matches a grant.
  const allowed = usePermission(createPermission ?? '')
  if (!formPath || !createPermission || !allowed) return null
  return (
    <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
      <Button variant="contained" onClick={() => router.push(formPath.replace(':id', 'new'))}>
        {t('Create')}
      </Button>
    </Box>
  )
}

// --- form ---

function FormRenderer<T extends HasId>({
  descriptor,
  initialData,
  actions,
  pictureSize,
}: EntityViewProps<T>) {
  const t = useT()
  const [store] = useState(() => createFormStore(descriptor, actions, initialData[0] ?? {}))
  const draft = useFormDraft(store)
  const dirty = useFormDirty(store)
  const error = useFormError(store)
  const { setField } = store.getState()
  // Transient view-only state: the in-flight save, for the button's busy affordance. The
  // business logic stays in the store's commit(); this only mirrors its pendency.
  // NOTE: the durable home for this is a `submitting` flag on the form store — a store-API
  // addition deliberately deferred so this pass stays renderer/theme-only.
  const [submitting, setSubmitting] = useState(false)

  // Report this record's display name to the shell's breadcrumb (record-label-store),
  // which otherwise only has the raw id from the URL to show. Keyed off the title
  // field's OWN value (not the whole draft) so an edit to some other field doesn't
  // spuriously re-fire this.
  const recordId = (draft as { id?: string }).id
  const layout = normalizeLayout(descriptor)
  const titleField = titleFieldName(layout) ?? layoutFieldOrder(layout)[0]
  const titleValue = titleField ? (draft as Record<string, unknown>)[titleField] : undefined
  useEffect(() => {
    if (!recordId) return
    useRecordLabelStore
      .getState()
      .setLabel(recordId, typeof titleValue === 'string' && titleValue.trim() !== '' ? titleValue : null)
  }, [recordId, titleValue])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await store.getState().commit()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Box
      component="form"
      onSubmit={onSubmit}
      aria-busy={submitting}
      // Full width inside RootLayout's page inset (docs/roadmaps/
      // responsive-displays.md, Phase 3) — the old formMaxWidth cap made
      // sense for a single flat column but wastes most of a wide screen now
      // that the default anatomy is a header + two responsive columns.
      // The relation wizard's dialog (relation-widgets.tsx) sizes itself off
      // its own layout.wizardWidth/wizardWideWidth tokens instead.
      sx={{ maxWidth: '100%' }}
    >
      {/* Top toolbar: Reset + Save sit immediately left of the form's options
          menu (docs/adr/ADR-011) — the group's left edge lands exactly where
          the menu used to sit alone (apps/shell/app/[...module]/page.tsx no
          longer renders it; the form owns its own top chrome now). Reset is
          icon-only ("undo" glyph), matching the menu's own icon-only button. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
        <IconButton
          aria-label={t('Reset')}
          disabled={!dirty || submitting}
          onClick={() => store.getState().reset()}
        >
          <FontAwesomeIcon icon={byPrefixAndName.fas['arrow-rotate-left']} />
        </IconButton>
        <Button
          type="submit"
          variant="contained"
          disabled={!dirty || submitting}
          startIcon={
            submitting ? <CircularProgress size={16} color="inherit" thickness={5} /> : undefined
          }
        >
          {submitting ? t('Saving…') : t('Save')}
        </Button>
        <FormActionsMenu
          entity={descriptor.entity}
          actions={descriptor.actions ?? []}
          recordId={recordId ?? 'new'}
        />
      </Box>
      <Card>
        <CardContent sx={{ p: 3 }}>
          <Stack spacing={2.5}>
            {error ? (
              <ErrorAlert
                error={{ code: error.code, message: error.message, requestId: error.requestId }}
              />
            ) : null}
            <PictureSizeProvider size={pictureSize}>
              <LayoutForm
                descriptor={descriptor}
                draft={draft as Record<string, unknown>}
                onFieldChange={(name, value) => setField(name as keyof T, value as T[keyof T])}
                entity={descriptor.entity}
                recordId={(draft as { id?: string }).id ?? null}
              />
            </PictureSizeProvider>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  )
}

// --- tree (hierarchy) with a flat DataGrid fallback, plus Kanban/Calendar/Graph modes ---

const MODE_LABELS: Record<DisplayMode, string> = {
  list: 'List',
  kanban: 'Kanban',
  calendar: 'Calendar',
  graph: 'Graph',
}

/**
 * Top-right of the list content: switches between List (the DataGrid/tree
 * this renderer has always shown) and Kanban/Calendar/Graph (docs/roadmaps/
 * list-view-modes.md). Kanban/Calendar/Graph are each OMITTED entirely — not
 * rendered disabled — until their EFFECTIVE config (a module's own
 * `viewModeDefaults`, merged with any admin override from Settings -> Views;
 * see `availability`'s caller) resolves truthy: an unconfigured mode isn't a
 * "here's a button you can't press," it's not a button at all. The choice
 * persists per entity in useUiStore, so leaving and returning to a view keeps
 * the last mode — falling back to 'list' if the persisted mode is no longer
 * available (see TreeRenderer's guard).
 */
function DisplayModeSwitcher({
  entity,
  mode,
  onChange,
  availability,
}: {
  entity: string
  mode: DisplayMode
  onChange: (mode: DisplayMode) => void
  availability: Record<DisplayMode, boolean>
}) {
  const t = useT()
  const candidates = DISPLAY_MODES.filter((candidate) => availability[candidate])
  return (
    <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={mode}
        onChange={(_event, next: DisplayMode | null) => {
          if (next) onChange(next)
        }}
        aria-label={t('Display mode')}
      >
        {candidates.map((candidate) => (
          <ToggleButton key={candidate} value={candidate} data-entity={entity}>
            {t(MODE_LABELS[candidate])}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Box>
  )
}

function TreeRenderer<T extends HasId>({
  descriptor,
  initialData,
  actions,
  viewFields = EMPTY_VIEW_FIELDS,
  recordTotal,
}: EntityViewProps<T>) {
  const t = useT()
  const router = useRouter()
  const mode = useUiStore((s) => s.viewMode[descriptor.entity] ?? 'list')
  const setViewMode = useUiStore((s) => s.setViewMode)
  // The module's own hardcoded baseline (if any), overridden field-by-field by
  // whatever Settings -> Views has saved — the switcher and both modes below
  // act on this merged EFFECTIVE config, never the raw pieces separately.
  const effective = effectiveViewFields(descriptor.viewModeDefaults, viewFields)
  const availability = availableDisplayModes(effective)

  // A single shared record set every mode reads from, instead of each mode
  // rendering its own frozen copy of `initialData`. Kanban/Calendar's drags
  // mutate records in place (optimistically, then via a real PATCH) without a
  // page navigation — without this, switching to Graph (or back to List)
  // afterward showed stale data until the next real reload, since Graph had
  // no way to see a change Kanban/Calendar only ever reported to themselves.
  // Re-synced from `initialData` on every prop change (a fresh navigation, or
  // a revalidated Server Action reflecting through this page).
  const [liveRecords, setLiveRecords] = useState(initialData)
  useEffect(() => {
    setLiveRecords(initialData)
  }, [initialData])

  let content: React.ReactNode
  if (mode === 'kanban' && effective.kanbanStatusField) {
    content = (
      <KanbanRenderer
        descriptor={descriptor}
        initialData={liveRecords}
        actions={actions}
        statusField={effective.kanbanStatusField}
        onRecordsChange={setLiveRecords}
      />
    )
  } else if (mode === 'calendar' && effective.calendarDateField) {
    content = (
      <CalendarRenderer
        descriptor={descriptor}
        initialData={liveRecords}
        actions={actions}
        dateField={effective.calendarDateField}
        onRecordsChange={setLiveRecords}
      />
    )
  } else if (mode === 'graph' && effective.enableGraphs) {
    content = (
      <GraphRenderer
        descriptor={descriptor}
        records={liveRecords}
        recordTotal={recordTotal ?? liveRecords.length}
      />
    )
  } else {
    // 'list' (default), and the safe fallback if 'kanban'/'calendar'/'graph'
    // are somehow reached with no effectively-configured field/flag (the
    // switcher hides those buttons entirely, so this is defensive, not a
    // normal path — e.g. a persisted useUiStore mode from before an admin
    // turned a mode back off).
    // Flat data (no parent links) renders as a grid; hierarchical data as a tree.
    const hierarchical = (liveRecords as TreeNode[]).some((r) => r.parent_id != null)
    if (!hierarchical) {
      // Column order comes from the normalized layout, not a raw fields read —
      // for the common (no explicit `layout`) descriptor this is identical to
      // fields declaration order (the "Tree columns keep using fields order"
      // contract), but an explicit layout's field order now drives it too.
      const fieldsByName = new Map(descriptor.fields.map((f) => [f.name, f]))
      const columns: GridColDef[] = layoutFieldOrder(normalizeLayout(descriptor))
        .map((name) => fieldsByName.get(name))
        .filter((f) => f != null)
        .map((f) => ({
          field: f.name,
          headerName: t(fieldLabel(f)),
          flex: 1,
        }))
      // A formPath makes rows navigable: clicking one opens that record's form.
      const { formPath } = descriptor
      content = (
        <Box sx={{ width: '100%' }}>
          <DataGrid
            rows={liveRecords}
            columns={columns}
            autoHeight
            onRowClick={
              formPath
                ? (params) => router.push(formPath.replace(':id', String(params.id)))
                : undefined
            }
            sx={formPath ? { '& .MuiDataGrid-row': { cursor: 'pointer' } } : undefined}
          />
        </Box>
      )
    } else {
      content = <HierarchyTree descriptor={descriptor} initialData={initialData as (T & TreeNode)[]} />
    }
  }
  // No CreateBar here: for tree views the host page renders it on the title row.
  // Width/overflow containment is RootLayout's job now (one page-wide inset around
  // everything but the top bar — see the `pageInsetX`/`pageInsetY` tokens), not this
  // renderer's — a view-specific fix here would just be a second, competing mechanism.
  return (
    <Box>
      <DisplayModeSwitcher
        entity={descriptor.entity}
        mode={mode}
        onChange={(next) => setViewMode(descriptor.entity, next)}
        availability={availability}
      />
      {content}
    </Box>
  )
}

function HierarchyTree<T extends HasId & TreeNode>({
  descriptor,
  initialData,
}: {
  descriptor: ViewDescriptor<T>
  initialData: T[]
}) {
  const [store] = useState(() => createTreeStore(descriptor, initialData))
  const expanded = useStore(store, (s) => s.expanded)
  const labelField = layoutFieldOrder(normalizeLayout(descriptor))[0]

  const toItem = (node: T): TreeViewDefaultItemModelProperties => ({
    id: node.id,
    label: String(
      labelField ? ((node as Record<string, unknown>)[labelField] ?? node.id) : node.id,
    ),
    children: store.getState().children(node.id).map(toItem),
  })
  const items = store.getState().roots().map(toItem)

  return (
    <RichTreeView
      items={items}
      expandedItems={Array.from(expanded)}
      onItemExpansionToggle={(_event, itemId) => store.getState().toggle(itemId)}
    />
  )
}

// --- dashboard (one block per module list view: name + entry count) ---

function DashboardRenderer<T extends HasId>({
  descriptor,
  widgets,
  onRefresh,
}: EntityViewProps<T>) {
  const t = useT()
  const [store] = useState(() =>
    createDashboardStore(descriptor, onRefresh ?? (async () => widgets ?? []), widgets ?? []),
  )
  const items = useStore(store, (s) => s.widgets)

  return (
    <Grid container spacing={2}>
      {items.map((widget) => {
        // The server seeds count (number) or null when that list view failed to load.
        const count = widget.count
        const href = typeof widget.href === 'string' ? widget.href : undefined
        const block = (
          <CardContent sx={{ p: 2 }}>
            {/* Name in bold, top-left; the entry count below it. */}
            <Typography sx={{ fontWeight: 700 }}>{t(widget.title)}</Typography>
            <Typography
              variant="h4"
              component="div"
              sx={{ mt: 0.5, fontVariantNumeric: tabularNums }}
            >
              {typeof count === 'number' ? count : '—'}
            </Typography>
          </CardContent>
        )
        return (
          <Grid key={widget.id} size={{ xs: 12, sm: 6, md: 3 }}>
            <Card variant="outlined">
              {href ? (
                <CardActionArea component="a" href={href}>
                  {block}
                </CardActionArea>
              ) : (
                block
              )}
            </Card>
          </Grid>
        )
      })}
    </Grid>
  )
}
