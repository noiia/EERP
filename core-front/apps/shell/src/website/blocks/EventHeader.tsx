import Typography from '@mui/material/Typography'
import { getSiteIdentity } from '@/lib/site-session'
import { getWebsiteMe } from '../account'
import type { PublicDataSource } from '../types'

/** A published event's public fields (Go seeds this selection). */
export interface PublicEvent { id: string; name?: string; description?: string | null; location?: string | null; kind?: string; timezone?: string }

/** The event as published, or null (unpublished, deleted, or the wrong kind). */
export async function publicEvent(source: PublicDataSource, id: string | undefined, kind: string): Promise<PublicEvent | null> {
  if (!id) return null
  const ev = (await source.get('event', id)) as PublicEvent | null
  return ev && ev.kind === kind ? ev : null
}

/** A signed-in visitor's name/email prefill the booking form. */
export async function bookingDefaults(): Promise<{ name?: string; email?: string } | undefined> {
  if (!(await getSiteIdentity())) return undefined
  const me = await getWebsiteMe().catch(() => null)
  return me ? { name: me.name, email: me.email } : undefined
}

export function EventHeader({ event }: { event: PublicEvent }) {
  return (
    <>
      <Typography variant="h4" component="h2" gutterBottom>{event.name}</Typography>
      {event.location && <Typography color="text.secondary" gutterBottom>{event.location}</Typography>}
      {event.description && <Typography sx={{ whiteSpace: 'pre-line', mb: 2 }}>{event.description}</Typography>}
    </>
  )
}
