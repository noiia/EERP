import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import { T } from '@eerp/core-front'
import { safeNext } from '../urls'

/** What an anonymous visitor sees instead of a login-required block (form, booking):
 * a login button and a sign-up link, both coming back to `next` (a same-site path). */
export function LoginGate({ next }: { next: string }) {
  const q = `?next=${encodeURIComponent(safeNext(next, '/'))}`
  return (
    <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
      <Button variant="contained" href={`/login${q}`}><T text="Log in to continue" /></Button>
      <Link href={`/signup${q}`} variant="body2"><T text="No account yet? Sign up" /></Link>
    </Stack>
  )
}
