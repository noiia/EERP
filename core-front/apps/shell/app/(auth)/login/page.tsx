'use client'
import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useSessionStore } from '@eerp/core-front'
import { authBffUrl } from '@/lib/auth-url'

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)

    const res = await fetch(authBffUrl('login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = (await res.json().catch(() => null)) as
      | { identity?: unknown; error?: { message?: string } }
      | null

    if (!res.ok) {
      // Surface the server's message (e.g. "Invalid email or password.").
      setError(data?.error?.message ?? 'Login failed')
      setPending(false)
      return
    }

    useSessionStore.getState().setIdentity((data?.identity as never) ?? null)
    router.push(params.get('next') || '/')
    // The login cookie was just set, but the (server) root layout — and the app top bar
    // it renders — was already cached without a session. Re-fetch the server tree so it
    // re-resolves identity from the new cookie; otherwise the chrome only appears after a
    // manual refresh.
    router.refresh()
  }

  return (
    <Box component="form" onSubmit={onSubmit}>
      <Stack spacing={2}>
        <Typography variant="h5" component="h1">
          Sign in
        </Typography>
        {error ? <Alert severity="error">{error}</Alert> : null}
        <TextField
          id="login-email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <TextField
          id="login-password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" variant="contained" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </Stack>
    </Box>
  )
}

export default function LoginPage() {
  return (
    <Container maxWidth="xs" sx={{ py: 8 }}>
      {/* useSearchParams requires a Suspense boundary in the App Router. */}
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </Container>
  )
}
