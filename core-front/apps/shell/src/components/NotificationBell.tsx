'use client'
import { Fragment, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Badge from '@mui/material/Badge'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import LinearProgress from '@mui/material/LinearProgress'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import Popover from '@mui/material/Popover'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import {
  byPrefixAndName,
  erpPath,
  FontAwesomeIcon,
  layout,
  useNotificationStore,
  useT,
  type AppNotification,
} from '@eerp/core-front'
import { markNotificationsRead } from '@/lib/notification-actions'

// The top bar's bell (just left of the company switcher): unread badge, a
// breathing red dot while a live arrival is unseen, and a panel — running
// activities with their progress, then personal and finished notifications.
// Resting the pointer on one marks it read; clicking one opens its ERP page.
// On a phone the panel opens centered, over 90% of the screen.

/** How long the pointer must rest on a row before it counts as read — passing
 * over rows on the way to another one doesn't read them all. */
export const HOVER_READ_MS = 600

/** An ERP path only — mirrors Go's notify.ValidLink, so a bad row can't redirect elsewhere. */
const isErpPath = (link: string) =>
  link.startsWith('/') && !link.startsWith('//') && !/[\\:]/.test(link)

/** The bar between two notifications: 0.5px, centered, 70% of the panel wide. */
function Separator() {
  return (
    <Box
      component="hr"
      data-testid="notification-separator"
      sx={{
        width: '70%',
        mx: 'auto',
        my: 0,
        border: 0,
        borderTop: '0.5px solid',
        borderColor: 'divider',
      }}
    />
  )
}

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
  const phone = useMediaQuery(`(max-width:${layout.phoneMaxWidth - 0.05}px)`)
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelDwell = () => {
    if (dwell.current) clearTimeout(dwell.current)
    dwell.current = null
  }
  useEffect(() => cancelDwell, [])
  const running = items.filter((i) => i.status === 'running')
  const rest = items.filter((i) => i.status !== 'running')

  function open(e: React.MouseEvent<HTMLElement>) {
    setAnchor(e.currentTarget)
    acknowledge()
  }

  function read(n: AppNotification) {
    if (n.read) return
    markRead([n.id])
    void markNotificationsRead([n.id])
  }

  function hover(n: AppNotification) {
    cancelDwell()
    if (!n.read) dwell.current = setTimeout(() => read(n), HOVER_READ_MS)
  }

  function close() {
    cancelDwell()
    setAnchor(null)
  }

  function go(n: AppNotification) {
    cancelDwell()
    read(n)
    if (!isErpPath(n.link)) return
    close()
    router.push(erpPath(n.link))
  }

  function readAll() {
    markRead('all')
    void markNotificationsRead('all')
  }

  const content = (
    <>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between', px: 2, py: 1 }}
      >
        <Typography variant="subtitle1" sx={{ flex: 1 }}>
          {t('Notifications')}
        </Typography>
        <Button size="small" onClick={readAll} disabled={unread === 0}>
          {t('Mark all as read')}
        </Button>
        {/* The phone dialog covers the page: give it an explicit way out. */}
        {phone ? (
          <IconButton size="small" aria-label={t('Close')} onClick={close} sx={{ ml: 1 }}>
            <FontAwesomeIcon icon={byPrefixAndName.fas['xmark']} />
          </IconButton>
        ) : null}
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
            {running.map((n, i) => (
              <Fragment key={n.id}>
                {i > 0 ? <Separator /> : null}
                <ListItemButton
                  key={n.id}
                  onClick={() => go(n)}
                  onMouseEnter={() => hover(n)}
                  onMouseLeave={cancelDwell}
                  sx={{ display: 'block' }}
                >
                  <Typography variant="body2">{t(n.title)}</Typography>
                  {n.progress_label ? (
                    <Typography variant="caption" color="text.secondary">
                      {n.progress_label}
                    </Typography>
                  ) : null}
                  <LinearProgress
                    sx={{ mt: 0.5 }}
                    {...(n.progress == null
                      ? {}
                      : { variant: 'determinate' as const, value: n.progress })}
                  />
                </ListItemButton>
              </Fragment>
            ))}
          </List>
          <Divider />
        </>
      ) : null}
      <List dense disablePadding>
        {rest.map((n, i) => (
          <Fragment key={n.id}>
            {i > 0 ? <Separator /> : null}
            <ListItemButton
              key={n.id}
              onClick={() => go(n)}
              onMouseEnter={() => hover(n)}
              onMouseLeave={cancelDwell}
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
          </Fragment>
        ))}
      </List>
    </>
  )

  return (
    <>
      <IconButton
        color="inherit"
        size="small"
        aria-label={t('Notifications')}
        onClick={open}
        sx={{ mr: 3, position: 'relative' }}
      >
        <Badge
          badgeContent={unread}
          max={9}
          color="error"
          sx={{ '& .MuiBadge-badge': { fontSize: 10, height: 16, minWidth: 16, px: 0.5 } }}
        >
          {/* 3px bigger on each side on a phone, where it's tapped with a finger. */}
          <FontAwesomeIcon
            icon={byPrefixAndName.fas['bell']}
            data-testid="notification-bell-icon"
            style={{ fontSize: phone ? 22 : 16 }}
          />
        </Badge>
        {hasNew ? (
          <Box
            component="span"
            data-testid="notification-dot"
            className="erp-breathe"
            aria-label={t('New notifications')}
            sx={{
              position: 'absolute',
              top: 3,
              left: 3,
              width: 6,
              height: 6,
              borderRadius: '50%',
              bgcolor: 'error.main',
            }}
          />
        ) : null}
      </IconButton>
      {phone ? (
        // A phone gets the panel in front of the page, centered over 90% of the
        // screen with the page blurred behind it. A Dialog centers it with its
        // own flex container — a Popover can't: its open animation overwrites
        // the paper's transform, which is what centering would rely on.
        <Dialog
          open={Boolean(anchor)}
          onClose={close}
          aria-label={t('Notifications')}
          slotProps={{
            backdrop: {
              'data-testid': 'notification-backdrop',
              sx: { backdropFilter: 'blur(6px)' },
            } as object,
            paper: {
              'data-testid': 'notification-panel',
              'data-layout': 'phone',
              sx: {
                width: '90vw',
                height: '90vh',
                maxWidth: '90vw',
                maxHeight: '90vh',
                m: 0,
                overflowY: 'auto',
              },
            } as object,
          }}
        >
          {content}
        </Dialog>
      ) : (
        <Popover
          open={Boolean(anchor)}
          anchorEl={anchor}
          onClose={close}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          slotProps={{
            paper: {
              'data-testid': 'notification-panel',
              'data-layout': 'anchored',
              sx: { width: 360, maxWidth: 'calc(100vw - 32px)', maxHeight: 480 },
            } as object,
          }}
        >
          {content}
        </Popover>
      )}
    </>
  )
}
