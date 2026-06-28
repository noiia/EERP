'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import AlertTitle from '@mui/material/AlertTitle'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import CardContent from '@mui/material/CardContent'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import Grid from '@mui/material/Grid'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { DataGrid, type GridColDef } from '@mui/x-data-grid'
import { RichTreeView } from '@mui/x-tree-view/RichTreeView'
import type { TreeViewDefaultItemModelProperties } from '@mui/x-tree-view/models'
import type { SerializedError } from '../api/errors'
import type { FieldDescriptor, ViewDescriptor } from './descriptor'
import { layout, tabularNums } from './tokens'
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
}

function ErrorAlert({ error }: { error: SerializedError }) {
  return (
    <Alert severity="error">
      <AlertTitle>{error.code}</AlertTitle>
      {error.message}
      {error.requestId ? (
        <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>
          request: {error.requestId}
        </Typography>
      ) : null}
    </Alert>
  )
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
  }
}

// --- form ---

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDescriptor
  value: unknown
  onChange: (value: unknown) => void
}) {
  if (field.type === 'boolean') {
    return (
      <FormControlLabel
        control={<Switch checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />}
        label={field.label}
      />
    )
  }
  if (field.type === 'relation') {
    // Stub: a relation picker with no options yet (resolved against the related entity later).
    return (
      <TextField
        select
        label={field.label}
        required={field.required}
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <MenuItem value="">—</MenuItem>
      </TextField>
    )
  }
  const type = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'
  return (
    <TextField
      label={field.label}
      type={type}
      required={field.required}
      fullWidth
      slotProps={field.type === 'date' ? { inputLabel: { shrink: true } } : undefined}
      // Numeric figures align in columns (tabular figures token).
      sx={field.type === 'number' ? { '& input': { fontVariantNumeric: tabularNums } } : undefined}
      value={(value as string | number) ?? ''}
      onChange={(e) =>
        onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)
      }
    />
  )
}

function FormRenderer<T extends HasId>({ descriptor, initialData, actions }: EntityViewProps<T>) {
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
      sx={{ maxWidth: layout.formMaxWidth }}
    >
      <Card>
        <CardContent sx={{ p: 3 }}>
          <Stack spacing={2.5}>
            {error ? (
              <ErrorAlert
                error={{ code: error.code, message: error.message, requestId: error.requestId }}
              />
            ) : null}
            {descriptor.fields.map((field) => (
              <FieldInput
                key={field.name}
                field={field}
                value={(draft as Record<string, unknown>)[field.name]}
                onChange={(value) => setField(field.name as keyof T, value as T[keyof T])}
              />
            ))}
          </Stack>
        </CardContent>
        <Divider />
        {/* Footer action bar: primary Save + a Reset that discards edits (store.reset). */}
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 1,
            px: 3,
            py: 2,
          }}
        >
          <Button
            type="button"
            color="inherit"
            disabled={!dirty || submitting}
            onClick={() => store.getState().reset()}
          >
            Reset
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!dirty || submitting}
            startIcon={
              submitting ? <CircularProgress size={16} color="inherit" thickness={5} /> : undefined
            }
          >
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </Box>
      </Card>
    </Box>
  )
}

// --- tree (hierarchy) with a flat DataGrid fallback ---

function TreeRenderer<T extends HasId>({ descriptor, initialData }: EntityViewProps<T>) {
  // Flat data (no parent links) renders as a grid; hierarchical data as a tree.
  const hierarchical = (initialData as TreeNode[]).some((r) => r.parent_id != null)
  if (!hierarchical) {
    const columns: GridColDef[] = descriptor.fields.map((f) => ({
      field: f.name,
      headerName: f.label,
      flex: 1,
    }))
    return (
      <Box sx={{ width: '100%' }}>
        <DataGrid rows={initialData} columns={columns} autoHeight />
      </Box>
    )
  }
  return <HierarchyTree descriptor={descriptor} initialData={initialData as (T & TreeNode)[]} />
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
  const labelField = descriptor.fields[0]?.name

  const toItem = (node: T): TreeViewDefaultItemModelProperties => ({
    id: node.id,
    label: String(labelField ? ((node as Record<string, unknown>)[labelField] ?? node.id) : node.id),
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

function DashboardRenderer<T extends HasId>({ descriptor, widgets, onRefresh }: EntityViewProps<T>) {
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
            <Typography sx={{ fontWeight: 700 }}>{widget.title}</Typography>
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
