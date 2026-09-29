'use client'
import { useActionState, useState } from 'react'
import { useRouter } from 'next/navigation'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { useT } from '@eerp/core-front'
import { saveProfile } from './account-actions'
import type { WebsiteMe } from './account'

/** The visitor's editable profile (name, surname, phone) on /account. */
export function ProfileForm({ me }: { me: WebsiteMe }) {
  const t = useT()
  const [result, action, pending] = useActionState(saveProfile, null)
  const errors = {
    session: t('Your session has expired. Please log in again.'),
    invalid: t('Name is required; name and surname max 200, phone max 50 characters.'),
    failed: t('Something went wrong. Please try again.'),
  }
  return (
    <Stack component="form" action={action} spacing={2}>
      {result && (result.ok
        ? <Alert severity="success">{t('Saved.')}</Alert>
        : <Alert severity="error">{errors[result.error]}</Alert>)}
      <TextField label={t('Email')} value={me.email} disabled />
      <TextField name="name" label={t('Name')} defaultValue={me.name} required slotProps={{ htmlInput: { maxLength: 200 } }} />
      <TextField name="surname" label={t('Surname')} defaultValue={me.surname} slotProps={{ htmlInput: { maxLength: 200 } }} />
      <TextField name="phone" label={t('Phone')} type="tel" defaultValue={me.phone} slotProps={{ htmlInput: { maxLength: 50 } }} />
      <Button type="submit" variant="contained" disabled={pending} sx={{ alignSelf: 'flex-start' }}>{t('Save')}</Button>
    </Stack>
  )
}

export function LogoutButton() {
  const t = useT()
  const router = useRouter()
  const [pending, setPending] = useState(false)
  async function logout() {
    setPending(true)
    await fetch('/api/site-auth/logout', { method: 'POST' }).catch(() => null)
    router.push('/')
    router.refresh()
  }
  return <Button variant="outlined" onClick={() => void logout()} disabled={pending}>{t('Log out')}</Button>
}
