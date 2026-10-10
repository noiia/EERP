import 'server-only'
import { forwardedFor } from './bff'

export interface LoginMethod {
  id: string
  kind: 'password' | 'redirect'
  label: string
}
export interface LoginMethods {
  default: LoginMethod
  alternatives: LoginMethod[]
}

const LOCAL_ONLY: LoginMethods = {
  default: { id: 'local', kind: 'password', label: '' },
  alternatives: [],
}

/** The login screen's methods (Go /auth/methods). Any failure degrades to
 * local password only — a broken IdP config never hides the local form. */
export async function getLoginMethods(): Promise<LoginMethods> {
  try {
    const res = await fetch(
      `${process.env.API_BASE}/api/v${process.env.API_VERSION ?? '1'}/auth/methods`,
      {
        cache: 'no-store',
        headers: await forwardedFor(),
        signal: AbortSignal.timeout(3000),
      },
    )
    if (!res.ok) return LOCAL_ONLY
    const body = (await res.json()) as LoginMethods
    return body?.default?.id
      ? { default: body.default, alternatives: body.alternatives ?? [] }
      : LOCAL_ONLY
  } catch {
    return LOCAL_ONLY
  }
}
