'use client'
import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useI18nStore, useT } from '@eerp/core-front'

/** One bookable time: a session (id = session id) or a slot (id = its start). */
export interface BookingChoice { id: string; start: string; seatsLeft: number }

/** Choices render in the event's own time zone, in the visitor's language. */
export function formatChoice(start: string, timeZone: string, locale: string | null): string {
  const tag = locale && locale !== 'source' ? locale : undefined
  try {
    return new Intl.DateTimeFormat(tag, { dateStyle: 'full', timeStyle: 'short', timeZone }).format(new Date(start))
  } catch {
    return new Date(start).toLocaleString(tag) // unknown zone: the browser's own
  }
}

type Status = { kind: 'idle' | 'submitting' } | { kind: 'confirmed'; email: string } | { kind: 'error'; message: string }

// Seat caps shown here are hints (seat counts are cached up to a minute); Go's 409
// is the truth, answered with "just taken" and a refresh of the choices.
export function BookingForm({ eventId, kind, choices, timeZone, maxSeats = 10, defaults, onTaken }: {
  eventId: string
  kind: 'session' | 'slot'
  choices: BookingChoice[]
  timeZone: string
  maxSeats?: number
  defaults?: { name?: string; email?: string }
  onTaken?: () => void
}) {
  const t = useT()
  const router = useRouter()
  const locale = useI18nStore((s) => s.locale)
  const [choice, setChoice] = useState('')
  const [seats, setSeats] = useState(1)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const picked = choices.find((c) => c.id === choice)
  const cap = Math.max(1, Math.min(maxSeats, picked?.seatsLeft ?? maxSeats))

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const email = String(f.get('email') ?? '')
    setStatus({ kind: 'submitting' })
    const res = await fetch('/api/site-booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: eventId,
        ...(kind === 'session' ? { session_id: choice } : { slot_start: choice }),
        seats,
        name: String(f.get('name') ?? ''),
        email,
        phone: String(f.get('phone') ?? ''),
      }),
    }).catch(() => null)
    if (res?.ok) {
      setStatus({ kind: 'confirmed', email })
      return
    }
    const body = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null
    if (res?.status === 409 || res?.status === 404) {
      setStatus({ kind: 'error', message: t('Just taken — pick another time.') })
      setChoice('')
      if (onTaken) onTaken()
      else router.refresh()
    } else if (res?.status === 400 && body?.error?.message) {
      setStatus({ kind: 'error', message: body.error.message })
    } else if (res?.status === 429) {
      setStatus({ kind: 'error', message: t('Too many attempts. Please wait a minute and try again.') })
    } else {
      setStatus({ kind: 'error', message: t('Something went wrong. Please try again.') })
    }
  }

  if (status.kind === 'confirmed') {
    return (
      <Alert severity="success">
        {t('Booking confirmed — a confirmation email is on its way to')} {status.email}
      </Alert>
    )
  }
  if (choices.length === 0) {
    return <Typography color="text.secondary">{t('No dates available right now.')}</Typography>
  }
  return (
    <Stack component="form" spacing={2} onSubmit={(e) => void submit(e)}>
      {status.kind === 'error' && <Alert severity="error">{status.message}</Alert>}
      <RadioGroup name="choice" value={choice} onChange={(e) => { setChoice(e.target.value); setSeats(1) }}>
        {choices.map((c) => (
          <FormControlLabel
            key={c.id}
            value={c.id}
            disabled={c.seatsLeft <= 0}
            control={<Radio required />}
            label={
              <span suppressHydrationWarning>
                {formatChoice(c.start, timeZone, locale)}
                {c.seatsLeft <= 0 ? ` — ${t('Full')}` : ''}
              </span>
            }
          />
        ))}
      </RadioGroup>
      <TextField
        name="seats"
        label={t('Seats')}
        type="number"
        value={seats}
        onChange={(e) => setSeats(Math.max(1, Math.min(cap, Number(e.target.value) || 1)))}
        slotProps={{ htmlInput: { min: 1, max: cap } }}
        sx={{ maxWidth: 120 }}
      />
      <TextField name="name" label={t('Name')} required defaultValue={defaults?.name} slotProps={{ htmlInput: { maxLength: 200 } }} />
      <TextField name="email" label={t('Email')} type="email" required defaultValue={defaults?.email} />
      <TextField name="phone" label={t('Phone')} type="tel" slotProps={{ htmlInput: { maxLength: 50 } }} />
      <Button type="submit" variant="contained" disabled={!choice || status.kind === 'submitting'} sx={{ alignSelf: 'flex-start' }}>
        {t('Book')}
      </Button>
    </Stack>
  )
}
