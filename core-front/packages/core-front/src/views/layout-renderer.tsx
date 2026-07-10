'use client'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'
import {
  evaluateCondition,
  fieldLabel,
  normalizeLayout,
  FORM_HEADER_ID,
  type FieldDescriptor,
  type LayoutNode,
  type ViewDescriptor,
} from './descriptor'
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
      placeholder={t(fieldLabel(field))}
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
    const disabled = Boolean(field.compute) || stateReadOnly
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
