import type { ReactElement } from 'react'
import Typography from '@mui/material/Typography'
import { getSiteIdentity } from '@/lib/site-session'
import { getWebsiteMe } from '../account'
import type { BookingConfig, PublicDataSource } from '../types'
import { LoginGate } from './LoginGate'

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

/** The login gate of a login-required booking block while the visitor is anonymous, else
 * null. It returns to `after_login_slug`, else the page's own path (`/<slug>[/<id>]`). */
export async function bookingGate(config: BookingConfig, path: string | undefined): Promise<ReactElement | null> {
  if (!config.login_required || (await getSiteIdentity())) return null
  return <LoginGate next={config.after_login_slug ? `/${config.after_login_slug}` : path || '/'} />
}

export function EventHeader({ event }: { event: PublicEvent }) {
  return (
    <>
      <Typography variant="h2" sx={{ mb: 1 }}>{event.name}</Typography>
      {event.location && <Typography variant="subtitle1" color="text.secondary" sx={{ fontWeight: 500, mb: 2 }}>{event.location}</Typography>}
      {event.description && <Typography sx={{ whiteSpace: 'pre-line', mb: 3, maxWidth: '70ch' }}>{event.description}</Typography>}
    </>
  )
}
