'use client'
import Link from 'next/link'
import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import Typography from '@mui/material/Typography'

// The row list for Settings -> Apps. A CLIENT component specifically because
// `ListItemButton component={Link}` passes the Link function as a prop into
// an MUI Client Component — only Server Actions ('use server') may cross the
// RSC boundary as functions, so this can't be rendered directly from the
// (Server Component) page, the way SettingsHub's own card grid needs 'use
// client' for the exact same `component={Link}` reason.

export interface AppListRow {
  name: string
  display_name: string
  description?: string
  icon?: string
}

function AppRow({ m }: { m: AppListRow }) {
  const hasIcon = Boolean(m.icon)
  return (
    <ListItemButton
      component={Link}
      href={`/settings/apps/${m.name}`}
      divider
      sx={{ py: 1.5, alignItems: 'flex-start' }}
    >
      <Avatar variant="rounded" sx={{ width: 40, height: 40, mr: 2, fontSize: hasIcon ? 20 : 16 }}>
        {hasIcon ? m.icon : m.display_name.charAt(0).toUpperCase()}
      </Avatar>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography sx={{ fontSize: 14, fontWeight: 700 }} noWrap>
          {m.display_name}
        </Typography>
        {m.description ? (
          <Typography sx={{ fontSize: 12 }} color="text.secondary" noWrap>
            {m.description}
          </Typography>
        ) : null}
      </Box>
    </ListItemButton>
  )
}

export default function AppsList({ apps }: { apps: AppListRow[] }) {
  return (
    <List disablePadding>
      {apps.map((m) => (
        <AppRow key={m.name} m={m} />
      ))}
    </List>
  )
}
