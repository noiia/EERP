'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { changeMyPassword, type SelfUserProfile } from '@/lib/force-password-change'
import { authBffUrl } from '@/lib/auth-url'

export default function PasswordChangeForm({ profile }: { profile: SelfUserProfile | null }) {
  const router = useRouter()
  const [email, setEmail] = useState(profile?.email ?? '')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    if (!profile) {
      setError('Could not load your profile. Refresh the page and try again.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setPending(true)
    const result = await changeMyPassword(profile, password, email)
    if (!result.ok) {
      setPending(false)
      setError(result.message)
      return
    }

    // The access cookie already in place still carries the old
    // mustChangePassword: true claim (JWT claims are resolved at issue time,
    // not re-checked live) — Go's own Refresh handler re-reads the user row
    // and reissues, so this is what actually clears it client-side; without
    // it, requireAuth() would immediately bounce back to this same page.
    await fetch(authBffUrl('refresh'), { method: 'POST' })
    setPending(false)

    router.push('/')
    router.refresh()
  }

  return (
    <Container maxWidth="xs" sx={{ py: 8 }}>
      <Box component="form" onSubmit={onSubmit}>
        <Stack spacing={2}>
          <Typography variant="h5" component="h1">
            Change your password
          </Typography>
          <Typography variant="body2" color="text.secondary">
            This account still has its default password. Set a new one to continue — you can
            optionally update your email address too.
          </Typography>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {!profile ? (
            <Alert severity="error">Could not load your profile. Refresh the page and try again.</Alert>
          ) : null}
          <TextField
            id="force-password-change-email"
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!profile}
          />
          <TextField
            id="force-password-change-new"
            label="New password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={!profile}
          />
          <TextField
            id="force-password-change-confirm"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            disabled={!profile}
          />
          <Button type="submit" variant="contained" disabled={pending || !profile}>
            {pending ? 'Saving…' : 'Save and continue'}
          </Button>
        </Stack>
      </Box>
    </Container>
  )
}
