'use client'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'
import {
  evaluateCondition,
  normalizeLayout,
  type FieldDescriptor,
  type LayoutNode,
  type ViewDescriptor,
} from './descriptor'
import { fieldWidget } from './widgets'

// The single entry point for descriptor-driven field rendering
// (docs/roadmaps/view-customization.md, Phase 1): walks a descriptor's
// NORMALIZED layout tree (normalizeLayout — the implicit-group fallback when
// no explicit `layout` is declared), dispatching each field leaf through the
// widget layer and each group/row/section to its structural container. Both
// the main FormRenderer and the relation widgets' create-from-search wizard
// go through this — one code path to keep consistent as later phases add
// `move`/`addNode` view-extension operations. No renderer reads
// `descriptor.fields` directly for display order/grouping.

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
    // with zero extra plumbing. visible:false UNMOUNTS the field; its draft
    // value is untouched, so toggling back on shows it unchanged.
    const visible = field.states?.visible ? evaluateCondition(field.states.visible, draft) : true
    if (!visible) return null
    const stateReadOnly = field.states?.readOnly
      ? evaluateCondition(field.states.readOnly, draft)
      : false
    const Widget = fieldWidget(field)
    return (
      <Widget
        field={field}
        value={draft[node.name]}
        onChange={(value) => onFieldChange(node.name, value)}
        disabled={Boolean(field.compute) || stateReadOnly}
        entity={entity}
        recordId={recordId}
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

  if (node.kind === 'row') {
    return (
      <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
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
