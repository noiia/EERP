'use client'
import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { GraphField, GraphFieldDraft } from '../api/graph'
import { useT } from '../i18n/translate'
import { CALC_KEY_PREFIX } from './graph-aggregate'

// Calculated-field UI for the Graph view's edit mode: the left-hand list
// (delete button visible on hover only) and the "new field" dialog. Fields are
// chart-only and shared by every tile type — see graph-aggregate.ts's
// evalFormula for the formula language and internal/graphfield (Go) for the
// role-gated, hard-deleted storage.

/**
 * Edit-mode left column: "+ Add widget" on top, then the Variables bloc —
 * "+ Add field" first, then one sub-bloc per calculated field, its × visible
 * only while hovering that sub-bloc.
 */
export function CalcFieldsPanel({
  fields,
  onAddWidget,
  onAdd,
  onEdit,
  onDelete,
}: {
  fields: GraphField[]
  onAddWidget: () => void
  onEdit: (field: GraphField) => void
  /** Absent when the host has no calculated-field support: hides the Variables bloc. */
  onAdd?: () => void
  onDelete: (field: GraphField) => void
}) {
  const t = useT()
  return (
    <Box data-testid="graph-calc-fields" sx={{ width: 220, flexShrink: 0, pr: 1.5 }}>
      <Button variant="outlined" size="small" fullWidth sx={{ mb: 1 }} onClick={onAddWidget}>
        {t('+ Add widget')}
      </Button>
      {onAdd ? (
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1 }}>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            {t('Variables')}
          </Typography>
          <Button size="small" fullWidth sx={{ mb: 0.5 }} onClick={onAdd}>
            {t('+ Add field')}
          </Button>
          <Stack spacing={0.5}>
            {fields.map((f) => (
              <Box
                key={f.id}
                data-testid={`graph-calc-field-${f.key}`}
                title={f.formula}
                onClick={() => onEdit(f)}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 1,
                  pl: 1,
                  cursor: 'pointer',
                  minHeight: 32,
                  '& .calc-delete': { visibility: 'hidden' },
                  '&:hover .calc-delete': { visibility: 'visible' },
                }}
              >
                <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                  {f.label}
                </Typography>
                <IconButton className="calc-delete" size="small" aria-label={t('Delete field')} onClick={(e) => {
                    e.stopPropagation()
                    onDelete(f)
                  }}>
                  ×
                </IconButton>
              </Box>
            ))}
          </Stack>
        </Box>
      ) : null}
    </Box>
  )
}

/** "acme profit!" → "acme_profit"; kept ≤ 40 chars so key + suffix fit Go's 56. */
function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field'
}

export function CalcFieldDialog({
  open,
  initial,
  numberFieldNames,
  onClose,
  onSubmit,
}: {
  open: boolean
  /** Present = edit that field (its key is kept); absent = create. */
  initial?: GraphField | null
  /** Names insertable into the formula: real number fields + existing calc keys. */
  numberFieldNames: string[]
  onClose: () => void
  onSubmit: (draft: GraphFieldDraft) => Promise<string | null>
}) {
  const t = useT()
  const [label, setLabel] = useState('')
  const [formula, setFormula] = useState('')
  const [roles, setRoles] = useState('')
  const [dated, setDated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Seed the form each time the dialog opens: the edited field, or blanks.
  useEffect(() => {
    if (!open) return
    setLabel(initial?.label ?? '')
    setFormula(initial?.formula ?? '')
    setRoles(initial?.roles.join(', ') ?? '')
    setDated(initial?.dated ?? false)
    setError(null)
  }, [open, initial])

  async function submit() {
    const draft: GraphFieldDraft = {
      key: initial?.key ?? `${CALC_KEY_PREFIX}${slug(label)}_${Math.random().toString(36).slice(2, 6)}`,
      label: label.trim(),
      formula: formula.trim(),
      roles: roles.split(',').map((r) => r.trim()).filter(Boolean),
      dated,
    }
    const err = await onSubmit(draft)
    if (err) return setError(err)
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{initial ? t('Edit calculated field') : t('Add calculated field')}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label={t('Label')} value={label} onChange={(e) => setLabel(e.target.value)} fullWidth />
          <TextField
            label={t('Formula')}
            value={formula}
            onChange={(e) => setFormula(e.target.value)}
            helperText={t('Fields, numbers, + - * / and parentheses, e.g. rent_price - loan_amount')}
            fullWidth
          />
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
            {numberFieldNames.map((n) => (
              <Chip key={n} size="small" label={n} onClick={() => setFormula((f) => `${f}${f && !f.endsWith(' ') ? ' ' : ''}${n}`)} />
            ))}
          </Stack>
          <TextField
            label={t('Roles allowed to see it (comma-separated, empty = everyone)')}
            value={roles}
            onChange={(e) => setRoles(e.target.value)}
            fullWidth
          />
          <FormControlLabel
            control={<Checkbox checked={dated} onChange={(e) => setDated(e.target.checked)} />}
            label={t('Date variable: compute for each dated line (e.g. each rent receipt)')}
          />
          {error ? <Alert severity="warning">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('Cancel')}</Button>
        <Button variant="contained" disabled={!label.trim() || !formula.trim()} onClick={() => void submit()}>
          {initial ? t('Save') : t('Add')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
