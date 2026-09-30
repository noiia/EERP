'use client'
import { useCallback, useEffect, useState } from 'react'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import { useT } from '@eerp/core-front'
import { fetchSlots, type Slot } from '../booking-actions'
import { BookingForm } from './BookingForm'

const DAY = 24 * 3600 * 1000

/** Midnight UTC of the current day: a stable window start, so the 60 s slot cache
 * is shared by every visitor looking at the same week. */
const today = () => Math.floor(Date.now() / DAY) * DAY

export function SlotPicker({ eventId, timeZone, defaults }: {
  eventId: string
  timeZone: string
  defaults?: { name?: string; email?: string }
}) {
  const t = useT()
  const [week, setWeek] = useState(0)
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [version, setVersion] = useState(0) // bumped to refetch after a "just taken"

  const load = useCallback(async () => {
    setSlots(null)
    const from = today() + week * 7 * DAY
    setSlots((await fetchSlots(eventId, new Date(from).toISOString(), new Date(from + 7 * DAY).toISOString())) ?? [])
  }, [eventId, week])
  useEffect(() => { void load() }, [load, version])

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1}>
        <Button size="small" disabled={week === 0} onClick={() => setWeek((w) => w - 1)}>{t('Previous week')}</Button>
        <Button size="small" onClick={() => setWeek((w) => w + 1)}>{t('Next week')}</Button>
      </Stack>
      {slots === null
        ? <CircularProgress size={24} aria-label={t('Loading')} />
        : <BookingForm key={`${week}-${version}`} eventId={eventId} kind="slot" timeZone={timeZone} defaults={defaults}
            choices={slots.map((s) => ({ id: s.start, start: s.start, seatsLeft: s.seats_left }))}
            onTaken={() => setVersion((v) => v + 1)} />}
    </Stack>
  )
}
