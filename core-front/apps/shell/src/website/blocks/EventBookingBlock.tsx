import Link from '@mui/material/Link'
import { T } from '@eerp/core-front'
import { getJSON } from '../public-api'
import type { BookingConfig, PublicDataSource } from '../types'
import { BookingForm } from './BookingForm'
import { bookingDefaults, EventHeader, publicEvent } from './EventHeader'

interface PublicSession { id: string; starts_at: string; seats_left: number; price?: number | null }

/** Booking on a sessions event: its future sessions, each with seats left. */
export async function EventBookingBlock({ config, source }: { config: BookingConfig; source: PublicDataSource }) {
  const event = await publicEvent(source, config.event_id, 'sessions')
  if (!event) return null
  const [sessions, defaults] = await Promise.all([
    getJSON<{ data: PublicSession[]; currency?: string }>(`/event/${encodeURIComponent(event.id)}/sessions`, ['event']),
    bookingDefaults(),
  ])
  const choices = (sessions?.data ?? []).map((s) => ({ id: s.id, start: s.starts_at, seatsLeft: s.seats_left, price: s.price }))
  return (
    <div>
      <EventHeader event={event} />
      {/* Go serves the feed publicly; the gateway routes /api/v1 to it. */}
      <Link href={`/api/v1/public/event/${encodeURIComponent(event.id)}/calendar.ics`} variant="body2" sx={{ display: 'inline-block', mb: 2 }}>
        <T text="Add all dates to my calendar" />
      </Link>
      <BookingForm eventId={event.id} kind="session" choices={choices} currency={sessions?.currency || undefined} timeZone={event.timezone ?? 'Europe/Paris'} defaults={defaults} />
    </div>
  )
}
