'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'
import type { ViewDescriptor } from './descriptor'
import { useRecentlyChangedStore } from './recently-changed-store'
import { createEntityStore, useEntityRecords, type HasId } from './stores'

// viewType 'catalog' (docs/roadmaps/app-store.md, Phase 2): an icon/title/
// subtitle list — the App Store's own module listing is the first user, but
// nothing here is App-Store-specific; any future "directory of things"
// reuses it with zero entity-specific code. Reuses createEntityStore (a list
// fetch, the existing server loader path — no new loader) even though
// nothing here mutates the list; it's the same store shape every other
// entity view seeds from, and gives a future search/filter feature a home.

/**
 * One catalog row: 40px Avatar (the record's own icon value if it's a
 * non-empty string, else the title's first letter) on the left, title
 * (14px/700) over subtitle (12px, text.secondary, single line ellipsized) on
 * the right. The whole row is the click target when `formPath` is set —
 * title/subtitle VALUES are record data, never translated (t() only wraps
 * developer-authored UI chrome, never a record's own field values).
 */
function CatalogRow({
  icon,
  title,
  subtitle,
  changed,
  onClick,
}: {
  icon: unknown
  title: string
  subtitle: string | undefined
  changed: boolean
  onClick?: () => void
}) {
  const t = useT()
  const hasIcon = typeof icon === 'string' && icon.length > 0
  const avatarContent = hasIcon ? icon : title.charAt(0).toUpperCase()
  return (
    <ListItemButton onClick={onClick} divider sx={{ py: 1.5, alignItems: 'flex-start' }}>
      <Avatar
        variant="rounded"
        sx={{ width: 40, height: 40, mr: 2, fontSize: hasIcon ? 20 : 16 }}
      >
        {avatarContent}
      </Avatar>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontSize: 14, fontWeight: 700 }} noWrap>
            {title}
          </Typography>
          {changed ? <Chip size="small" color="info" label={t('Updated')} /> : null}
        </Box>
        {subtitle ? (
          <Typography sx={{ fontSize: 12 }} color="text.secondary" noWrap>
            {subtitle}
          </Typography>
        ) : null}
      </Box>
    </ListItemButton>
  )
}

export interface CatalogRendererProps<T extends HasId> {
  descriptor: ViewDescriptor<T>
  initialData: T[]
}

export function CatalogRenderer<T extends HasId>({
  descriptor,
  initialData,
}: CatalogRendererProps<T>) {
  const t = useT()
  const router = useRouter()
  const [store] = useState(() => createEntityStore(descriptor, initialData))
  const records = useEntityRecords(store)
  const recentlyChanged = useRecentlyChangedStore((s) => s.ids)
  const { catalog, formPath } = descriptor

  // validateCatalogDescriptor already guarantees this at registration for any
  // real module — defensive only (e.g. a hand-built fixture skipping it).
  if (!catalog) return null

  if (records.length === 0) {
    return (
      <Typography color="text.secondary" sx={{ py: 2 }}>
        {t('No entries.')}
      </Typography>
    )
  }

  return (
    <List disablePadding>
      {records.map((record) => {
        const row = record as unknown as Record<string, unknown>
        const title = String(row[catalog.title] ?? '')
        const subtitleValue = catalog.subtitle ? row[catalog.subtitle] : undefined
        const icon = catalog.icon ? row[catalog.icon] : undefined
        const onClick = formPath ? () => router.push(formPath.replace(':id', record.id)) : undefined
        return (
          <CatalogRow
            key={record.id}
            icon={icon}
            title={title}
            subtitle={subtitleValue != null ? String(subtitleValue) : undefined}
            changed={recentlyChanged.has(record.id)}
            onClick={onClick}
          />
        )
      })}
    </List>
  )
}
