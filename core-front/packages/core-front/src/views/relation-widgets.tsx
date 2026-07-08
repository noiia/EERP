'use client'
import { useEffect, useRef, useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import SvgIcon from '@mui/material/SvgIcon'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { DataGrid, type GridColDef } from '@mui/x-data-grid'
import { useT } from '../i18n/translate'
import type { FieldDescriptor, RelationDescriptor } from './descriptor'
import { useRelationOps, type RelationOps, type RelationRecord } from './relation-ops'
import type { WidgetProps } from './widgets'

// Relation widgets (docs/roadmaps/field-widgets.md, Phase 4). All data flows
// through RelationOps — bound Server Actions the host mounts once — so Go
// authorizes every query with the caller's session: the autocomplete can only
// ever surface records the user may read.
//
//   many2one  -> search: autocomplete + wizard dialog; the value is the FK.
//   many2many -> tags: links ARE junction rows, written at interaction time.
//   one2many  -> list: read-only embedded grid of the inverse records.
//
// o2m/m2m fields are VIRTUAL on this record (isVirtualRelation): the behavior
// plan strips them from commit payloads; these widgets never touch the draft.

/** Material "link" glyph inlined — one icon does not justify an icons dependency. */
function LinkIcon(props: React.ComponentProps<typeof SvgIcon>) {
  return (
    <SvgIcon {...props}>
      <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z" />
    </SvgIcon>
  )
}

const SEARCH_DEBOUNCE_MS = 250
const SEARCH_PAGE_SIZE = 10
const EMBED_PAGE_SIZE = 100

/** The related record's display text (labelField, falling back to its id). */
function labelOf(record: RelationRecord, labelField: string): string {
  const raw = record[labelField]
  return raw == null || raw === '' ? record.id : String(raw)
}

function relationOf(field: FieldDescriptor): RelationDescriptor {
  // Registration validated the block exists (resolveRelationWidget).
  return field.relation as RelationDescriptor
}

/** Debounced related-entity search, bound to one relation target. */
function useRelationSearch(ops: RelationOps | null, rel: RelationDescriptor) {
  const labelField = rel.labelField ?? 'name'
  const [options, setOptions] = useState<RelationRecord[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const search = (text: string) => {
    if (!ops) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      ops
        .list(rel.entity, {
          search: text ? { [labelField]: text } : undefined,
          pageSize: SEARCH_PAGE_SIZE,
        })
        .then(setOptions)
        .catch(() => setOptions([]))
    }, SEARCH_DEBOUNCE_MS)
  }

  // Popup-open prefill (first SEARCH_PAGE_SIZE records). Typing opens the popup
  // too, so this fires AFTER onInputChange — it must never clobber a pending
  // typed search with the empty one.
  const prefill = () => {
    if (timer.current || options.length > 0) return
    search('')
  }

  return { labelField, options, search, prefill }
}

/**
 * A linked record rendered as a tag. The unlink cross sits on the tag's RIGHT
 * side and appears on hover (the spec'd affordance); activating it unlinks
 * (m2o -> null, m2m -> junction row removed).
 */
function RelationTag({
  label,
  onUnlink,
  disabled,
}: {
  label: string
  onUnlink: () => void
  disabled?: boolean
}) {
  return (
    <Chip
      label={label}
      size="small"
      onDelete={disabled ? undefined : onUnlink}
      sx={{
        '& .MuiChip-deleteIcon': { opacity: 0, transition: 'opacity 120ms' },
        '&:hover .MuiChip-deleteIcon, & .MuiChip-deleteIcon:focus-visible': { opacity: 1 },
      }}
    />
  )
}

/** Grid columns for related records: labelField first, then other scalars. */
function relatedColumns(rows: RelationRecord[], labelField: string, t: (s: string) => string): GridColDef[] {
  const hidden = new Set(['id', 'tenant_id', 'created_at', 'updated_at', 'deleted_at'])
  const keys = new Set<string>([labelField])
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!hidden.has(key)) keys.add(key)
    }
  }
  return [...keys].slice(0, 4).map((key) => ({
    field: key,
    headerName: key === labelField ? t('Name') : key,
    flex: 1,
  }))
}

function MissingOpsHint({ label }: { label: string }) {
  const t = useT()
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="legend">
        {label}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {t('Relation data is not wired on this host.')}
      </Typography>
    </Box>
  )
}

function UnsavedHint({ label }: { label: string }) {
  const t = useT()
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="legend">
        {label}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {t('Available once the record has been saved.')}
      </Typography>
    </Box>
  )
}

// ── relation/search (many2one) ────────────────────────────────────────────────

/**
 * Iteration 1 of the wizard: a dialog with a search input and a row grid;
 * selecting a row sets the value. Richer filtering and create-from-wizard are
 * deliberately later iterations.
 */
function RelationWizard({
  open,
  onClose,
  onPick,
  rel,
  ops,
}: {
  open: boolean
  onClose: () => void
  onPick: (record: RelationRecord) => void
  rel: RelationDescriptor
  ops: RelationOps
}) {
  const t = useT()
  const labelField = rel.labelField ?? 'name'
  const [text, setText] = useState('')
  const [rows, setRows] = useState<RelationRecord[]>([])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    ops
      .list(rel.entity, {
        search: text ? { [labelField]: text } : undefined,
        pageSize: EMBED_PAGE_SIZE,
      })
      .then((found) => {
        if (!cancelled) setRows(found)
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
    return () => {
      cancelled = true
    }
  }, [open, text, rel.entity, labelField, ops])

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('Select a record')}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            label={t('Search')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            fullWidth
            autoFocus
          />
          <DataGrid
            rows={rows}
            columns={relatedColumns(rows, labelField, t)}
            autoHeight
            hideFooter
            onRowClick={(params) => {
              onPick(params.row as RelationRecord)
              onClose()
            }}
            sx={{ '& .MuiDataGrid-row': { cursor: 'pointer' } }}
          />
        </Stack>
      </DialogContent>
    </Dialog>
  )
}

export function RelationSearchWidget({ field, value, onChange, disabled }: WidgetProps) {
  const t = useT()
  const ops = useRelationOps()
  const rel = relationOf(field)
  const { labelField, options, search, prefill } = useRelationSearch(ops, rel)
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)

  const selectedId = typeof value === 'string' && value !== '' ? value : null

  // Resolve the current FK to its display label (the tag text).
  useEffect(() => {
    if (!ops || !selectedId) {
      setSelectedLabel(null)
      return
    }
    let cancelled = false
    ops
      .get(rel.entity, selectedId)
      .then((record) => {
        if (!cancelled) setSelectedLabel(labelOf(record, labelField))
      })
      .catch(() => {
        if (!cancelled) setSelectedLabel(selectedId)
      })
    return () => {
      cancelled = true
    }
  }, [ops, selectedId, rel.entity, labelField])

  if (!ops) return <MissingOpsHint label={t(field.label)} />

  const pick = (record: RelationRecord) => {
    setSelectedLabel(labelOf(record, labelField))
    onChange(record.id)
  }

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="legend">
        {t(field.label)}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        {selectedId ? (
          <RelationTag
            label={selectedLabel ?? selectedId}
            disabled={disabled}
            onUnlink={() => {
              setSelectedLabel(null)
              onChange(null)
            }}
          />
        ) : (
          <Autocomplete<RelationRecord>
            options={options}
            // Go already filtered server-side; re-filtering on the label would
            // hide records whose match is on another column.
            filterOptions={(x) => x}
            getOptionLabel={(o) => labelOf(o, labelField)}
            isOptionEqualToValue={(o, v) => o.id === v.id}
            onOpen={prefill}
            onInputChange={(_e, text, reason) => {
              if (reason === 'input') search(text)
            }}
            onChange={(_e, option) => {
              if (option) pick(option)
            }}
            disabled={disabled}
            fullWidth
            size="small"
            renderInput={(params) => <TextField {...params} placeholder={t('Search…')} />}
          />
        )}
        {/* The wizard affordance sits at the field's RIGHT (spec). */}
        <IconButton
          aria-label={t('Open selection wizard')}
          onClick={() => setWizardOpen(true)}
          disabled={disabled}
          size="small"
        >
          <LinkIcon fontSize="small" />
        </IconButton>
      </Stack>
      <RelationWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onPick={pick}
        rel={rel}
        ops={ops}
      />
    </Box>
  )
}

// ── relation/tags (many2many) ─────────────────────────────────────────────────

interface TagLink {
  junctionId: string
  related: RelationRecord
}

/** The junction's FK columns: declared viaFields or the naming convention. */
function junctionColumns(rel: RelationDescriptor, ownEntity: string) {
  return {
    own: rel.viaFields?.own ?? `${ownEntity}_id`,
    related: rel.viaFields?.related ?? `${rel.entity}_id`,
  }
}

export function RelationTagsWidget({ field, disabled, entity, recordId }: WidgetProps) {
  const t = useT()
  const ops = useRelationOps()
  const rel = relationOf(field)
  const via = rel.via as string // registration validated presence
  const cols = junctionColumns(rel, entity ?? '')
  const { labelField, options, search, prefill } = useRelationSearch(ops, rel)
  const [links, setLinks] = useState<TagLink[]>([])
  const [error, setError] = useState<string | null>(null)

  // Links are junction rows: load them, then resolve each related record's label.
  useEffect(() => {
    if (!ops || !recordId) return
    let cancelled = false
    ;(async () => {
      const junctions = await ops.list(via, {
        filter: { [cols.own]: recordId },
        pageSize: EMBED_PAGE_SIZE,
      })
      const resolved = await Promise.all(
        junctions.map(async (row): Promise<TagLink | null> => {
          const relatedId = row[cols.related]
          if (typeof relatedId !== 'string') return null
          // A dangling junction row (related record deleted) keeps the id as label.
          const related = await ops
            .get(rel.entity, relatedId)
            .catch((): RelationRecord => ({ id: relatedId }))
          return { junctionId: row.id, related }
        }),
      )
      if (!cancelled) setLinks(resolved.filter((l): l is TagLink => l !== null))
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e))
    })
    return () => {
      cancelled = true
    }
    // Load once per anchor — links then evolve through add/unlink below.
  }, [ops, via, recordId, rel.entity, cols.own, cols.related])

  if (!ops) return <MissingOpsHint label={t(field.label)} />
  if (!recordId) return <UnsavedHint label={t(field.label)} />

  const linkedIds = new Set(links.map((l) => l.related.id))

  const add = (option: RelationRecord) => {
    ops
      .create(via, { [cols.own]: recordId, [cols.related]: option.id })
      .then((junction) => {
        setLinks((prev) => [...prev, { junctionId: junction.id, related: option }])
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  const unlink = (link: TagLink) => {
    ops
      .remove(via, link.junctionId)
      .then(() => {
        setLinks((prev) => prev.filter((l) => l.junctionId !== link.junctionId))
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="legend">
        {t(field.label)}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.5 }}>
        {links.map((link) => (
          <RelationTag
            key={link.junctionId}
            label={labelOf(link.related, labelField)}
            disabled={disabled}
            onUnlink={() => unlink(link)}
          />
        ))}
        <Autocomplete<RelationRecord>
          options={options.filter((o) => !linkedIds.has(o.id))}
          filterOptions={(x) => x}
          getOptionLabel={(o) => labelOf(o, labelField)}
          isOptionEqualToValue={(o, v) => o.id === v.id}
          onOpen={prefill}
          onInputChange={(_e, text, reason) => {
            if (reason === 'input') search(text)
          }}
          // Selection immediately becomes a junction row; the input clears for
          // the next link (value stays null on purpose).
          value={null}
          onChange={(_e, option) => {
            if (option) add(option)
          }}
          disabled={disabled}
          size="small"
          sx={{ minWidth: 180, flexGrow: 1 }}
          renderInput={(params) => <TextField {...params} placeholder={t('Add…')} />}
        />
      </Stack>
      {error ? (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
          {error}
        </Typography>
      ) : null}
    </Box>
  )
}

// ── relation/list (one2many) ──────────────────────────────────────────────────

export function RelationListWidget({ field, recordId }: WidgetProps) {
  const t = useT()
  const ops = useRelationOps()
  const rel = relationOf(field)
  const inverseField = rel.inverseField as string // registration validated presence
  const labelField = rel.labelField ?? 'name'
  const [rows, setRows] = useState<RelationRecord[]>([])

  useEffect(() => {
    if (!ops || !recordId) return
    let cancelled = false
    ops
      .list(rel.entity, { filter: { [inverseField]: recordId }, pageSize: EMBED_PAGE_SIZE })
      .then((found) => {
        if (!cancelled) setRows(found)
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
    return () => {
      cancelled = true
    }
  }, [ops, rel.entity, inverseField, recordId])

  if (!ops) return <MissingOpsHint label={t(field.label)} />
  if (!recordId) return <UnsavedHint label={t(field.label)} />

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="legend">
        {t(field.label)}
      </Typography>
      {/* v1 is read-only by design: inline create/edit is a later iteration. */}
      <DataGrid
        rows={rows}
        columns={relatedColumns(rows, labelField, t)}
        autoHeight
        hideFooter
        disableRowSelectionOnClick
      />
    </Box>
  )
}
