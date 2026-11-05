'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import InputAdornment from '@mui/material/InputAdornment'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { FontAwesomeIcon, byPrefixAndName, useT } from '@eerp/core-front'
import type { SearchGroup, SearchHit } from '../search'
import type { SearchConfig } from '../types'
import { safeHref } from '../urls'

export const SEARCH_DEBOUNCE_MS = 250
const MIN_QUERY = 2

type Option = SearchHit & { group: string }

/** Visitor-facing search bar: results from every table the block names, grouped by
 * table, fetched as the visitor types from /api/site-search/:page/:block (the BFF reads
 * the tables from the published page). Picking a result opens its detail page. Without
 * a page id (the editor preview) the field is shown but inert. */
export function SearchBlock({ config, pageId, blockId }: { config: SearchConfig; pageId?: string; blockId: string }) {
  const t = useT()
  const router = useRouter()
  const [text, setText] = useState('')
  const [groups, setGroups] = useState<SearchGroup[]>([])
  const [loading, setLoading] = useState(false)
  const query = text.trim()

  useEffect(() => {
    if (!pageId || query.length < MIN_QUERY) { setGroups([]); setLoading(false); return }
    const ctrl = new AbortController()
    setLoading(true)
    const timer = setTimeout(() => {
      fetch(`/api/site-search/${encodeURIComponent(pageId)}/${encodeURIComponent(blockId)}?q=${encodeURIComponent(query)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { groups: [] }))
        .then((body: { groups?: SearchGroup[] }) => { setGroups(body.groups ?? []); setLoading(false) })
        .catch(() => { if (!ctrl.signal.aborted) { setGroups([]); setLoading(false) } })
    }, SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [pageId, blockId, query])

  const options = useMemo<Option[]>(() => groups.flatMap((g) => g.hits.map((h) => ({ ...h, group: g.label }))), [groups])
  const noOptions = query.length < MIN_QUERY ? t('Type at least 2 characters') : t('No results')

  return (
    <Box sx={{ height: '100%', display: 'flex', alignItems: 'center' }}>
      <Autocomplete<Option>
        fullWidth disabled={!pageId}
        options={options} loading={loading} filterOptions={(x) => x}
        groupBy={(o) => o.group}
        getOptionLabel={(o) => o.title}
        getOptionKey={(o) => `${o.group}:${o.id}`}
        inputValue={text} onInputChange={(_, v, reason) => { if (reason !== 'reset') setText(v) }}
        value={null} blurOnSelect clearOnBlur={false}
        noOptionsText={noOptions} loadingText={t('Searching…')}
        onChange={(_, o) => {
          const href = o ? safeHref(o.href) : undefined
          if (href) router.push(href)
        }}
        renderOption={(props, o) => {
          const { key, ...rest } = props as typeof props & { key: string }
          return (
            <Box component="li" key={key} {...rest} sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
              {o.picture
                ? <Box component="img" src={o.picture} alt="" loading="lazy" sx={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 0.5, flexShrink: 0 }} />
                : <Box sx={{ width: 32, flexShrink: 0 }} />}
              <Typography variant="body2" sx={{ color: o.href ? 'text.primary' : 'text.secondary' }}>{o.title}</Typography>
            </Box>
          )
        }}
        renderInput={(params) => (
          <TextField {...params} size="small" type="search"
            placeholder={config.placeholder?.trim() || t('Search')}
            slotProps={{
              ...params.slotProps,
              htmlInput: { ...params.slotProps.htmlInput, 'aria-label': config.placeholder?.trim() || t('Search') },
              input: {
                ...params.slotProps.input,
                startAdornment: <InputAdornment position="start"><FontAwesomeIcon icon={byPrefixAndName.fas['magnifying-glass']} /></InputAdornment>,
              },
            }} />
        )}
      />
    </Box>
  )
}
