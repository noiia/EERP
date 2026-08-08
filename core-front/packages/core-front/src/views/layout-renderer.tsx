'use client'
import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { serializeError, toApiError, type SerializedError } from '../api/errors'
import { usePermission } from '../auth/Can'
import { useT } from '../i18n/translate'
import {
  evaluateCondition,
  fieldLabel,
  isFieldVisible,
  normalizeLayout,
  FORM_HEADER_ID,
  type FieldDescriptor,
  type LayoutContainerNode,
  type LayoutNode,
  type ViewDescriptor,
} from './descriptor'
import { ErrorAlert } from './error-alert'
import { useNotebookOps, type NotebookPageRecord } from './notebook-ops'
import { layout as layoutTokens, typeScale } from './tokens'
import { fieldWidget } from './widgets'

// The single entry point for descriptor-driven field rendering
// (docs/roadmaps/view-customization.md, Phase 1): walks a descriptor's
// NORMALIZED layout tree (normalizeLayout — the implicit-group fallback when
// no explicit `layout` is declared, or the header/two-column default for an
// un-layouted form — docs/roadmaps/responsive-displays.md, Phase 3),
// dispatching each field leaf through the widget layer and each group/row/
// section to its structural container. Both the main FormRenderer and the
// relation widgets' create-from-search wizard go through this — one code
// path to keep consistent as later phases add `move`/`addNode` view-extension
// operations. No renderer reads `descriptor.fields` directly for display
// order/grouping.

export interface LayoutFormProps<T> {
  descriptor: ViewDescriptor<T>
  draft: Record<string, unknown>
  onFieldChange: (name: string, value: unknown) => void
  entity: string
  recordId: string | null
  /** Field names to skip entirely — the o2m create wizard hides its preset inverse FK. */
  hidden?: ReadonlySet<string>
}

export function LayoutForm<T>({
  descriptor,
  draft,
  onFieldChange,
  entity,
  recordId,
  hidden,
}: LayoutFormProps<T>) {
  const fieldsByName = new Map(descriptor.fields.map((f) => [f.name, f]))
  const nodes = normalizeLayout(descriptor)
  return (
    <>
      {nodes.map((node, i) => (
        <LayoutNodeView
          key={node.kind === 'field' ? node.name : (node.id ?? i)}
          node={node}
          fieldsByName={fieldsByName}
          draft={draft}
          onFieldChange={onFieldChange}
          entity={entity}
          recordId={recordId}
          hidden={hidden}
        />
      ))}
    </>
  )
}

/**
 * The `variant: 'title'` rendering for a field leaf (docs/roadmaps/
 * responsive-displays.md, Phase 3) — a large, borderless-until-focus input
 * with the label as a placeholder instead of the normal boxed TextField.
 * Deliberately a thin wrapper around the SAME `TextField`, not a different
 * widget dispatch: the field stays a real text field — required/disabled
 * still apply, so the built-in asterisk/error affordances survive the
 * restyle. Only ever used for `type: 'text'` fields in practice (the
 * synthesized form header's title field, or an explicit layout opting in).
 */
function TitleField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FieldDescriptor
  value: unknown
  onChange: (value: unknown) => void
  disabled: boolean
}) {
  const t = useT()
  return (
    <TextField
      variant="standard"
      placeholder={field.hideLabel ? undefined : t(fieldLabel(field))}
      required={field.required}
      disabled={disabled}
      fullWidth
      value={(value as string) ?? ''}
      onChange={(e) => onChange(e.target.value)}
      slotProps={{ input: { disableUnderline: true } }}
      sx={{
        '& .MuiInputBase-input': {
          fontSize: typeScale.h3.fontSize,
          fontWeight: typeScale.h3.fontWeight,
          lineHeight: typeScale.h3.lineHeight,
          padding: 0,
        },
      }}
    />
  )
}

/**
 * One RUNTIME (stored) page's editor — a user-created tab, as opposed to a
 * declared `page` layout node (docs/roadmaps/responsive-displays.md, Phase
 * 5). Mirrors the declared pages' "stay mounted, toggle `hidden`" posture
 * (Architecture decision 6) via its OWN local title/content state, which is
 * how a dirty edit here survives switching to another tab and back WITHOUT
 * touching the record's form draft at all — `NotebookOps.update` is the only
 * write path, so saving a page can never dirty the form store.
 */
function StoredPageEditor({
  page,
  hidden,
  ops,
  onSaved,
  onDeleted,
}: {
  page: NotebookPageRecord
  hidden: boolean
  ops: NonNullable<ReturnType<typeof useNotebookOps>>
  onSaved: (updated: NotebookPageRecord) => void
  onDeleted: (id: string) => void
}) {
  const t = useT()
  const [title, setTitle] = useState(page.title)
  const [content, setContent] = useState(page.content)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<SerializedError | null>(null)
  const dirty = title !== page.title || content !== page.content

  const onSave = () => {
    setBusy(true)
    setError(null)
    void ops
      .update(page.id, { title, content })
      .then(onSaved)
      .catch((e: unknown) => {
        setError(serializeError(toApiError(e)))
        // Revert to the last known-good values — the same
        // revert-and-ErrorAlert posture Kanban/Calendar's optimistic field
        // move takes on a rejected write.
        setTitle(page.title)
        setContent(page.content)
      })
      .finally(() => setBusy(false))
  }

  const onDelete = () => {
    setBusy(true)
    setError(null)
    void ops
      .remove(page.id)
      .then(() => onDeleted(page.id))
      .catch((e: unknown) => {
        setError(serializeError(toApiError(e)))
        setBusy(false)
      })
  }

  return (
    <Box hidden={hidden}>
      <Stack spacing={2}>
        {error ? <ErrorAlert error={error} /> : null}
        <TextField
          label={t('Title')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
          fullWidth
        />
        <TextField
          label={t('Content')}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          disabled={busy}
          fullWidth
          multiline
          minRows={4}
        />
        <Stack direction="row" spacing={1}>
          <Button variant="contained" size="small" disabled={busy || !dirty} onClick={onSave}>
            {t('Save')}
          </Button>
          <Button color="error" size="small" disabled={busy} onClick={onDelete}>
            {t('Delete')}
          </Button>
        </Stack>
      </Stack>
    </Box>
  )
}

/**
 * A `notebook` node (docs/roadmaps/responsive-displays.md, Phase 4): MUI
 * `Tabs` (scrollable, so an overflowing tab strip never breaks layout) over
 * `normalizeLayout`'s validated `page` children — each page's title doubles
 * as its tab label. The active tab is local, ephemeral state: switching
 * pages never touches the form draft, and every page's content stays
 * MOUNTED at all times (`hidden`, never a conditional `{active === i && …}`)
 * — an inactive page's fields keep their mount effects (pictures, relation
 * widgets) alive and never lose in-progress state, and a dirty draft on one
 * page survives switching to another and back (Architecture decision 6).
 *
 * Phase 5 appends RUNTIME pages after the declared ones, in the SAME tab
 * strip, when a `NotebookOpsProvider` is mounted and the record has an id —
 * absent either, the notebook renders its declared pages alone, inert, the
 * same posture RelationOps/GraphOps take for a host with no wiring. Stored
 * tab keys are namespaced (`s:` / `d:`) so a declared id can never collide
 * with a stored row's UUID.
 */
function NotebookNode({
  node,
  fieldsByName,
  draft,
  onFieldChange,
  entity,
  recordId,
  hidden,
}: {
  /** Validated by `normalizeLayout`: every child is a `page` (a titled
   * container) — never anything else. */
  node: LayoutContainerNode
  fieldsByName: Map<string, FieldDescriptor>
  draft: Record<string, unknown>
  onFieldChange: (name: string, value: unknown) => void
  entity: string
  recordId: string | null
  hidden?: ReadonlySet<string>
}) {
  const t = useT()
  const [active, setActive] = useState(0)
  const pages = node.children as LayoutContainerNode[]

  const ops = useNotebookOps()
  const canWrite = usePermission('notebook_pages:notebook_pages:write')
  const [storedPages, setStoredPages] = useState<NotebookPageRecord[]>([])
  const [addBusy, setAddBusy] = useState(false)
  const [opsError, setOpsError] = useState<SerializedError | null>(null)

  // Re-fetch whenever the anchor changes (a different record, or the ops
  // wiring itself). No recordId yet (a brand-new record) means no pages can
  // exist for it — skip the call entirely rather than querying a null anchor.
  // A failed LIST degrades silently to "no stored pages" — same inert
  // posture as no NotebookOpsProvider mounted at all — rather than an
  // ErrorAlert: this is a background, supplementary fetch nobody asked for
  // (unlike Add/Save/Delete below, which DO surface failures, because a
  // user just took an action and needs to know it didn't work). A form over
  // a virtual entity whose id isn't a UUID (e.g. the App Store's `modules`)
  // is the concrete case this matters for — Go's anchor validation legitimately
  // rejects it, and that must never look like the whole form is broken.
  useEffect(() => {
    if (!ops || !recordId) {
      setStoredPages([])
      return
    }
    let cancelled = false
    ops
      .list(entity, recordId)
      .then((found) => {
        if (!cancelled) setStoredPages(found)
      })
      .catch(() => {
        if (!cancelled) setStoredPages([])
      })
    return () => {
      cancelled = true
    }
  }, [ops, entity, recordId])

  const onAdd = () => {
    if (!ops || !recordId) return
    setAddBusy(true)
    setOpsError(null)
    const newIndex = pages.length + storedPages.length
    ops
      .create(entity, recordId, t('New page'))
      .then((created) => {
        setStoredPages((prev) => [...prev, created])
        setActive(newIndex)
      })
      .catch((e: unknown) => setOpsError(serializeError(toApiError(e))))
      .finally(() => setAddBusy(false))
  }

  const onPageSaved = (updated: NotebookPageRecord) => {
    setStoredPages((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
  }

  // Simplest safe behavior on delete: fall back to the first tab (declared
  // Settings) rather than trying to keep some other stored page active
  // through an index shift.
  const onPageDeleted = (id: string) => {
    setStoredPages((prev) => prev.filter((p) => p.id !== id))
    setActive(0)
  }

  // Hidden entirely without the write permission (CreateBar's posture);
  // disabled with a hint until the record has an id (the picture widgets'
  // exact posture) when the permission IS granted.
  const showAdd = ops != null && canWrite
  const addButton = (
    <Button size="small" disabled={addBusy || !recordId} onClick={onAdd}>
      {t('+ Add page')}
    </Button>
  )

  return (
    <Box>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', borderBottom: 1, borderColor: 'divider', mb: 2 }}
      >
        <Tabs
          value={active}
          onChange={(_event, value: number) => setActive(value)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ flexGrow: 1, minHeight: 0, borderBottom: 0 }}
        >
          {pages.map((page, i) => (
            <Tab key={`d:${page.id ?? i}`} label={t(page.title ?? '')} />
          ))}
          {storedPages.map((page) => (
            // Stored titles are user data, never translated (msgids are
            // static developer strings; a record's own page title is not).
            <Tab key={`s:${page.id}`} label={page.title} />
          ))}
        </Tabs>
        {showAdd ? (
          recordId ? (
            addButton
          ) : (
            <Tooltip title={t('Available once the record has been saved.')}>
              <span>{addButton}</span>
            </Tooltip>
          )
        ) : null}
      </Stack>
      {opsError ? <ErrorAlert error={opsError} /> : null}
      {pages.map((page, i) => (
        <Box key={`d:${page.id ?? i}`} hidden={active !== i}>
          <Stack spacing={2.5}>
            {page.children.map((child, j) => (
              <LayoutNodeView
                key={child.kind === 'field' ? child.name : (child.id ?? j)}
                node={child}
                fieldsByName={fieldsByName}
                draft={draft}
                onFieldChange={onFieldChange}
                entity={entity}
                recordId={recordId}
                hidden={hidden}
              />
            ))}
          </Stack>
        </Box>
      ))}
      {ops
        ? storedPages.map((page, i) => (
            <StoredPageEditor
              key={`s:${page.id}`}
              page={page}
              hidden={active !== pages.length + i}
              ops={ops}
              onSaved={onPageSaved}
              onDeleted={onPageDeleted}
            />
          ))
        : null}
    </Box>
  )
}

function LayoutNodeView({
  node,
  fieldsByName,
  draft,
  onFieldChange,
  entity,
  recordId,
  hidden,
}: {
  node: LayoutNode
  fieldsByName: Map<string, FieldDescriptor>
  draft: Record<string, unknown>
  onFieldChange: (name: string, value: unknown) => void
  entity: string
  recordId: string | null
  hidden?: ReadonlySet<string>
}) {
  const t = useT()

  if (node.kind === 'field') {
    if (hidden?.has(node.name)) return null
    const field = fieldsByName.get(node.name)
    // normalizeLayout already guarantees every leaf resolves for a registered
    // descriptor — this can't actually be missing outside a test fixture bug.
    if (!field) return null
    // Declarative states (Phase 2), reevaluated against the CURRENT draft on
    // every render — draft changes re-render this component (Zustand
    // subscription), so visibility/readOnly react to the user's own edits
    // with zero extra plumbing. Hidden (static `invisible` or `states.visible:
    // false`) UNMOUNTS the field; its draft value is untouched, so toggling
    // states.visible back on shows it unchanged.
    if (!isFieldVisible(field, draft)) return null
    const stateReadOnly = field.states?.readOnly
      ? evaluateCondition(field.states.readOnly, draft)
      : false
    // Static readOnly (docs/roadmaps/app-store.md, Phase 2) OR's in alongside
    // compute and the declarative states.readOnly — static wins, since
    // nothing here can turn it back on.
    const disabled = Boolean(field.compute) || field.readOnly === true || stateReadOnly
    if (node.variant === 'title') {
      return (
        <TitleField
          field={field}
          value={draft[node.name]}
          onChange={(value) => onFieldChange(node.name, value)}
          disabled={disabled}
        />
      )
    }
    const Widget = fieldWidget(field)
    return (
      <Widget
        field={field}
        value={draft[node.name]}
        onChange={(value) => onFieldChange(node.name, value)}
        disabled={disabled}
        entity={entity}
        recordId={recordId}
      />
    )
  }

  // `notebook` renders its `page` children itself (each needs its own tab +
  // visibility toggle, not the flat concatenated `children` every other
  // container kind uses below) — handled before that generic computation so
  // a notebook never pays for building an unused children array, and never
  // falls through to a kind-agnostic renderer that knows nothing about tabs.
  if (node.kind === 'notebook') {
    return (
      <NotebookNode
        node={node}
        fieldsByName={fieldsByName}
        draft={draft}
        onFieldChange={onFieldChange}
        entity={entity}
        recordId={recordId}
        hidden={hidden}
      />
    )
  }

  const children = node.children.map((child, i) => (
    <LayoutNodeView
      key={child.kind === 'field' ? child.name : (child.id ?? i)}
      node={child}
      fieldsByName={fieldsByName}
      draft={draft}
      onFieldChange={onFieldChange}
      entity={entity}
      recordId={recordId}
      hidden={hidden}
    />
  ))

  // `columns` is a rendering hint orthogonal to `kind` (docs/roadmaps/
  // responsive-displays.md, Phase 3): a CSS grid of up to `columns` columns,
  // collapsing to one when the container itself — never the viewport — is
  // narrower than `layout.formTwoColumnMinWidth`. `containerType` is set on
  // an OUTER wrapper (a container query can't target the element it sizes),
  // so this works self-contained wherever the node renders: full-width on
  // the form page, or single-column inside the relation wizard's narrow
  // dialog — no cooperation needed from the caller.
  if (node.columns) {
    return (
      <Box sx={{ containerType: 'inline-size' }}>
        {node.title ? (
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            {t(node.title)}
          </Typography>
        ) : null}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: '1fr',
            gap: 2.5,
            alignItems: 'start',
            [`@container (min-width: ${layoutTokens.formTwoColumnMinWidth}px)`]: {
              gridTemplateColumns: `repeat(${node.columns}, 1fr)`,
            },
          }}
        >
          {children}
        </Box>
      </Box>
    )
  }

  if (node.kind === 'row') {
    // The synthesized form header is the one row that must NOT stack on
    // phone — a picture beside a big title reads fine side-by-side even at
    // 360px, and stacking it would bury the title below an avatar-sized
    // image for no benefit. Every OTHER row (hand-authored ones included,
    // e.g. crminheritdemo's) stacks below `sm`, per the roadmap's "fully
    // responsive" contract — a non-wrapping row is the thing that actually
    // overflows on a phone.
    const isHeader = node.id === FORM_HEADER_ID
    return (
      <Stack
        direction={isHeader ? 'row' : { xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ alignItems: isHeader ? 'center' : { xs: 'stretch', sm: 'flex-start' } }}
      >
        {node.title ? (
          <Typography variant="subtitle2" sx={{ width: '100%' }}>
            {t(node.title)}
          </Typography>
        ) : null}
        {children}
      </Stack>
    )
  }

  if (node.kind === 'section') {
    return (
      <Box>
        {node.title ? (
          <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>
            {t(node.title)}
          </Typography>
        ) : null}
        <Stack spacing={2}>{children}</Stack>
      </Box>
    )
  }

  // group — spacing MATCHES the pre-layout-tree FormRenderer's flat Stack, so
  // the implicit (no explicit `layout`) case renders pixel-equivalent: the
  // outer form Stack (spacing 2.5) plus this inner one (spacing 2.5) produce
  // the exact same vertical rhythm as the old single flat Stack did — nesting
  // doesn't compound MUI's Stack spacing, it only adds a transparent wrapper.
  return (
    <Stack spacing={2.5}>
      {node.title ? <Typography variant="subtitle2">{t(node.title)}</Typography> : null}
      {children}
    </Stack>
  )
}
