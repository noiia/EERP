'use client'
import { useEffect, useRef, useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import SvgIcon from '@mui/material/SvgIcon'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { DataGrid, type GridColDef } from '@mui/x-data-grid'
import { useT } from '../i18n/translate'
import { moduleRegistry } from '../registry'
import {
  fieldLabel,
  type FieldDescriptor,
  type RelationDescriptor,
  type ViewDescriptor,
} from './descriptor'
import { LayoutForm } from './layout-renderer'
import { useRelationOps, type RelationOps, type RelationRecord } from './relation-ops'
import { createFormStore, useFormDraft, useFormError } from './stores'
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
// 6 result rows; the create-from-search line below them is the 7th.
const SEARCH_PAGE_SIZE = 6
const EMBED_PAGE_SIZE = 100

/**
 * The synthetic 7th dropdown option: "Create a new <entity>". A reserved id no
 * real record can carry (UUIDs) marks it; picking it opens the creation wizard.
 */
const CREATE_OPTION_ID = '__create__'

function isCreateOption(record: RelationRecord): boolean {
  return record.id === CREATE_OPTION_ID
}

/** Humanize an entity/table name for display: 'crm_tag' → "Crm tag". */
function entityDisplayName(entity: string): string {
  const words = entity.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

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
 * A linked record rendered as a tag. Idle: centered label, the unlink cross
 * out of layout flow entirely (not just invisible) so the tag is exactly as
 * wide as its text. On hover/keyboard focus: the label makes room on the
 * right (padding transition) while the cross fades in over that space —
 * activating it unlinks (m2o -> null, m2m -> junction row removed).
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
        position: 'relative',
        '& .MuiChip-label': { textAlign: 'center', transition: 'padding-right 120ms' },
        '& .MuiChip-deleteIcon': {
          position: 'absolute',
          top: '50%',
          right: 4,
          margin: 0,
          transform: 'translateY(-50%)',
          opacity: 0,
          transition: 'opacity 120ms',
        },
        '&:hover .MuiChip-label, &:focus-within .MuiChip-label': { paddingRight: '20px' },
        '&:hover .MuiChip-deleteIcon, &:focus-within .MuiChip-deleteIcon': { opacity: 1 },
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

function MissingOpsHint({ label }: { label: string | null }) {
  const t = useT()
  return (
    <Box>
      {label != null && (
        <Typography variant="caption" color="text.secondary" component="legend">
          {label}
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary">
        {t('Relation data is not wired on this host.')}
      </Typography>
    </Box>
  )
}

function UnsavedHint({ label }: { label: string | null }) {
  const t = useT()
  return (
    <Box>
      {label != null && (
        <Typography variant="caption" color="text.secondary" component="legend">
          {label}
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary">
        {t('Available once the record has been saved.')}
      </Typography>
    </Box>
  )
}

// ── create-from-search wizard (all relation kinds) ───────────────────────────

/**
 * The creation form of the aimed table: the target entity's own registered
 * form descriptor when one exists (its module already declared how the record
 * is edited), else a minimal one-field form on the labelField — enough for
 * bare lookup tables (tags) that never ship a view.
 */
function creationDescriptor(rel: RelationDescriptor): ViewDescriptor {
  const registered = moduleRegistry.formDescriptorFor(rel.entity)
  if (registered) return registered
  const labelField = rel.labelField ?? 'name'
  return {
    entity: rel.entity,
    viewType: 'form',
    fields: [{ name: labelField, type: 'text', required: true }],
  }
}

/**
 *"Create a new <entity>" dialog. A real form store over the target's creation
 * descriptor, bound to RelationOps.create — so seed defaults, on_change,
 * computes, and store:false stripping all behave exactly as on the entity's
 * own form, and Go authorizes the POST with the caller's session. `preset`
 * seeds draft values the caller owns (the o2m inverse FK, the typed search
 * text as the label); preset FK fields are hidden — the wizard never asks for
 * what the context already decided. Mount only while open: each opening gets a
 * fresh store, so drafts never leak between creations.
 */
function RelationCreateWizard({
  rel,
  ops,
  preset = {},
  hidden = [],
  onClose,
  onCreated,
}: {
  rel: RelationDescriptor
  ops: RelationOps
  preset?: Record<string, unknown>
  hidden?: string[]
  onClose: () => void
  onCreated: (record: RelationRecord) => void
}) {
  const t = useT()
  const [descriptor] = useState(() => creationDescriptor(rel))
  const [store] = useState(() =>
    createFormStore<RelationRecord>(
      // Registry descriptors are ViewDescriptor<unknown-record>; the wizard's
      // records are RelationRecords (id + open columns) — same runtime shape.
      descriptor as ViewDescriptor<RelationRecord>,
      {
        create: (body) => ops.create(rel.entity, body as Record<string, unknown>),
        update: () => {
          throw new Error('unreachable: creation drafts have no id')
        },
      },
      preset as Partial<RelationRecord>,
    ),
  )
  const draft = useFormDraft(store)
  const error = useFormError(store)
  const [submitting, setSubmitting] = useState(false)
  const hiddenSet = new Set(hidden)
  const { setField } = store.getState()

  async function submit() {
    setSubmitting(true)
    try {
      const saved = await store.getState().commit()
      if (saved) {
        onCreated(saved)
        onClose()
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <Box>
        <DialogTitle>
          {t('Create a new')} {t(entityDisplayName(rel.entity))}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ pt: 1 }}>
            {error ? (
              <Typography variant="caption" color="error">
                {error.message}
              </Typography>
            ) : null}
            {/* Same entry point the main FormRenderer uses (layout-renderer.tsx):
                walks the target descriptor's normalized layout tree, so a
                registered form's grouping/rows render here too, not just a
                flat field dump. `hidden` skips the preset inverse FK (o2m). */}
            <LayoutForm
              descriptor={descriptor}
              draft={draft as Record<string, unknown>}
              onFieldChange={(name, value) => setField(name, value)}
              entity={rel.entity}
              // No id yet: service-backed widgets (picture/signature) and
              // o2m/m2m render their unsaved-record hint, as on any new form.
              recordId={null}
              hidden={hiddenSet}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={onClose} disabled={submitting}>
            {t('Cancel')}
          </Button>
          <Button variant="contained" onClick={submit} disabled={submitting}>
            {t('Create')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  )
}

/**
 * Append the create line as the dropdown's last option (the 7th — result rows
 * are capped at SEARCH_PAGE_SIZE by the server query).
 */
function withCreateOption(options: RelationRecord[]): RelationRecord[] {
  return [...options, { id: CREATE_OPTION_ID }]
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
  const [createOpen, setCreateOpen] = useState(false)
  // The live input text — prefilled into the creation form's labelField.
  const [inputText, setInputText] = useState('')

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

  if (!ops) return <MissingOpsHint label={field.hideLabel ? null : t(fieldLabel(field))} />

  const pick = (record: RelationRecord) => {
    setSelectedLabel(labelOf(record, labelField))
    onChange(record.id)
  }

  return (
    <Box>
      {!field.hideLabel && (
        <Typography variant="caption" color="text.secondary" component="legend">
          {t(fieldLabel(field))}
        </Typography>
      )}
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
            options={withCreateOption(options)}
            // Go already filtered server-side; re-filtering on the label would
            // hide records whose match is on another column.
            filterOptions={(x) => x}
            getOptionLabel={(o) =>
              isCreateOption(o)
                ? `${t('Create a new')} ${t(entityDisplayName(rel.entity))}`
                : labelOf(o, labelField)
            }
            // The synthetic create row renders in the theme's PRIMARY color —
            // the same accent a color="primary" Button uses — so it reads as
            // an action among the plain-text record options, not a record.
            renderOption={(props, option) => {
              const { key, ...optionProps } = props
              return (
                <li key={key} {...optionProps}>
                  {isCreateOption(option) ? (
                    <Typography component="span" color="primary">
                      {t('Create a new')} {t(entityDisplayName(rel.entity))}
                    </Typography>
                  ) : (
                    labelOf(option, labelField)
                  )}
                </li>
              )
            }}
            isOptionEqualToValue={(o, v) => o.id === v.id}
            onOpen={prefill}
            onInputChange={(_e, text, reason) => {
              // Only user typing counts: selecting an option fires a 'reset'
              // that must not wipe the text before the wizard reads it.
              if (reason === 'input') {
                setInputText(text)
                search(text)
              }
            }}
            onChange={(_e, option) => {
              if (!option) return
              if (isCreateOption(option)) setCreateOpen(true)
              else pick(option)
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
      {createOpen ? (
        <RelationCreateWizard
          rel={rel}
          ops={ops}
          // The typed search text seeds the new record's label.
          preset={inputText ? { [labelField]: inputText } : {}}
          onClose={() => setCreateOpen(false)}
          // The freshly created record becomes the FK, exactly like a pick.
          onCreated={pick}
        />
      ) : null}
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
  const [createOpen, setCreateOpen] = useState(false)
  const [inputText, setInputText] = useState('')

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

  if (!ops) return <MissingOpsHint label={field.hideLabel ? null : t(fieldLabel(field))} />
  if (!recordId) return <UnsavedHint label={field.hideLabel ? null : t(fieldLabel(field))} />

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
      {!field.hideLabel && (
        <Typography variant="caption" color="text.secondary" component="legend">
          {t(fieldLabel(field))}
        </Typography>
      )}
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
          options={withCreateOption(options.filter((o) => !linkedIds.has(o.id)))}
          filterOptions={(x) => x}
          getOptionLabel={(o) =>
            isCreateOption(o)
              ? `${t('Create a new')} ${t(entityDisplayName(rel.entity))}`
              : labelOf(o, labelField)
          }
          // See the m2o search widget: same primary-colored create row.
          renderOption={(props, option) => {
            const { key, ...optionProps } = props
            return (
              <li key={key} {...optionProps}>
                {isCreateOption(option) ? (
                  <Typography component="span" color="primary">
                    {t('Create a new')} {t(entityDisplayName(rel.entity))}
                  </Typography>
                ) : (
                  labelOf(option, labelField)
                )}
              </li>
            )
          }}
          isOptionEqualToValue={(o, v) => o.id === v.id}
          onOpen={prefill}
          onInputChange={(_e, text, reason) => {
            // 'reset' (option selected) must not wipe the text the wizard reads.
            if (reason === 'input') {
              setInputText(text)
              search(text)
            }
          }}
          // Selection immediately becomes a junction row; the input clears for
          // the next link (value stays null on purpose).
          value={null}
          onChange={(_e, option) => {
            if (!option) return
            if (isCreateOption(option)) setCreateOpen(true)
            else add(option)
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
      {createOpen ? (
        <RelationCreateWizard
          rel={rel}
          ops={ops}
          preset={inputText ? { [labelField]: inputText } : {}}
          onClose={() => setCreateOpen(false)}
          // The freshly created record links immediately: one junction row.
          onCreated={add}
        />
      ) : null}
    </Box>
  )
}

// ── relation/list (one2many) ──────────────────────────────────────────────────

export function RelationListWidget({ field, disabled, recordId }: WidgetProps) {
  const t = useT()
  const ops = useRelationOps()
  const rel = relationOf(field)
  const inverseField = rel.inverseField as string // registration validated presence
  const labelField = rel.labelField ?? 'name'
  const [rows, setRows] = useState<RelationRecord[]>([])
  const [createOpen, setCreateOpen] = useState(false)

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

  if (!ops) return <MissingOpsHint label={field.hideLabel ? null : t(fieldLabel(field))} />
  if (!recordId) return <UnsavedHint label={field.hideLabel ? null : t(fieldLabel(field))} />

  return (
    <Box>
      {!field.hideLabel && (
        <Typography variant="caption" color="text.secondary" component="legend">
          {t(fieldLabel(field))}
        </Typography>
      )}
      {/* Rows stay read-only (inline edit is a later iteration); creation goes
          through the wizard line below — the inverse FK is preset, so the new
          record lands in this list by construction. */}
      <DataGrid
        rows={rows}
        columns={relatedColumns(rows, labelField, t)}
        autoHeight
        hideFooter
        disableRowSelectionOnClick
      />
      {/* Explicit color="primary" — matches the m2o/m2m dropdown's create row
          rather than relying on the Button default staying primary. */}
      <Button
        size="small"
        color="primary"
        onClick={() => setCreateOpen(true)}
        disabled={disabled}
        sx={{ mt: 0.5 }}
      >
        {t('Create a new')} {t(entityDisplayName(rel.entity))}
      </Button>
      {createOpen ? (
        <RelationCreateWizard
          rel={rel}
          ops={ops}
          // The context decides the link: preset the inverse FK, never ask for it.
          preset={{ [inverseField]: recordId }}
          hidden={[inverseField]}
          onClose={() => setCreateOpen(false)}
          onCreated={(record) => setRows((prev) => [...prev, record])}
        />
      ) : null}
    </Box>
  )
}
