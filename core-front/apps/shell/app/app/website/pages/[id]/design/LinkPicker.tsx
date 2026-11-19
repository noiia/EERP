'use client'
import { useEffect, useState } from 'react'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { useT } from '@eerp/core-front'
import { listEditorPages } from '@/website/editor-actions'
import { kindOf, SYSTEM_PAGES, type LinkKind } from '@/website/links'
import { safeHref } from '@/website/urls'

type Page = { slug: string; title: string; published: boolean }

const KINDS: [LinkKind, string][] = [
  ['none', 'None'], ['page', 'Site page'], ['login', 'Login'], ['signup', 'Sign up'], ['account', 'My account'], ['external', 'External link'],
]

/** A link destination: a site page, Login, Sign up, My account or an external URL.
 * Stored as `href` (`/<slug>`, `/login`, `/signup`, `/account` or the URL) plus `next`,
 * the bare slug of the page Login / Sign up return to ('' = the account page). The kind
 * is inferred from the stored href; an unpicked-yet kind is held locally. */
export function LinkPicker({ id, label, href, next, onChange }: {
  id: string; label: string; href: string; next: string
  onChange: (href: string, next: string) => void
}) {
  const t = useT()
  const [pages, setPages] = useState<Page[] | null>(null)
  const [picked, setPicked] = useState<LinkKind | null>(null)
  useEffect(() => { void listEditorPages().then(setPages) }, [])
  const list = pages ?? []
  // Until the pages arrive, a plain "/x" is most likely one of them.
  const inferred = pages === null && href.startsWith('/') && !Object.values(SYSTEM_PAGES).includes(href as never) ? 'page' : kindOf(href, list)
  const kind = picked ?? inferred
  const pageOptions = (value: string) => [
    ...list.map((p) => <MenuItem key={p.slug} value={p.slug}>{p.title} (/{p.slug}){p.published ? '' : ` — ${t('not published')}`}</MenuItem>),
    value && !list.some((p) => p.slug === value) ? <MenuItem key="gone" value={value}>{value} — {t('page not found')}</MenuItem> : null,
  ]
  const pick = (k: LinkKind) => {
    setPicked(k)
    onChange(k === 'login' || k === 'signup' || k === 'account' ? SYSTEM_PAGES[k] : '', '')
  }
  return (
    <Stack spacing={1}>
      <TextField id={id} select size="small" label={t(label)} value={kind} onChange={(e) => pick(e.target.value as LinkKind)}>
        {KINDS.map(([k, l]) => <MenuItem key={k} value={k}>{t(l)}</MenuItem>)}
      </TextField>
      {kind === 'page' && (
        <TextField id={`${id}-page`} select size="small" label={t('Page')} value={href.startsWith('/') ? href.slice(1) : ''}
          onChange={(e) => onChange(`/${e.target.value}`, '')}>
          {pageOptions(href.startsWith('/') && pages !== null && kindOf(href, list) !== 'page' ? href.slice(1) : '')}
        </TextField>
      )}
      {kind === 'external' && (
        <TextField id={`${id}-url`} size="small" label={t('URL')} value={href} placeholder="https://" onChange={(e) => onChange(e.target.value, '')}
          error={!!href && !safeHref(href)} helperText={href && !safeHref(href) ? t('Not a valid link (https://, mailto: or a /path).') : undefined} />
      )}
      {(kind === 'login' || kind === 'signup') && (
        <TextField id={`${id}-next`} select size="small" label={t('After login, go to')} value={next} onChange={(e) => onChange(href, e.target.value)}>
          <MenuItem value="">{t('My account')}</MenuItem>
          {pageOptions(next)}
        </TextField>
      )}
    </Stack>
  )
}
