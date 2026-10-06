'use client'
import { useActionState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import { useT } from '@eerp/core-front'
import type { TokenResult } from './booking-actions'

/** A one-button form posting an emailed token (cancel, verify). A button, not a GET
 * link handler: email scanners prefetch links and would use the token up. */
export function TokenActionForm({ action, token, button, done }: {
  action: (prev: TokenResult, form: FormData) => Promise<TokenResult>
  token: string
  button: string
  done: string
}) {
  const t = useT()
  const [result, run, pending] = useActionState(action, null)
  if (result === 'ok') return <Alert severity="success">{t(done)}</Alert>
  const errors: Record<Exclude<TokenResult, 'ok' | null>, string> = {
    invalid: t('This link is invalid or was already used.'),
    session: t('Your session has expired. Please log in again.'),
    taken: t('Someone booked this seat first. You stay on the waiting list.'),
    failed: t('Something went wrong. Please try again.'),
  }
  return (
    <Stack component="form" action={run} spacing={2}>
      {result && <Alert severity="error">{errors[result]}</Alert>}
      <input type="hidden" name="token" value={token} />
      <Button type="submit" variant="contained" disabled={pending} sx={{ alignSelf: 'flex-start' }}>{t(button)}</Button>
    </Stack>
  )
}
