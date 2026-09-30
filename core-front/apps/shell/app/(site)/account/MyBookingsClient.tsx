'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@mui/material/Button'
import { useI18nStore, useT } from '@eerp/core-front'
import { cancelMyBooking, resendVerification } from '@/website/booking-actions'

/** A booking's start in the visitor's language and zone. */
export function When({ iso }: { iso: string | null }) {
  const locale = useI18nStore((s) => s.locale)
  if (!iso) return null
  const tag = locale && locale !== 'source' ? locale : undefined
  return <span suppressHydrationWarning>{new Date(iso).toLocaleString(tag, { dateStyle: 'medium', timeStyle: 'short' })}</span>
}

export function CancelMyBookingButton({ id }: { id: string }) {
  const t = useT()
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  async function cancel() {
    setState('busy')
    if (await cancelMyBooking(id)) router.refresh()
    else setState('failed')
  }
  return (
    <Button size="small" color={state === 'failed' ? 'error' : 'primary'} disabled={state === 'busy'} onClick={() => void cancel()}>
      {state === 'failed' ? t('Could not cancel — retry') : t('Cancel')}
    </Button>
  )
}

export function ResendVerificationButton() {
  const t = useT()
  const [sent, setSent] = useState<boolean | null>(null)
  return (
    <Button size="small" color="inherit" disabled={sent === true} onClick={() => void resendVerification().then(setSent)}>
      {sent === true ? t('Email sent') : sent === false ? t('Could not send — retry') : t('Resend the email')}
    </Button>
  )
}
