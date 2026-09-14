import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import { usePresenceStore, type PresenceStatus } from './presence-store'

// The presence bubble: a small colored dot on an avatar's bottom-right
// corner, Teams' own presence palette (reused verbatim per the feature
// request — users already read these colors instinctively). Online/busy/
// do_not_disturb/absent render filled; offline renders hollow (border only),
// matching Teams' own "no fill" look for a genuinely offline contact.
// do_not_disturb additionally gets a small white bar (not an icon — no new
// icon dependency for one glyph) so it's distinguishable from busy at a
// glance, same as Teams' dash-in-the-dot.

const PRESENCE_COLORS: Record<PresenceStatus, string> = {
  online: '#6CBB58',
  busy: '#C4314B',
  do_not_disturb: '#C4314B',
  absent: '#FFAA44',
  offline: '#8A8886',
}

export function PresenceDot({ status, size = 15 }: { status: PresenceStatus; size?: number }) {
  const hollow = status === 'offline'
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        boxSizing: 'border-box',
        bgcolor: hollow ? 'background.paper' : PRESENCE_COLORS[status],
        border: hollow ? `${Math.max(1.5, size / 6)}px solid ${PRESENCE_COLORS.offline}` : '2px solid',
        borderColor: hollow ? PRESENCE_COLORS.offline : 'background.paper',
        position: 'relative',
      }}
    >
      {status === 'do_not_disturb' && (
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: '20%',
            right: '20%',
            height: Math.max(1, size / 8),
            bgcolor: 'common.white',
            transform: 'translateY(-50%)',
            borderRadius: 1,
          }}
        />
      )}
    </Box>
  )
}

/**
 * The one reusable "avatar with a live presence bubble" primitive — every
 * consumer (top-bar UserMenu, chatter authors, the Users list) renders
 * through this rather than reimplementing the overlay. Subscribed live to
 * usePresenceStore, re-rendering on every push; an unknown/never-connected
 * user defaults to offline.
 */
export function AvatarWithPresence({
  userId,
  label,
  size = 32,
}: {
  userId: string
  /** Used for the fallback initial letter when no picture is wired up. */
  label?: string
  size?: number
}) {
  const status = usePresenceStore((s) => s.statuses[userId] ?? 'offline')
  const initial = (label ?? '').trim().charAt(0).toUpperCase() || '?'
  const dotSize = Math.max(12, Math.round(size * 0.32) + 5)

  return (
    <Box sx={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <Avatar sx={{ width: size, height: size, bgcolor: 'primary.main', fontSize: size * 0.4 }}>
        {initial}
      </Avatar>
      <Box sx={{ position: 'absolute', bottom: -1, right: -1 }}>
        <PresenceDot status={status} size={dotSize} />
      </Box>
    </Box>
  )
}
