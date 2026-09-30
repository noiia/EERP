import { getJSON } from '../public-api'
import type { BookingConfig, PublicDataSource } from '../types'
import { BookingForm } from './BookingForm'
import { bookingDefaults, EventHeader, publicEvent } from './EventHeader'

interface PublicSession { id: string; starts_at: string; seats_left: number }

/** Booking on a sessions event: its future sessions, each with seats left. */
export async function EventBookingBlock({ config, source }: { config: BookingConfig; source: PublicDataSource }) {
  const event = await publicEvent(source, config.event_id, 'sessions')
  if (!event) return null
  const [sessions, defaults] = await Promise.all([
    getJSON<{ data: PublicSession[] }>(`/event/${encodeURIComponent(event.id)}/sessions`, ['event']),
    bookingDefaults(),
  ])
  const choices = (sessions?.data ?? []).map((s) => ({ id: s.id, start: s.starts_at, seatsLeft: s.seats_left }))
  return (
    <div>
      <EventHeader event={event} />
      <BookingForm eventId={event.id} kind="session" choices={choices} timeZone={event.timezone ?? 'Europe/Paris'} defaults={defaults} />
    </div>
  )
}
