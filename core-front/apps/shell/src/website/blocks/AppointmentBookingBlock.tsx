import type { BookingConfig, PublicDataSource } from '../types'
import { bookingDefaults, EventHeader, publicEvent } from './EventHeader'
import { SlotPicker } from './SlotPicker'

/** Booking on an appointment event: slots computed by Go, one week at a time. */
export async function AppointmentBookingBlock({ config, source }: { config: BookingConfig; source: PublicDataSource }) {
  const event = await publicEvent(source, config.event_id, 'appointment')
  if (!event) return null
  return (
    <div>
      <EventHeader event={event} />
      <SlotPicker eventId={event.id} timeZone={event.timezone ?? 'Europe/Paris'} defaults={await bookingDefaults()} />
    </div>
  )
}
