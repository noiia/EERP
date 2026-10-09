'use client'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import CardContent from '@mui/material/CardContent'
import Link from '@mui/material/Link'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import Typography from '@mui/material/Typography'
import { useI18nStore, useT } from '@eerp/core-front'
import { pictureUrl } from '../urls'
import type { EventListConfig } from '../types'
import { formatChoice } from './BookingForm'
import { CARD_PICTURE_SX, CARD_SX } from './RecordCard'

/** One row of Go's /public/events/upcoming: only published columns are present. */
export interface UpcomingEvent {
  id: string
  name?: string
  location?: string | null
  kind?: string
  timezone?: string
  picture?: boolean | null
  next_session_at: string | null
  seats_left: number | null
}

/** Visitor-facing list of upcoming events, linking each to the generic event page. */
export function EventList({ config, events }: { config: EventListConfig; events: UpcomingEvent[] }) {
  const t = useT()
  const locale = useI18nStore((s) => s.locale)
  if (events.length === 0) return <Typography color="text.secondary">{t('No upcoming events.')}</Typography>
  const href = (id: string) => (config.detail_slug ? `/${encodeURIComponent(config.detail_slug)}/${encodeURIComponent(id)}` : undefined)
  // When, and how much room is left: an appointment event books slots, not sessions.
  const when = (ev: UpcomingEvent) => {
    if (ev.kind === 'appointment' || !ev.next_session_at) return t('Book a slot')
    const date = formatChoice(ev.next_session_at, ev.timezone ?? 'Europe/Paris', locale)
    const seats = ev.seats_left ?? 0
    return `${date} — ${seats > 0 ? `${seats} ${t('seats left')}` : t('Full')}`
  }

  if (config.display === 'list') {
    return (
      <List dense>
        {events.map((ev) => {
          const link = href(ev.id)
          return (
            <ListItem key={ev.id} disableGutters>
              <ListItemText
                primary={link ? <Link href={link}>{ev.name}</Link> : ev.name}
                secondary={[ev.location, when(ev)].filter(Boolean).join(' · ')}
              />
            </ListItem>
          )
        })}
      </List>
    )
  }
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(min(240px, 100%), 1fr))' }}>
      {events.map((ev) => {
        const link = href(ev.id)
        const body = (
          <>
            {ev.picture && <Box component="img" src={pictureUrl('event', ev.id, 'picture')} alt="" loading="lazy" sx={CARD_PICTURE_SX} />}
            <CardContent>
              <Typography variant="h6" component="h3" sx={{ fontWeight: 600, lineHeight: 1.3, mb: 0.5 }}>{ev.name}</Typography>
              {ev.location && <Typography color="text.secondary">{ev.location}</Typography>}
              <Typography variant="body2">{when(ev)}</Typography>
            </CardContent>
          </>
        )
        return (
          <Card key={ev.id} sx={CARD_SX}>
            {link ? <CardActionArea sx={{ height: '100%' }} href={link}>{body}</CardActionArea> : body}
          </Card>
        )
      })}
    </Box>
  )
}
