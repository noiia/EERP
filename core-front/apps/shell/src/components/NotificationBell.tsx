'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Badge from '@mui/material/Badge'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import LinearProgress from '@mui/material/LinearProgress'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import Popover from '@mui/material/Popover'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { byPrefixAndName, erpPath, FontAwesomeIcon, useNotificationStore, useT, type AppNotification } from '@eerp/core-front'
import { markNotificationsRead } from '@/lib/notification-actions'

// The top bar's bell (left of the company logo): unread badge, a breathing red
// dot while a live arrival is unseen, and a panel — running activities with
// their progress, then personal and finished notifications. Clicking one marks
// it read and opens its ERP page.

/** An ERP path only — mirrors Go's notify.ValidLink, so a bad row can't redirect elsewhere. */
const isErpPath = (link: string) => link.startsWith('/') && !link.startsWith('//') && !/[\\:]/.test(link)

function relativeTime(iso: string, locale?: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 60) return rtf.format(seconds, 'second')
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour')
  return rtf.format(Math.round(seconds / 86400), 'day')
}

export function NotificationBell() {
  const t = useT()
  const router = useRouter()
  const { items, unread, hasNew, acknowledge, markRead } = useNotificationStore()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const running = items.filter((i) => i.status === 'running')
  const rest = items.filter((i) => i.status !== 'running')

  function open(e: React.MouseEvent<HTMLElement>) {
    setAnchor(e.currentTarget)
    acknowledge()
  }

  function go(n: AppNotification) {
    if (!n.read) {
      markRead([n.id])
      void markNotificationsRead([n.id])
    }
    if (!isErpPath(n.link)) return
    setAnchor(null)
    router.push(erpPath(n.link))
  }

  function readAll() {
    markRead('all')
    void markNotificationsRead('all')
  }

  return (
    <>
      <IconButton color="inherit" aria-label={t('Notifications')} onClick={open} sx={{ mr: 1, position: 'relative' }}>
        <Badge badgeContent={unread} max={9} color="error">
          <FontAwesomeIcon icon={byPrefixAndName.fas['bell']} />
        </Badge>
        {hasNew ? (
          <Box
            component="span"
            data-testid="notification-dot"
            className="erp-breathe"
            aria-label={t('New notifications')}
            sx={{ position: 'absolute', top: 6, left: 6, width: 8, height: 8, borderRadius: '50%', bgcolor: 'error.main' }}
          />
        ) : null}
      </IconButton>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 360, maxWidth: 'calc(100vw - 32px)', maxHeight: 480 } } }}
      >
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', px: 2, py: 1 }}>
          <Typography variant="subtitle1">{t('Notifications')}</Typography>
          <Button size="small" onClick={readAll} disabled={unread === 0}>
            {t('Mark all as read')}
          </Button>
        </Stack>
        <Divider />
        {items.length === 0 ? (
          <Typography color="text.secondary" sx={{ p: 2 }}>
            {t('No notifications')}
          </Typography>
        ) : null}
        {running.length ? (
          <>
            <Typography variant="overline" color="text.secondary" sx={{ px: 2 }}>
              {t('Running now')}
            </Typography>
            <List dense disablePadding>
              {running.map((n) => (
                <ListItemButton key={n.id} onClick={() => go(n)} sx={{ display: 'block' }}>
                  <Typography variant="body2">{t(n.title)}</Typography>
                  {n.progress_label ? (
                    <Typography variant="caption" color="text.secondary">
                      {n.progress_label}
                    </Typography>
                  ) : null}
                  <LinearProgress
                    sx={{ mt: 0.5 }}
                    {...(n.progress == null ? {} : { variant: 'determinate' as const, value: n.progress })}
                  />
                </ListItemButton>
              ))}
            </List>
            <Divider />
          </>
        ) : null}
        <List dense disablePadding>
          {rest.map((n) => (
            <ListItemButton
              key={n.id}
              onClick={() => go(n)}
              sx={{ display: 'block', bgcolor: n.read ? undefined : 'action.hover' }}
            >
              <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
                {n.status === 'failed' ? (
                  <Typography variant="caption" color="error.main" sx={{ fontWeight: 600 }}>
                    {t('Failed')}
                  </Typography>
                ) : null}
                <Typography variant="body2" sx={{ fontWeight: n.read ? 400 : 600, flex: 1 }}>
                  {t(n.title)}
                </Typography>
              </Stack>
              {n.body ? (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {n.body}
                </Typography>
              ) : null}
              <Typography variant="caption" color="text.secondary">
                {relativeTime(n.finished_at ?? n.created_at)}
              </Typography>
            </ListItemButton>
          ))}
        </List>
      </Popover>
    </>
  )
}
