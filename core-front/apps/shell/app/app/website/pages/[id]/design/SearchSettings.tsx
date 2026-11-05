'use client'
import type { ReactNode } from 'react'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormGroup from '@mui/material/FormGroup'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { byPrefixAndName, FontAwesomeIcon, useT } from '@eerp/core-front'
import type { PublishedTable } from '@/lib/website-settings'
import type { SearchConfig, SearchTarget } from '@/website/types'
import { InspectorSection } from './Inspector'

/** The name-like field a new target's title defaults to, if the table has one. */
const guessTitle = (fields: string[]) => fields.find((f) => ['name', 'title', 'display_name'].includes(f)) ?? ''

/** Every column a target reads — what must be published for it to return anything. */
export function targetFields(t: SearchTarget): string[] {
  return [...new Set([t.title_field, ...(t.search_fields ?? []), t.picture_field ?? ''].filter(Boolean))]
}

/** The search block's settings: the bar's placeholder and per-table result count, then
 * one card per table searched — its table, the section label results show under, the
 * title shown for each result, the columns the text is matched against (default: the
 * title), an optional picture and the detail page a result opens. */
export function SearchSettings({ blockId, config, tables, pages, onChange, renderPublish }: {
  blockId: string
  config: SearchConfig
  tables: PublishedTable[]
  pages: { slug: string; title: string; published: boolean }[]
  onChange: (config: SearchConfig) => void
  /** The "not public yet" banner for a target's table (BlockSettings' PublishFields). */
  renderPublish: (table: PublishedTable, used: string[]) => ReactNode
}) {
  const t = useT()
  const targets = Array.isArray(config.targets) ? config.targets : []
  const id = (k: string) => `block-${blockId}-${k}`
  const put = (next: SearchTarget[]) => onChange({ ...config, targets: next })
  const patch = (i: number, p: Partial<SearchTarget>) => put(targets.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const free = tables.filter((p) => !targets.some((x) => x.table === p.table))

  return (
    <>
      <InspectorSection title={t('Search bar')}>
        <TextField id={id('placeholder')} size="small" label={t('Placeholder')} value={config.placeholder ?? ''}
          onChange={(e) => onChange({ ...config, placeholder: e.target.value })} />
        <TextField id={id('limit')} size="small" type="number" label={t('Results per table')} value={config.limit ?? ''}
          slotProps={{ htmlInput: { min: 1, max: 20 } }}
          onChange={(e) => onChange({ ...config, limit: e.target.value === '' ? undefined : Number(e.target.value) })} />
      </InspectorSection>
      <InspectorSection title={t('Searched tables')} hint={t('Results are grouped by table, in this order.')}>
        {targets.length === 0 && <Typography variant="body2" color="text.secondary">{t('Add a table to search in.')}</Typography>}
        {targets.map((target, i) => {
          const meta = tables.find((p) => p.table === target.table)
          const fields = meta?.declared ?? []
          const searched = target.search_fields ?? []
          const k = (s: string) => id(`t${i}-${s}`)
          return (
            <Stack key={i} spacing={1.25} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <TextField id={k('table')} select size="small" fullWidth label={t('Table')} value={target.table}
                  onChange={(e) => {
                    const next = tables.find((p) => p.table === e.target.value)
                    patch(i, { table: e.target.value, title_field: guessTitle(next?.declared ?? []), search_fields: [], picture_field: '' })
                  }}>
                  {tables.filter((p) => p.table === target.table || !targets.some((x) => x.table === p.table))
                    .map((p) => <MenuItem key={p.table} value={p.table}>{p.table}</MenuItem>)}
                </TextField>
                <IconButton size="small" aria-label={t('Move up')} disabled={i === 0}
                  onClick={() => put(targets.map((x, j) => (j === i - 1 ? targets[i] : j === i ? targets[i - 1] : x)))}>
                  <FontAwesomeIcon icon={byPrefixAndName.fas['chevron-up']} />
                </IconButton>
                <IconButton size="small" aria-label={t('Remove table')} onClick={() => put(targets.filter((_, j) => j !== i))}>
                  <FontAwesomeIcon icon={byPrefixAndName.fas.xmark} />
                </IconButton>
              </Stack>
              <TextField id={k('label')} size="small" label={t('Section label')} placeholder={target.table} value={target.label ?? ''}
                onChange={(e) => patch(i, { label: e.target.value })} />
              <TextField id={k('title')} select size="small" label={t('Title field')} value={target.title_field}
                onChange={(e) => patch(i, { title_field: e.target.value })}>
                {fields.map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
              </TextField>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{t('Search in')}</Typography>
              <FormGroup role="group" aria-label={t('Search in')} sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', '& .MuiFormControlLabel-label': { overflowWrap: 'anywhere', fontSize: '0.8125rem' } }}>
                {fields.map((f) => (
                  <FormControlLabel key={f} label={f} control={
                    <Checkbox size="small" checked={searched.length ? searched.includes(f) : f === target.title_field}
                      onChange={(e) => {
                        const base = searched.length ? searched : target.title_field ? [target.title_field] : []
                        patch(i, { search_fields: e.target.checked ? [...base, f] : base.filter((x) => x !== f) })
                      }} />
                  } />
                ))}
              </FormGroup>
              <TextField id={k('picture')} select size="small" label={t('Picture field')} value={target.picture_field ?? ''}
                onChange={(e) => patch(i, { picture_field: e.target.value })}>
                <MenuItem value="">{t('None')}</MenuItem>
                {(meta?.pictures ?? []).map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
              </TextField>
              <TextField id={k('detail')} select size="small" label={t('Detail page')} value={target.detail_slug ?? ''}
                onChange={(e) => patch(i, { detail_slug: e.target.value })}>
                <MenuItem value="">{t('None')}</MenuItem>
                {pages.map((p) => <MenuItem key={p.slug} value={p.slug}>{p.title} (/{p.slug}){p.published ? '' : ` — ${t('not published')}`}</MenuItem>)}
                {target.detail_slug && !pages.some((p) => p.slug === target.detail_slug) &&
                  <MenuItem value={target.detail_slug}>{target.detail_slug} — {t('page not found')}</MenuItem>}
              </TextField>
              {meta && renderPublish(meta, targetFields(target))}
            </Stack>
          )
        })}
        {free.length > 0 && (
          <Button size="small" sx={{ alignSelf: 'flex-start' }} startIcon={<FontAwesomeIcon icon={byPrefixAndName.fas.plus} />}
            onClick={() => put([...targets, { table: free[0].table, title_field: guessTitle(free[0].declared), search_fields: [] }])}>
            {t('Add table')}
          </Button>
        )}
      </InspectorSection>
    </>
  )
}
