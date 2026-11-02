'use client'
import { useEffect, useState } from 'react'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'
import { listEditorPages, listFormTargets } from '@/website/editor-actions'
import { addPreset, addressPrefixes, MAX_FORM_TARGETS, newFieldId, removeTarget, typeableColumns, usedColumns, type FormPreset } from '@/website/form-config'
import { FORM_FIELD_TYPES, type FormConfig, type FormField, type FormFieldType, type FormTargetSpec } from '@/website/types'

const TYPE_LABELS: Record<FormFieldType, string> = {
  text: 'Text', long: 'Long text', email: 'Email', phone: 'Phone', number: 'Number', date: 'Date',
  checkbox: 'Checkbox', select: 'Selection', address: 'Address',
}
const PRESETS: { key: FormPreset; label: string }[] = [
  { key: 'user', label: 'User data' }, { key: 'address', label: 'Address' }, { key: 'message', label: 'Message' },
]
const box = { border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 } as const

type Target = { table: string; columns: string[] }
type Page = { slug: string; title: string; published: boolean }

/** The Form block's settings (ADR-033): the tables a submission writes (registered in
 * Go — `listFormTargets`), how they link, the fields and where each one is stored,
 * then what happens after a submit and whether the visitor must be logged in. */
export function FormSettings({ blockId, config, onChange }: { blockId: string; config: FormConfig; onChange: (c: FormConfig) => void }) {
  const t = useT()
  const [registry, setRegistry] = useState<Target[]>([])
  const [pages, setPages] = useState<Page[]>([])
  useEffect(() => {
    void listFormTargets().then(setRegistry)
    void listEditorPages().then(setPages)
  }, [])
  const c = config
  const set = (patch: Partial<FormConfig>) => onChange({ ...c, ...patch })
  const id = (k: string) => `block-${blockId}-${k}`
  const columnsOf = (i: number) => registry.find((r) => r.table === c.targets[i]?.table)?.columns ?? []
  const n = (msgid: string, i: number) => t(msgid).replace('{n}', String(i + 1))

  const setTarget = (i: number, patch: Partial<FormTargetSpec>) => set({ targets: c.targets.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
  const setField = (i: number, patch: Partial<FormField>) => set({ fields: c.fields.map((x, j) => (j === i ? { ...x, ...patch } : x)) })

  // A page picker: the site's pages (home excluded, it can't take a path) plus a kept unknown slug.
  const pagePicker = (key: string, label: string, value: string, onPick: (slug: string) => void, none: string) => (
    <TextField key={key} id={id(key)} select size="small" label={t(label)} value={value} onChange={(e) => onPick(e.target.value)}>
      <MenuItem value="">{t(none)}</MenuItem>
      {pages.map((p) => <MenuItem key={p.slug} value={p.slug}>{p.title} (/{p.slug}){p.published ? '' : ` — ${t('not published')}`}</MenuItem>)}
      {value && !pages.some((p) => p.slug === value) && <MenuItem value={value}>{value} — {t('page not found')}</MenuItem>}
    </TextField>
  )

  const targetBox = (tg: FormTargetSpec, i: number) => {
    const cols = columnsOf(i)
    const links = tg.links ?? {}
    const fixed = Object.entries(tg.fixed ?? {})
    const free = cols.filter((col) => !usedColumns(c, i).has(col))
    const putFixed = (rows: [string, string][]) => setTarget(i, { fixed: Object.fromEntries(rows) })
    return (
      <Stack key={i} data-testid={`form-target-${i}`} spacing={1} sx={box}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="body2" sx={{ fontWeight: 600, flex: 1 }}>{n('Target {n}', i)}</Typography>
          {c.targets.length > 1 && <IconButton size="small" aria-label={n('Remove target {n}', i)} onClick={() => onChange(removeTarget(c, i))}>×</IconButton>}
        </Stack>
        {/* A new table: its links and fixed values go, and its fields need a new column. */}
        <TextField id={id(`target-${i}-table`)} select size="small" label={t('Table')} value={registry.some((r) => r.table === tg.table) ? tg.table : ''}
          onChange={(e) => onChange({ ...c, targets: c.targets.map((x, j) => (j === i ? { table: e.target.value } : x)),
            fields: c.fields.map((f) => (f.target === i ? { ...f, column: '' } : f)) })}>
          {registry.map((r) => <MenuItem key={r.table} value={r.table}>{r.table}</MenuItem>)}
        </TextField>
        {/* Ids are never typed by visitors: they come from an earlier target's new record, or a fixed value. */}
        {i > 0 && cols.filter((col) => col.endsWith('_id') && !(tg.fixed ?? {})[col]).map((col) => (
          <TextField key={col} id={id(`target-${i}-link-${col}`)} select size="small" label={col} value={col in links ? String(links[col]) : ''}
            onChange={(e) => {
              const next = { ...links }
              if (e.target.value === '') delete next[col]
              else next[col] = Number(e.target.value)
              setTarget(i, { links: next })
            }}>
            <MenuItem value="">{t('Not linked')}</MenuItem>
            {c.targets.slice(0, i).map((x, j) => <MenuItem key={j} value={String(j)}>{n('← record of target {n}', j)} ({x.table})</MenuItem>)}
          </TextField>
        ))}
        {fixed.map(([col, v], k) => (
          <Stack key={k} direction="row" spacing={1}>
            <TextField select size="small" label={t('Column')} value={col} sx={{ minWidth: 120 }}
              onChange={(e) => putFixed(fixed.map((r, j) => (j === k ? [e.target.value, r[1]] : r)))}>
              {[col, ...free].map((o) => <MenuItem key={o} value={o}>{o}</MenuItem>)}
            </TextField>
            <TextField size="small" label={t('Fixed value')} value={v} onChange={(e) => putFixed(fixed.map((r, j) => (j === k ? [r[0], e.target.value] : r)))} />
            <IconButton aria-label={t('Remove fixed value')} onClick={() => putFixed(fixed.filter((_, j) => j !== k))}>×</IconButton>
          </Stack>
        ))}
        {free.length > 0 && (
          <Button size="small" sx={{ alignSelf: 'flex-start' }} onClick={() => putFixed([...fixed, [free[0], '']])}>{t('Add fixed value')}</Button>
        )}
      </Stack>
    )
  }

  const fieldBox = (f: FormField, i: number) => {
    const cols = columnsOf(f.target)
    const options = f.type === 'address' ? addressPrefixes(cols) : typeableColumns(cols)
    return (
      <Stack key={i} data-testid={`form-field-${i}`} spacing={1} sx={box}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <TextField id={id(`field-${i}-label`)} size="small" label={t('Label')} value={f.label} sx={{ flex: 1 }} onChange={(e) => setField(i, { label: e.target.value })} />
          <IconButton size="small" aria-label={t('Remove field')} onClick={() => set({ fields: c.fields.filter((_, j) => j !== i) })}>×</IconButton>
        </Stack>
        <Stack direction="row" spacing={1}>
          {/* Switching to or from an address changes what the column means (a prefix): pick it again. */}
          <TextField id={id(`field-${i}-type`)} select size="small" label={t('Type')} value={f.type} sx={{ flex: 1 }}
            onChange={(e) => {
              const type = e.target.value as FormFieldType
              setField(i, { type, ...((type === 'address') !== (f.type === 'address') ? { column: '' } : {}) })
            }}>
            {FORM_FIELD_TYPES.map((ty) => <MenuItem key={ty} value={ty}>{t(TYPE_LABELS[ty])}</MenuItem>)}
          </TextField>
          {c.targets.length > 1 && (
            <TextField id={id(`field-${i}-target`)} select size="small" label={t('Stored in')} value={String(f.target)} sx={{ flex: 1 }}
              onChange={(e) => setField(i, { target: Number(e.target.value), column: '' })}>
              {c.targets.map((x, j) => <MenuItem key={j} value={String(j)}>{n('Target {n}', j)} ({x.table})</MenuItem>)}
            </TextField>
          )}
          <TextField id={id(`field-${i}-column`)} select size="small" label={t('Column')} value={options.includes(f.column) ? f.column : ''} sx={{ flex: 1 }}
            onChange={(e) => setField(i, { column: e.target.value })}>
            {options.map((o) => <MenuItem key={o} value={o}>{o}</MenuItem>)}
          </TextField>
        </Stack>
        {f.type === 'select' && (
          <TextField id={id(`field-${i}-options`)} size="small" multiline minRows={2} label={t('Options (one per line)')}
            value={(f.options ?? []).join('\n')} onChange={(e) => setField(i, { options: e.target.value.split('\n') })}
            onBlur={() => setField(i, { options: (f.options ?? []).map((o) => o.trim()).filter(Boolean) })} />
        )}
        <FormControlLabel label={t('Required')} control={<Checkbox size="small" checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} />} />
      </Stack>
    )
  }

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle2">{t('Saved into')}</Typography>
      <Typography variant="caption" color="text.secondary">
        {t('Each submission creates one record per target, in order. Only tables and columns a module allows are offered.')}
      </Typography>
      {c.targets.map(targetBox)}
      {c.targets.length < MAX_FORM_TARGETS && registry.length > 0 && (
        <Button size="small" sx={{ alignSelf: 'flex-start' }} onClick={() => set({ targets: [...c.targets, { table: registry[0].table }] })}>{t('Add target')}</Button>
      )}

      <Typography variant="subtitle2">{t('Fields')}</Typography>
      <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: 'wrap' }}>
        {PRESETS.map((p) => {
          const next = addPreset(c, p.key)
          return <Button key={p.key} size="small" variant="outlined" disabled={!next} onClick={() => next && onChange(next)}>{t(p.label)}</Button>
        })}
      </Stack>
      {c.fields.map(fieldBox)}
      <Button size="small" sx={{ alignSelf: 'flex-start' }}
        onClick={() => set({ fields: [...c.fields, { id: newFieldId(c), label: '', type: 'text', column: '', target: 0 }] })}>{t('Add field')}</Button>
      <TextField id={id('submit_label')} size="small" label={t('Button label')} placeholder={t('Send')} value={c.submit_label ?? ''}
        onChange={(e) => set({ submit_label: e.target.value })} />

      <Typography variant="subtitle2">{t('After submit')}</Typography>
      <TextField id={id('after-kind')} select size="small" label={t('Then')} value={c.after?.kind ?? 'message'}
        onChange={(e) => set({ after: { ...c.after, kind: e.target.value as 'message' | 'page' } })}>
        <MenuItem value="message">{t('Show a message')}</MenuItem>
        <MenuItem value="page">{t('Go to a page')}</MenuItem>
      </TextField>
      {(c.after?.kind ?? 'message') === 'message'
        ? <TextField id={id('after-message')} size="small" multiline minRows={2} label={t('Message')} placeholder={t('Thank you — your answers were sent.')}
          value={c.after?.message ?? ''} onChange={(e) => set({ after: { ...c.after, message: e.target.value } })} />
        : pagePicker('after-slug', 'Page', c.after?.slug ?? '', (slug) => set({ after: { ...c.after, slug } }), 'None')}

      <FormControlLabel label={t('Login required')}
        control={<Switch checked={!!c.login_required} onChange={(e) => set({ login_required: e.target.checked })} />} />
      {c.login_required
        ? pagePicker('after_login_slug', 'After login, go to', c.after_login_slug ?? '', (slug) => set({ after_login_slug: slug }), 'This page')
        : <FormControlLabel label={t('Allow account creation')}
          control={<Switch checked={!!c.allow_signup} onChange={(e) => set({ allow_signup: e.target.checked })} />} />}
    </Stack>
  )
}
