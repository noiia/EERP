'use client'
import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { erpPath, useSessionStore, useT, ViewBanner } from '@eerp/core-front'
import { authBffUrl } from '@/lib/auth-url'
import type { LoginMethod, LoginMethods } from '@/lib/auth-methods'

// Must match session.ts's FORCE_PASSWORD_CHANGE_PATH — rebuilt here rather than
// imported because that module is 'server-only' and this is a client component.
const FORCE_PASSWORD_CHANGE_PATH = erpPath('/force-password-change')
const LOCAL: LoginMethod = { id: 'local', kind: 'password', label: '' }

function PasswordForm({ method }: { method: LoginMethod }) {
  const t = useT()
  const router = useRouter()
  const params = useSearchParams()
  const isLocal = method.id === 'local'
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)

    const res = await fetch(isLocal ? authBffUrl('login') : '/api/auth/ldap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isLocal ? { email: user, password } : { username: user, password }),
    })
    const data = (await res.json().catch(() => null)) as {
      identity?: unknown
      error?: { message?: string }
    } | null

    if (!res.ok) {
      // Surface the server's message (e.g. "Invalid email or password.").
      setError(data?.error?.message ?? t('Login failed'))
      setPending(false)
      return
    }

    const identity = (data?.identity as { mustChangePassword?: boolean } | undefined) ?? null
    useSessionStore.getState().setIdentity(identity as never)
    // erpPath() also pins `next` inside the ERP, so a crafted ?next=//evil.example
    // can never navigate off-site.
    router.push(
      erpPath(
        identity?.mustChangePassword ? FORCE_PASSWORD_CHANGE_PATH : params.get('next') || '/',
      ),
    )
    // Re-fetch the server tree so the cached root layout (and app top bar) picks up
    // the session cookie that was just set.
    router.refresh()
  }

  return (
    <Box component="form" onSubmit={onSubmit}>
      <Stack spacing={2}>
        {method.label && <Typography variant="subtitle1">{method.label}</Typography>}
        {error ? <ViewBanner status="error">{error}</ViewBanner> : null}
        <TextField
          id="login-user"
          label={isLocal ? t('Email') : t('Username')}
          type={isLocal ? 'email' : 'text'}
          autoComplete={isLocal ? 'email' : 'username'}
          value={user}
          onChange={(e) => setUser(e.target.value)}
          required
        />
        <TextField
          id="login-password"
          label={t('Password')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" variant="contained" disabled={pending}>
          {pending ? t('Signing in…') : t('Sign in')}
        </Button>
      </Stack>
    </Box>
  )
}

function RedirectButton({ method, primary }: { method: LoginMethod; primary: boolean }) {
  const t = useT()
  const params = useSearchParams()
  const provider = method.id.replace(/^oidc:/, '')
  const href = `/api/auth/oidc/${encodeURIComponent(provider)}/start?next=${encodeURIComponent(params.get('next') || '/')}`
  return (
    <Button
      component="a"
      href={href}
      variant={primary ? 'contained' : 'outlined'}
      size={primary ? 'large' : 'medium'}
      fullWidth
    >
      {t('Continue with')} {method.label}
    </Button>
  )
}

export default function LoginScreen({ methods }: { methods: LoginMethods }) {
  const t = useT()
  const params = useSearchParams()
  // ?method=local always shows the local form, so a broken IdP never locks admins out.
  const forced = params.get('method') === 'local'
  const [top, setTop] = useState<LoginMethod>(forced ? LOCAL : methods.default)
  const all = [methods.default, ...methods.alternatives]
  const others = all.filter((m) => m.id !== top.id)

  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">
        {t('Sign in')}
      </Typography>
      {params.get('error') === 'sso' && (
        <ViewBanner status="error">
          {t('Single sign-on failed. Try again or use another method.')}
        </ViewBanner>
      )}
      {top.kind === 'password' ? (
        <PasswordForm key={top.id} method={top} />
      ) : (
        <RedirectButton method={top} primary />
      )}
      {others.length > 0 && (
        <>
          <Divider>{t('or')}</Divider>
          <Stack spacing={1}>
            {others.map((m) =>
              m.kind === 'redirect' ? (
                <RedirectButton key={m.id} method={m} primary={false} />
              ) : (
                <Link key={m.id} component="button" type="button" onClick={() => setTop(m)}>
                  {m.id === 'local'
                    ? t('Sign in with email and password')
                    : `${t('Sign in with')} ${m.label || t('the company directory')}`}
                </Link>
              ),
            )}
          </Stack>
        </>
      )}
    </Stack>
  )
}
