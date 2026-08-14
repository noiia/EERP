'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import ListSubheader from '@mui/material/ListSubheader'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { EntityListOptions } from '../api/list-options'
import { useT } from '../i18n/translate'
import {
  fieldLabel,
  isFieldVisible,
  type FieldDescriptor,
  type FilterCondition,
  type FilterOperator,
  type ViewDescriptor,
} from './descriptor'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import { useRelationOps } from './relation-ops'
import { useSavedFilterOps, type SavedFilterRecord } from './saved-filter-ops'
import { useSessionStore } from './session-store'
import type { HasId } from './stores'
import { layout } from './tokens'
import { useUndoToastStore } from './undo-toast'

// The built-in search bar (docs/adr/ADR-014-search-filter-bar.md): every
// `viewType: 'tree'` route renders one automatically — same "structural
// chrome the engine always provides, no opt-in" posture CreateBar/the
// display-mode switcher take. All filtering happens server-side, through the
// SAME generic list endpoint every other read uses (RelationOps.list —
// already accepts any entity, not just relation targets); this component
// never filters/computes results client-side, only sequences and merges
// already-server-filtered pages for the live-typing leg.
//
// Two independent filtering paths, both writing into the same `onResults` —
// whichever the user touched last wins, visible in the grid. This is a
// deliberate v1 scope cut, not an oversight:
//   - Typing the bar: up to 3 sequential debounced single-column `search[]`
//     calls (priority fields), merged + de-duped client-side by id — "1st
//     name, 2nd id, 3rd module-specified fields".
//   - The dropdown's Filters/Group-by sections: a single call with the
//     structured AND-composed filter set (filter/search/in/gt/gte/lt/lte).
// Composing "typed quick search" AND "structured filters" in one request is
// left for a follow-up once a real use case asks for it.
//
// Applied filters render as chips in the BAR itself (always visible), never
// only inside the dropdown — the dropdown's own "Filters" section holds just
// the add-a-new-filter builder. When the current filters came from applying
// a saved filter, the bar shows ONE consolidated chip (the saved filter's
// name) instead of exploding it into per-condition chips — editing/deleting
// that chip is only offered when the caller owns it (`mine`); a shared
// filter someone else made shows a plain unapply-only close instead, since
// deleting it would 403 server-side (internal/savedfilter's owner check).

const LIVE_SEARCH_DEBOUNCE_MS = 250
const LIVE_SEARCH_PAGE_SIZE = 50
const APPLIED_FILTERS_PAGE_SIZE = 200

const NO_GROUPS: string[] = []

/** Every field name searchable when the user just types, in priority order:
 * declared `search.liveFields` (by ascending `priority`), or the engine
 * default — a field literally named "name" (tree views have no synthesized
 * title field the way forms do — FORM_HEADER_ID is a form-anatomy concept,
 * see ADR-007 — so this checks the declared field name directly, not
 * titleFieldName/normalizeLayout), then "id" (every entity has one, not a
 * declared FieldDescriptor), then every other text/relation field in
 * declaration order. */
function defaultLiveFields<T>(descriptor: ViewDescriptor<T>): string[] {
  const configured = descriptor.search?.liveFields
  if (configured && configured.length > 0) {
    return [...configured].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((c) => c.field)
  }
  const nameField = descriptor.fields.find((f) => f.name === 'name')?.name
  const rest = descriptor.fields
    .map((f) => f.name)
    .filter(
      (name) =>
        name !== nameField &&
        (descriptor.fields.find((f) => f.name === name)?.type === 'text' ||
          descriptor.fields.find((f) => f.name === name)?.type === 'relation'),
    )
  return [nameField, 'id', ...rest].filter((n): n is string => Boolean(n))
}

/** Fields offered in the Filters section: declared `search.filterableFields`
 * or every field, either way gated through the SAME isFieldVisible check
 * forms already use — a field a caller's groups don't grant never appears
 * as a filter option. This is UX/discoverability only; the real boundary is
 * server-side (core/orm/internal/crud.checkColumn). */
function filterableFields<T>(descriptor: ViewDescriptor<T>, callerGroups: string[]): FieldDescriptor[] {
  const names = descriptor.search?.filterableFields
  const candidates = names
    ? descriptor.fields.filter((f) => names.includes(f.name))
    : descriptor.fields
  return candidates.filter((f) => isFieldVisible(f, {}, callerGroups))
}

/** Fields offered in the Group-by section: declared `search.groupableFields`
 * or every selection/relation/boolean field — the field types with a real,
 * closed-ish set of distinct values worth grouping by. Same group gating. */
function groupableFields<T>(descriptor: ViewDescriptor<T>, callerGroups: string[]): FieldDescriptor[] {
  const names = descriptor.search?.groupableFields
  const candidates = names
    ? descriptor.fields.filter((f) => names.includes(f.name))
    : descriptor.fields.filter((f) => f.type === 'selection' || f.type === 'relation' || f.type === 'boolean')
  return candidates.filter((f) => isFieldVisible(f, {}, callerGroups))
}

/** Operators offered for a field, by type — text gets contains (+ eq for an
 * exact match); number/date get eq plus the four range comparisons ("between"
 * is just a gte row and an lte row on the same field); selection/relation/
 * boolean get eq/in (a closed-ish value set, not a free-text range). */
function operatorsFor(field: FieldDescriptor): FilterOperator[] {
  switch (field.type) {
    case 'text':
      return ['contains', 'eq']
    case 'number':
    case 'date':
      return ['eq', 'gt', 'gte', 'lt', 'lte']
    case 'selection':
    case 'relation':
    case 'boolean':
      return ['eq', 'in']
  }
}

function toListOptions(filters: FilterCondition[], pageSize: number): EntityListOptions {
  const options: EntityListOptions = { pageSize }
  for (const f of filters) {
    switch (f.op) {
      case 'eq':
        ;(options.filter ??= {})[f.field] = f.value ?? ''
        break
      case 'contains':
        ;(options.search ??= {})[f.field] = f.value ?? ''
        break
      case 'in':
        ;(options.in ??= {})[f.field] = f.values ?? []
        break
      case 'gt':
        ;(options.gt ??= {})[f.field] = f.value ?? ''
        break
      case 'gte':
        ;(options.gte ??= {})[f.field] = f.value ?? ''
        break
      case 'lt':
        ;(options.lt ??= {})[f.field] = f.value ?? ''
        break
      case 'lte':
        ;(options.lte ??= {})[f.field] = f.value ?? ''
        break
    }
  }
  return options
}

/** A single consolidated chip standing in for an applied saved filter's
 * whole condition set (sub-filters are deliberately not shown while this is
 * on). `onEdit` omitted (a filter the caller doesn't own) drops the pencil
 * entirely and the chip is click-inert — only its delete affordance works,
 * and the caller wires that to a plain unapply rather than a hard delete.
 * The hover-reveal mechanism (opacity 0→1 on both icon slots) mirrors
 * relation-widgets.tsx's RelationTag exactly, just on both edges instead of
 * only the trailing one. */
function CustomFilterChip({
  label,
  onEdit,
  onDelete,
}: {
  label: string
  onEdit?: (anchor: HTMLElement) => void
  onDelete: () => void
}) {
  return (
    <Chip
      label={label}
      size="small"
      color="primary"
      onClick={onEdit ? (e) => onEdit(e.currentTarget) : undefined}
      icon={onEdit ? <FontAwesomeIcon icon={byPrefixAndName.fas['pen']} size="xs" /> : undefined}
      onDelete={onDelete}
      deleteIcon={<FontAwesomeIcon icon={byPrefixAndName.fas['xmark']} size="xs" />}
      sx={{
        '& .MuiChip-icon, & .MuiChip-deleteIcon': { opacity: 0, transition: 'opacity 120ms' },
        '&:hover .MuiChip-icon, &:hover .MuiChip-deleteIcon, &:focus-within .MuiChip-icon, &:focus-within .MuiChip-deleteIcon':
          { opacity: 1 },
      }}
    />
  )
}

export interface SearchBarProps<T extends HasId> {
  descriptor: ViewDescriptor<T>
  /** Replaces the list's currently-shown records — TreeRenderer wires this
   * straight into the same `setLiveRecords` Kanban/Calendar drags already use. */
  onResults: (records: T[]) => void
  /** The records to fall back to when the query/filters are cleared —
   * TreeRenderer's own `initialData`. */
  fallback: T[]
}

export function SearchBar<T extends HasId>({ descriptor, onResults, fallback }: SearchBarProps<T>) {
  const t = useT()
  const relationOps = useRelationOps()
  const savedFilterOps = useSavedFilterOps()
  const callerGroups = useSessionStore((s) => s.identity?.groups ?? NO_GROUPS)

  const [query, setQuery] = useState('')
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [filters, setFilters] = useState<FilterCondition[]>([])
  // Which saved filter (if any) the current `filters`/`groupField` came from
  // — purely a DISPLAY flag: `filters` stays the single source of truth for
  // what's actually applied, this just decides "one consolidated chip" vs
  // "one chip per condition" and carries the record for edit/delete. Cleared
  // by applyFilters on every call, re-set by applySavedFilter right after —
  // so any OTHER path that changes filters (addFilter, removeFilter,
  // applyGroupValue) naturally reverts the display to per-condition chips.
  const [appliedSavedFilter, setAppliedSavedFilter] = useState<SavedFilterRecord | null>(null)
  const [draftField, setDraftField] = useState('')
  const [draftOp, setDraftOp] = useState<FilterOperator | ''>('')
  const [draftValue, setDraftValue] = useState('')
  const [groupField, setGroupField] = useState<string | null>(null)
  const [groupValues, setGroupValues] = useState<{ value: string; total: number }[] | null>(null)
  const [groupLoading, setGroupLoading] = useState(false)
  const [savedFilters, setSavedFilters] = useState<SavedFilterRecord[]>([])
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveShared, setSaveShared] = useState(false)

  const liveFields = useMemo(() => defaultLiveFields(descriptor), [descriptor])
  const filterFields = useMemo(
    () => filterableFields(descriptor, callerGroups),
    [descriptor, callerGroups],
  )
  const groupFields = useMemo(
    () => groupableFields(descriptor, callerGroups),
    [descriptor, callerGroups],
  )

  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (liveTimer.current) clearTimeout(liveTimer.current) }, [])

  function onQueryChange(text: string) {
    setQuery(text)
    if (liveTimer.current) clearTimeout(liveTimer.current)
    liveTimer.current = setTimeout(() => {
      liveTimer.current = null
      if (!text) {
        onResults(fallback)
        return
      }
      if (!relationOps) return
      void (async () => {
        const seen = new Set<string>()
        const merged: T[] = []
        for (const field of liveFields) {
          try {
            const page = await relationOps.list(descriptor.entity, {
              search: { [field]: text },
              pageSize: LIVE_SEARCH_PAGE_SIZE,
            })
            for (const record of page) {
              if (!seen.has(record.id)) {
                seen.add(record.id)
                merged.push(record as unknown as T)
              }
            }
          } catch {
            // One field's search failing (e.g. a transient network error)
            // shouldn't blank out matches the other fields already found.
          }
        }
        onResults(merged)
      })()
    }, LIVE_SEARCH_DEBOUNCE_MS)
  }

  async function applyFilters(next: FilterCondition[]) {
    setFilters(next)
    setAppliedSavedFilter(null)
    if (next.length === 0) {
      onResults(fallback)
      return
    }
    if (!relationOps) return
    const records = await relationOps.list(descriptor.entity, toListOptions(next, APPLIED_FILTERS_PAGE_SIZE))
    onResults(records as unknown as T[])
  }

  function addFilter() {
    if (!draftField || !draftOp) return
    const next: FilterCondition =
      draftOp === 'in'
        ? { field: draftField, op: draftOp, values: draftValue.split(',').map((v) => v.trim()).filter(Boolean) }
        : { field: draftField, op: draftOp, value: draftValue }
    void applyFilters([...filters.filter((f) => !(f.field === draftField && f.op === draftOp)), next])
    setDraftField('')
    setDraftOp('')
    setDraftValue('')
  }

  function removeFilter(index: number) {
    void applyFilters(filters.filter((_, i) => i !== index))
  }

  async function openGroupField(name: string) {
    setGroupField(name)
    setGroupValues(null)
    if (!relationOps?.distinctValues) return
    setGroupLoading(true)
    try {
      const values = await relationOps.distinctValues(
        descriptor.entity,
        name,
        toListOptions(filters, 0),
      )
      setGroupValues(values)
    } finally {
      setGroupLoading(false)
    }
  }

  function applyGroupValue(field: string, value: string) {
    void applyFilters([...filters.filter((f) => f.field !== field), { field, op: 'eq', value }])
    setAnchorEl(null)
  }

  async function openMenu(el: HTMLElement) {
    setAnchorEl(el)
    if (savedFilterOps) {
      try {
        setSavedFilters(await savedFilterOps.list(descriptor.entity))
      } catch {
        setSavedFilters([])
      }
    }
  }

  function applySavedFilter(saved: SavedFilterRecord) {
    void applyFilters(saved.config.filters)
    setAppliedSavedFilter(saved)
    if (saved.config.groupBy) void openGroupField(saved.config.groupBy)
    setAnchorEl(null)
  }

  /** Unapply without touching the backend — the caller-doesn't-own-it path
   * for the bar's consolidated chip, and never destructive. */
  function unapplySavedFilter() {
    setAppliedSavedFilter(null)
    void applyFilters([])
  }

  async function saveCurrentFilters() {
    if (!savedFilterOps || !saveName) return
    const created = await savedFilterOps.create(descriptor.entity, saveName, saveShared, {
      filters,
      groupBy: groupField ?? undefined,
    })
    setSavedFilters((prev) => [...prev, created])
    setSaveOpen(false)
    setSaveName('')
    setSaveShared(false)
  }

  /** Hard-deletes a saved filter the caller owns, through the generic undo
   * toast (docs — see undo-toast.tsx): the row disappears from view/list
   * immediately, the actual DELETE only fires if the undo window elapses
   * un-recovered, and recovering restores both the list entry and — when it
   * was the currently-applied one — re-applies it exactly as it was. */
  function deleteSavedFilter(saved: SavedFilterRecord) {
    if (!savedFilterOps) return
    const wasApplied = appliedSavedFilter?.id === saved.id
    const priorFilters = filters
    const priorGroupField = groupField

    setSavedFilters((prev) => prev.filter((sf) => sf.id !== saved.id))
    if (wasApplied) {
      setAppliedSavedFilter(null)
      void applyFilters([])
      setGroupField(null)
      setGroupValues(null)
    }

    useUndoToastStore.getState().show({
      message: `${t('Deleted')} "${saved.name}"`,
      onRecover: () => {
        setSavedFilters((prev) => [...prev, saved])
        if (wasApplied) {
          void applyFilters(priorFilters)
          setAppliedSavedFilter(saved)
          if (priorGroupField) void openGroupField(priorGroupField)
        }
      },
      onExpire: () => {
        void savedFilterOps.remove(saved.id)
      },
    })
  }

  const menuOpen = Boolean(anchorEl)
  const stopKeyPropagation = (e: React.KeyboardEvent) => e.stopPropagation()

  return (
    <Box sx={{ mb: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <TextField
        size="small"
        placeholder={t('Search…')}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onClick={(e) => void openMenu(e.currentTarget)}
        sx={{
          width: `${layout.searchBarMaxWidth}px`,
          maxWidth: '100%',
          [`@media (max-width: ${layout.searchBarNarrowBreakpoint}px)`]: {
            width: layout.searchBarNarrowWidth,
          },
        }}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <FontAwesomeIcon icon={byPrefixAndName.fas['magnifying-glass']} size="sm" />
              </InputAdornment>
            ),
          },
        }}
      />
      {(appliedSavedFilter || filters.length > 0) && (
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', justifyContent: 'center' }}>
          {appliedSavedFilter ? (
            <CustomFilterChip
              label={appliedSavedFilter.name}
              onEdit={appliedSavedFilter.mine ? (el) => setAnchorEl(el) : undefined}
              onDelete={
                appliedSavedFilter.mine
                  ? () => deleteSavedFilter(appliedSavedFilter)
                  : unapplySavedFilter
              }
            />
          ) : (
            filters.map((f, i) => (
              <Chip
                key={`${f.field}-${f.op}-${i}`}
                size="small"
                label={`${fieldLabelOf(descriptor, f.field)} ${f.op} ${f.op === 'in' ? (f.values ?? []).join(', ') : f.value}`}
                onDelete={() => removeFilter(i)}
              />
            ))
          )}
        </Stack>
      )}
      <Menu
        anchorEl={anchorEl}
        open={menuOpen}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{
          paper: {
            // 10px narrower than the bar on each side, centered on it
            // (anchorOrigin/transformOrigin above) — the bar's own live
            // width, not a fixed guess, so it tracks the narrow-viewport
            // breakpoint automatically.
            sx: { width: anchorEl ? anchorEl.offsetWidth - 20 : 360, maxWidth: '90vw' },
          },
        }}
      >
        <ListSubheader>{t('Filters')}</ListSubheader>
        <MenuItem disableRipple sx={{ cursor: 'default' }}>
          <Stack direction="row" spacing={1} sx={{ width: '100%' }} onClick={(e) => e.stopPropagation()}>
            <Select
              size="small"
              displayEmpty
              value={draftField}
              onKeyDown={stopKeyPropagation}
              onChange={(e) => {
                setDraftField(e.target.value)
                setDraftOp('')
              }}
              sx={{ minWidth: 90 }}
            >
              <MenuItem value="">
                <em>{t('Field')}</em>
              </MenuItem>
              {filterFields.map((f) => (
                <MenuItem key={f.name} value={f.name}>
                  {t(fieldLabel(f))}
                </MenuItem>
              ))}
            </Select>
            <Select
              size="small"
              displayEmpty
              value={draftOp}
              disabled={!draftField}
              onKeyDown={stopKeyPropagation}
              onChange={(e) => setDraftOp(e.target.value as FilterOperator)}
              sx={{ minWidth: 80 }}
            >
              <MenuItem value="">
                <em>{t('Op')}</em>
              </MenuItem>
              {(draftField ? operatorsFor(filterFields.find((f) => f.name === draftField)!) : []).map((op) => (
                <MenuItem key={op} value={op}>
                  {op}
                </MenuItem>
              ))}
            </Select>
            <TextField
              size="small"
              placeholder={draftOp === 'in' ? t('a, b, c') : t('Value')}
              value={draftValue}
              onKeyDown={stopKeyPropagation}
              onChange={(e) => setDraftValue(e.target.value)}
            />
            <IconButton
              size="small"
              aria-label={t('Add filter')}
              disabled={!draftField || !draftOp}
              onClick={addFilter}
            >
              <FontAwesomeIcon icon={byPrefixAndName.fas['plus']} size="sm" />
            </IconButton>
          </Stack>
        </MenuItem>

        <Divider />
        <ListSubheader>{t('Group by')}</ListSubheader>
        {groupFields.map((f) => (
          <MenuItem key={f.name} onClick={(e) => { e.stopPropagation(); void openGroupField(f.name) }}>
            {t(fieldLabel(f))}
          </MenuItem>
        ))}
        {groupField && (
          <Box sx={{ px: 2, py: 1 }}>
            {groupLoading ? (
              <Typography variant="caption">{t('Loading…')}</Typography>
            ) : (
              <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                {(groupValues ?? []).map((v) => (
                  <Chip
                    key={v.value}
                    size="small"
                    label={`${v.value || t('(none)')} (${v.total})`}
                    onClick={() => applyGroupValue(groupField, v.value)}
                  />
                ))}
              </Stack>
            )}
          </Box>
        )}

        <Divider />
        <ListSubheader>{t('Saved filters')}</ListSubheader>
        {savedFilters.map((sf) => (
          <MenuItem key={sf.id} onClick={() => applySavedFilter(sf)}>
            <Box sx={{ flexGrow: 1 }}>
              {sf.name} {sf.shared ? t('(shared)') : ''}
            </Box>
            {sf.mine && (
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteSavedFilter(sf)
                }}
              >
                <FontAwesomeIcon icon={byPrefixAndName.fas['xmark']} size="sm" />
              </IconButton>
            )}
          </MenuItem>
        ))}
        <MenuItem disableRipple sx={{ cursor: 'default' }}>
          {saveOpen ? (
            <Stack direction="row" spacing={1} sx={{ width: '100%' }} onClick={(e) => e.stopPropagation()}>
              <TextField
                size="small"
                placeholder={t('Name')}
                value={saveName}
                onKeyDown={stopKeyPropagation}
                onChange={(e) => setSaveName(e.target.value)}
              />
              <FormControlLabel
                control={<Checkbox size="small" checked={saveShared} onChange={(e) => setSaveShared(e.target.checked)} />}
                label={t('Shared')}
              />
              <Button size="small" disabled={!saveName} onClick={() => void saveCurrentFilters()}>
                {t('Save')}
              </Button>
            </Stack>
          ) : (
            <Button
              size="small"
              disabled={filters.length === 0 || !savedFilterOps}
              onClick={(e) => {
                e.stopPropagation()
                setSaveOpen(true)
              }}
            >
              {t('Save current as…')}
            </Button>
          )}
        </MenuItem>
      </Menu>
    </Box>
  )
}

function fieldLabelOf<T>(descriptor: ViewDescriptor<T>, name: string): string {
  const field = descriptor.fields.find((f) => f.name === name)
  return field ? fieldLabel(field) : name
}
