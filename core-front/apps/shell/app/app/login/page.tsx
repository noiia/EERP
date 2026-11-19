import Container from '@mui/material/Container'
import { Suspense } from 'react'
import { getLoginMethods } from '@/lib/auth-methods'
import LoginScreen from './LoginScreen'

// The ERP login (ADR-030): the default method on top, the enabled
// alternatives below. getLoginMethods never throws — local is the fallback.
export default async function LoginPage() {
  const methods = await getLoginMethods()
  return (
    <Container maxWidth="xs" sx={{ py: 8 }}>
      {/* useSearchParams requires a Suspense boundary in the App Router. */}
      <Suspense fallback={null}>
        <LoginScreen methods={methods} />
      </Suspense>
    </Container>
  )
}
