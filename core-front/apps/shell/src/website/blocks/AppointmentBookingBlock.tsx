import type { BookingConfig, PublicDataSource } from '../types'
import { bookingDefaults, bookingGate, EventHeader, publicEvent } from './EventHeader'
import { SlotPicker } from './SlotPicker'

/** Booking on an appointment event: slots computed by Go, one week at a time. */
export async function AppointmentBookingBlock({ config, source, path }: { config: BookingConfig; source: PublicDataSource; path?: string }) {
  const event = await publicEvent(source, config.event_id, 'appointment')
  if (!event) return null
  const gate = await bookingGate(config, path)
  if (gate) return <div><EventHeader event={event} />{gate}</div>
  return (
    <div>
      <EventHeader event={event} />
      <SlotPicker eventId={event.id} timeZone={event.timezone ?? 'Europe/Paris'} defaults={await bookingDefaults()} />
    </div>
  )
}
