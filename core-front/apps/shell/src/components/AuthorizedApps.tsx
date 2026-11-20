'use client'
import { useState } from 'react'
import Button from '@mui/material/Button'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useT, ViewBanner } from '@eerp/core-front'
import { revokeAuthorizedApp, type AuthorizedApp } from '@/lib/mcp-oauth'

/** Settings → Account: the MCP clients (claude.ai, ChatGPT…) the user connected
 * through OAuth (ADR-043). Revoking one ends its access at once. */
export default function AuthorizedApps({ apps }: { apps: AuthorizedApp[] }) {
  const t = useT()
  const [list, setList] = useState(apps)
  const [error, setError] = useState('')
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : t('never'))

  async function revoke(id: string) {
    if (await revokeAuthorizedApp(id)) {
      setError('')
      setList((l) => l.filter((a) => a.id !== id))
    } else setError(t('Could not save.'))
  }

  return (
    <Stack spacing={2} sx={{ maxWidth: 640 }}>
      <Typography variant="h6" component="h2">{t('Authorized apps')}</Typography>
      <Typography variant="body2" color="text.secondary">
        {t('AI assistants you connected to EERP through MCP. They act with your own permissions.')}
      </Typography>
      {list.length === 0 ? (
        <Typography variant="body2">{t('No app is connected.')}</Typography>
      ) : (
        <List dense disablePadding>
          {list.map((a) => (
            <ListItem key={a.id} disableGutters secondaryAction={
              <Button color="error" size="small" onClick={() => void revoke(a.id)} aria-label={`${t('Revoke')} ${a.client_name}`}>{t('Revoke')}</Button>
            }>
              <ListItemText primary={a.client_name}
                secondary={`${t('Connected')} ${day(a.created_at)} · ${t('Last used')} ${day(a.last_used_at)}`} />
            </ListItem>
          ))}
        </List>
      )}
      {error && <ViewBanner status="error">{error}</ViewBanner>}
    </Stack>
  )
}
