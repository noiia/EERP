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
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { DataGrid, type GridColDef, type GridRowParams } from '@mui/x-data-grid'
import { useRouter } from 'next/navigation'
import { useT } from '../i18n/translate'
import { moduleRegistry } from '../registry'
import {
  fieldLabel,
  type FieldDescriptor,
  type RelationDescriptor,
  type ViewDescriptor,
} from './descriptor'
import { useEntityRefreshStore } from './entity-refresh-store'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import { LayoutForm } from './layout-renderer'
import { useNumberFormat } from './format-store'
import { useRelationOps, type RelationOps, type RelationRecord } from './relation-ops'
import { createFormStore, useFormDraft, useFormError } from './stores'
import { layout, tabularNums } from './tokens'
import type { WidgetProps } from './widgets'

// Both wizard dialogs (search + create-from-search) share this width: 95% of
// the viewport, narrowing to a comfortable 75% past `wizardWideBreakpoint` —
// a fixed `sm` cap read as cramped for a real search grid or creation form.
const wizardDialogSx = {
  '& .MuiDialog-paper': {
    width: layout.wizardWidth,
    maxWidth: layout.wizardWidth,
    [`@media (min-width: ${layout.wizardWideBreakpoint}px)`]: {
      width: layout.wizardWideWidth,
      maxWidth: layout.wizardWideWidth,
    },
  },
}

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

/** Exported so other relation-backed widgets can share this one cast+doc
 * comment instead of duplicating it. */
export function relationOf(field: FieldDescriptor): RelationDescriptor {
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

/**
 * Grid columns for related records: labelField first, then other scalars.
 * `extraHidden` drops columns that are redundant in context — a one2many
 * grid's own inverse FK (e.g. sale_line's invoice_id, always the same value
 * on every row of an invoice's line-items table) never earns a column.
 */
function relatedColumns(
  rows: RelationRecord[],
  labelField: string,
  t: (s: string) => string,
  extraHidden: string[] = [],
): GridColDef[] {
  const hidden = new Set(['id', 'tenant_id', 'created_at', 'updated_at', 'deleted_at', ...extraHidden])
  const keys = new Set<string>([labelField])
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!hidden.has(key)) keys.add(key)
    }
  }
  // 6, not 4: a real line-items table (variant/quantity/unit/tax/price) has
  // more than 4 meaningful scalar columns once the id-ish ones are hidden.
  return [...keys].slice(0, 6).map((key) => ({
    field: key,
    headerName: key === labelField ? t('Name') : key,
    flex: 1,
  }))
}

/** Exported so other relation-backed widgets (carousel-widget.tsx,
 * relation-summary-widget.tsx) can reuse the same inert-posture hint instead
 * of duplicating it. */
export function MissingOpsHint({ label }: { label: string | null }) {
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

/** Exported for the same reason as MissingOpsHint above. */
export function UnsavedHint({ label }: { label: string | null }) {
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
    <Dialog open onClose={onClose} maxWidth={false} sx={wizardDialogSx}>
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
    <Dialog open={open} onClose={onClose} maxWidth={false} sx={wizardDialogSx}>
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
          <FontAwesomeIcon icon={byPrefixAndName.fas['link']} size="sm" />
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

/** Exported so relation-summary-widget.tsx can resolve a many2many's own
 * links (loadSubRelation) the same way RelationTagsWidget does. */
export interface TagLink {
  junctionId: string
  related: RelationRecord
}

/**
 * `widgetOptions.deferred: true`'s staged, not-yet-written diff for a
 * many2many field — stored as the field's OWN draft value (a many2many
 * field is otherwise virtual/unstored, so this slot is free real estate;
 * `isVirtualRelation` still strips it from the commit payload, so it never
 * reaches Go). `RelationTagsWidget` reads it to render staged chips;
 * `FormRenderer.onSubmit` (renderers.tsx) flushes it into real junction rows
 * once the record's own save succeeds, then it's gone (commit() reseeds the
 * draft from the server response, which carries no such key).
 */
export interface PendingManyToMany {
  toLink: RelationRecord[]
  toUnlinkJunctionIds: string[]
}

/** The junction's FK columns: declared viaFields or the naming convention. */
/** Exported so relation-summary-widget.tsx can resolve a many2many's
 * default junction column names the same way RelationTagsWidget does. */
export function junctionColumns(rel: RelationDescriptor, ownEntity: string) {
  return {
    own: rel.viaFields?.own ?? `${ownEntity}_id`,
    related: rel.viaFields?.related ?? `${rel.entity}_id`,
  }
}

/**
 * Junction rows -> resolved related records for a many2many relation, in
 * exactly TWO calls (junction list + one batched `in[id]=` related list)
 * regardless of how many rows are linked. Was one `get` per junction row —
 * a real N+1 fan-out both RelationTagsWidget and relation-summary-widget's
 * loadSubRelation hit independently; centralized here so the fix (and any
 * future one) lands once for both. A dangling junction (the related record
 * was deleted) keeps the id as its own placeholder record, the same
 * fallback both callers already had before batching.
 */
export async function resolveManyToManyLinks(
  ops: RelationOps,
  via: string,
  relatedEntity: string,
  cols: { own: string; related: string },
  ownRecordId: string,
): Promise<TagLink[]> {
  const junctions = await ops.list(via, { filter: { [cols.own]: ownRecordId }, pageSize: EMBED_PAGE_SIZE })
  const relatedIds = [
    ...new Set(junctions.map((row) => row[cols.related]).filter((v): v is string => typeof v === 'string')),
  ]
  const related =
    relatedIds.length > 0
      ? await ops.list(relatedEntity, { in: { id: relatedIds }, pageSize: EMBED_PAGE_SIZE })
      : []
  const byId = new Map(related.map((r) => [r.id, r]))
  const links: TagLink[] = []
  for (const row of junctions) {
    const relatedId = row[cols.related]
    if (typeof relatedId !== 'string') continue
    // A dangling junction row (related record deleted) keeps the id as label.
    links.push({ junctionId: row.id, related: byId.get(relatedId) ?? { id: relatedId } })
  }
  return links
}

export function RelationTagsWidget({ field, value, onChange, disabled, entity, recordId }: WidgetProps) {
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
  // widgetOptions.deferred (opt-in, e.g. propertymanagement's current_tenant):
  // stage add/remove in the draft instead of writing junction rows
  // immediately — the record's own Save is what actually persists them
  // (FormRenderer.onSubmit's flush, mirroring the chatter post-save hook).
  // Every other many2many field keeps the original write-on-interaction
  // behavior, unchanged — this is read only when opted in.
  const deferred = field.widgetOptions?.deferred === true
  const pending: PendingManyToMany = (deferred ? (value as PendingManyToMany | undefined) : undefined) ?? {
    toLink: [],
    toUnlinkJunctionIds: [],
  }

  // Links are junction rows: load them, then resolve their related records
  // in one batched call (resolveManyToManyLinks) rather than one per row.
  useEffect(() => {
    if (!ops || !recordId) return
    let cancelled = false
    resolveManyToManyLinks(ops, via, rel.entity, cols, recordId)
      .then((resolved) => {
        if (!cancelled) setLinks(resolved)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
    // Load once per anchor — links then evolve through add/unlink below.
  }, [ops, via, recordId, rel.entity, cols.own, cols.related])

  if (!ops) return <MissingOpsHint label={field.hideLabel ? null : t(fieldLabel(field))} />
  if (!recordId) return <UnsavedHint label={field.hideLabel ? null : t(fieldLabel(field))} />

  // Deferred: the persisted set minus anything staged for removal, plus
  // anything staged for addition (marked `staged` so unlink knows which side
  // of the diff to edit, rather than sniffing a synthetic id shape).
  const visible: (TagLink & { staged?: boolean })[] = deferred
    ? [
        ...links.filter((l) => !pending.toUnlinkJunctionIds.includes(l.junctionId)),
        ...pending.toLink.map((related) => ({ junctionId: `pending:${related.id}`, related, staged: true })),
      ]
    : links
  const linkedIds = new Set(visible.map((l) => l.related.id))

  const add = (option: RelationRecord) => {
    if (deferred) {
      onChange({ ...pending, toLink: [...pending.toLink, option] })
      return
    }
    ops
      .create(via, { [cols.own]: recordId, [cols.related]: option.id })
      .then((junction) => {
        setLinks((prev) => [...prev, { junctionId: junction.id, related: option }])
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  const unlink = (link: TagLink & { staged?: boolean }) => {
    if (deferred) {
      if (link.staged) {
        onChange({ ...pending, toLink: pending.toLink.filter((o) => o.id !== link.related.id) })
      } else {
        onChange({ ...pending, toUnlinkJunctionIds: [...pending.toUnlinkJunctionIds, link.junctionId] })
      }
      return
    }
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
        {visible.map((link) => (
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
  const router = useRouter()
  const ops = useRelationOps()
  const rel = relationOf(field)
  const inverseField = rel.inverseField as string // registration validated presence
  const labelField = rel.labelField ?? 'name'
  const [rows, setRows] = useState<RelationRecord[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  // Bumped by a host action that created/changed rel.entity rows OUTSIDE
  // this widget's own create wizard (e.g. a header button using relationOps
  // directly) — see entity-refresh-store.ts.
  const refreshSignal = useEntityRefreshStore((s) => s.bumps[rel.entity])

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
  }, [ops, rel.entity, inverseField, recordId, refreshSignal])

  if (!ops) return <MissingOpsHint label={field.hideLabel ? null : t(fieldLabel(field))} />
  if (!recordId) return <UnsavedHint label={field.hideLabel ? null : t(fieldLabel(field))} />

  return (
    <Box>
      {!field.hideLabel && (
        <Typography variant="caption" color="text.secondary" component="legend">
          {t(fieldLabel(field))}
        </Typography>
      )}
      {/* Rows stay read-only inline (inline edit is a later iteration); creation
          goes through the wizard line below — the inverse FK is preset, so the
          new record lands in this list by construction. rel.formPath (opt-in —
          absent for sale_lines/quote_lines, which intentionally stay inert on
          click) navigates to the clicked row's own dedicated form instead. */}
      <DataGrid
        rows={rows}
        columns={relatedColumns(rows, labelField, t, [inverseField])}
        autoHeight
        hideFooter
        disableRowSelectionOnClick
        onRowClick={
          rel.formPath
            ? (params: GridRowParams) => router.push(rel.formPath!.replace(':id', String(params.id)))
            : undefined
        }
        sx={rel.formPath ? { '& .MuiDataGrid-row': { cursor: 'pointer' } } : undefined}
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

/**
 * type: 'totals' / widget: 'recap' — the sale/quote form's totals block:
 * Untaxed Amount, one row per DISTINCT tax rate among this record's own line
 * items (each line carries its own rate, from its product/variant — see
 * core/modules/warehouse's Product.TaxRate / ProductVariant.TaxRate
 * override), a divider, then the grand Total. Replaces three bare readOnly
 * fields (subtotal/tax_amount/total) that used to sit in the form body: this
 * widget computes all three live from the SAME lines the sibling one2many
 * grid already fetches (field.relation), so it's never a save round-trip
 * behind what's actually on the form — it doesn't read the record's own
 * stored subtotal/tax_amount/total columns at all, only recomputes the
 * identical math (core/modules/sale/handler.go's sumLines) client-side.
 */
export function TaxTotalsWidget({ field, recordId }: WidgetProps) {
  const t = useT()
  const ops = useRelationOps()
  const { format } = useNumberFormat()
  const rel = relationOf(field)
  const inverseField = rel.inverseField as string
  const [rows, setRows] = useState<RelationRecord[]>([])

  useEffect(() => {
    if (!ops || !recordId) {
      setRows([])
      return
    }
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

  if (!ops || !recordId) return null

  let subtotal = 0
  const taxByRate = new Map<number, number>()
  for (const row of rows) {
    const amount = (Number(row.quantity) || 0) * (Number(row.unit_price) || 0)
    const rate = Number(row.tax_rate) || 0
    subtotal += amount
    taxByRate.set(rate, (taxByRate.get(rate) ?? 0) + amount * rate)
  }
  const taxRows = [...taxByRate.entries()].sort(([a], [b]) => a - b)
  const total = subtotal + taxRows.reduce((sum, [, tax]) => sum + tax, 0)

  return (
    // alignSelf (not ml: 'auto') is what reliably pushes this to the right
    // edge: the parent ("Order lines" page) is a column flex Stack, whose
    // default align-items: stretch otherwise pins a maxWidth-capped item to
    // the START of the cross axis regardless of margin.
    <Stack spacing={0.5} sx={{ maxWidth: 360, alignSelf: 'flex-end' }}>
      <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
        <Typography variant="body2">{t('Untaxed Amount')}:</Typography>
        <Typography variant="body2" sx={{ fontVariantNumeric: tabularNums }}>
          {format(subtotal, { decimals: 2 })}
        </Typography>
      </Stack>
      {taxRows.map(([rate, tax]) => (
        <Stack direction="row" sx={{ justifyContent: 'space-between' }} key={rate}>
          <Typography variant="body2">
            {t('Tax')} {Number((rate * 100).toFixed(2))}%:
          </Typography>
          <Typography variant="body2" sx={{ fontVariantNumeric: tabularNums }}>
            {format(tax, { decimals: 2 })}
          </Typography>
        </Stack>
      ))}
      <Box sx={{ borderTop: '0.5px solid', borderColor: 'divider' }} />
      <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
        <Typography variant="subtitle2">{t('Total')}:</Typography>
        <Typography variant="subtitle2" sx={{ fontVariantNumeric: tabularNums }}>
          {format(total, { decimals: 2 })}
        </Typography>
      </Stack>
    </Stack>
  )
}
