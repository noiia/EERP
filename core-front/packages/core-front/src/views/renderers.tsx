'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import AlertTitle from '@mui/material/AlertTitle'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
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
      slotProps={field.type === 'date' ? { inputLabel: { shrink: true } } : undefined}
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

  return (
    <Box
      component="form"
      onSubmit={(e) => {
        e.preventDefault()
        void store.getState().commit()
      }}
    >
      <Stack spacing={2} sx={{ maxWidth: 480 }}>
        {error ? <ErrorAlert error={{ code: error.code, message: error.message, requestId: error.requestId }} /> : null}
        {descriptor.fields.map((field) => (
          <FieldInput
            key={field.name}
            field={field}
            value={(draft as Record<string, unknown>)[field.name]}
            onChange={(value) => setField(field.name as keyof T, value as T[keyof T])}
          />
        ))}
        <Button type="submit" variant="contained" disabled={!dirty} sx={{ alignSelf: 'flex-start' }}>
          Save
        </Button>
      </Stack>
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

// --- dashboard (stub widget contract) ---

function DashboardRenderer<T extends HasId>({ descriptor, widgets, onRefresh }: EntityViewProps<T>) {
  const [store] = useState(() =>
    createDashboardStore(descriptor, onRefresh ?? (async () => widgets ?? []), widgets ?? []),
  )
  const items = useStore(store, (s) => s.widgets)

  return (
    <Box>
      <Button onClick={() => void store.getState().refresh()} sx={{ mb: 2 }}>
        Refresh
      </Button>
      <Grid container spacing={2}>
        {items.map((widget) => (
          <Grid key={widget.id} size={{ xs: 12, sm: 6, md: 4 }}>
            <Card>
              <CardContent>
                <Typography variant="h6">{widget.title}</Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  )
}
