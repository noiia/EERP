'use server'
import { apiRequest } from '@eerp/core-front/server'

// Server Actions for OAuth sign-in of MCP clients such as claude.ai and ChatGPT
// (ADR-043, Go: core/internal/mcpoauth). The consent page reads and answers an
// authorization request; Settings → Account lists and revokes the apps a user
// connected.

/** The authorization request's own parameters, the only ones relayed to Go. */
const AUTHORIZE_PARAMS = [
  'client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'resource', 'scope',
] as const

export type AuthorizeCheck =
  | { ok: true; client_id: string; client_name: string; client_host: string; redirect_uri: string }
  /** redirect_to is set once the redirect URI is known good: the error may go back to the app. */
  | { ok: false; error: string; error_description: string; redirect_to?: string }

export type AuthorizeDecision =
  | { ok: true; redirect_to: string }
  | { ok: false; error: string; error_description: string; redirect_to?: string }

export interface AuthorizedApp {
  id: string
  client_name: string
  client_id: string
  created_at: string
  last_used_at: string | null
}

function pick(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of AUTHORIZE_PARAMS) if (params[k]) out[k] = params[k]
  return out
}

/** null when EERP can't be reached or OAuth is off (Go has no route then). */
export async function checkAuthorization(params: Record<string, string>): Promise<AuthorizeCheck | null> {
  try {
    return await apiRequest<AuthorizeCheck>('GET', `/oauth/authorize?${new URLSearchParams(pick(params))}`)
  } catch {
    return null
  }
}

export async function decideAuthorization(params: Record<string, string>, approve: boolean): Promise<AuthorizeDecision | null> {
  try {
    return await apiRequest<AuthorizeDecision>('POST', '/oauth/authorize', { params: pick(params), approve })
  } catch {
    return null
  }
}

/** null when OAuth is off: the section is hidden. */
export async function listAuthorizedApps(): Promise<AuthorizedApp[] | null> {
  try {
    return (await apiRequest<{ data: AuthorizedApp[] }>('GET', '/oauth/grants')).data
  } catch {
    return null
  }
}

export async function revokeAuthorizedApp(id: string): Promise<boolean> {
  try {
    await apiRequest('DELETE', `/oauth/grants/${encodeURIComponent(id)}`)
    return true
  } catch {
    return false
  }
}
