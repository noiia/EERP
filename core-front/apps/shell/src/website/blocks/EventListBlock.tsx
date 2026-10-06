import { getJSON } from '../public-api'
import type { EventListConfig } from '../types'
import { EventList, type UpcomingEvent } from './EventList'

/** Upcoming published events (next session, seats left), read through Go's
 * /public/events/upcoming — 404 (events unpublished) renders nothing. Cached 60 s
 * under the `event` tag, which every site booking/cancel expires. */
export async function EventListBlock({ config }: { config: EventListConfig }) {
  const limit = Math.min(Math.max(Math.trunc(config.limit ?? 12), 1), 50)
  const res = await getJSON<{ data: UpcomingEvent[] }>(`/events/upcoming?limit=${limit}`, ['website_page', 'event'])
  if (!res) return null
  return <EventList config={config} events={res.data} />
}
