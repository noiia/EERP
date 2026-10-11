'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Server Actions for Settings -> Authentication (LDAP / OIDC sign-in). Secrets are
// write-only: the GET never returns them, only has_* flags. Mutations return a
// result object — Next masks errors thrown inside Server Actions.

/** `message` is Go's message, or '' for an unexpected failure. */
export type SaveResult = { ok: true } | { ok: false; message: string }

export interface LDAPSettings {
  label: string
  url: string
  start_tls: boolean
  bind_dn: string
  bind_password?: string
  base_dn: string
  user_filter: string
  email_attr: string
  name_attr: string
  groups_attr: string
  group_search_base: string
  group_filter: string
  has_bind_password?: boolean
}
export interface OIDCSettings {
  id: string
  label: string
  issuer: string
  client_id: string
  client_secret?: string
  scopes: string
  groups_claim: string
  trust_email: boolean
  has_client_secret?: boolean
}
export interface AuthSettingsView {
  default: string
  enabled: string[]
  ldap?: LDAPSettings | null
  oidc: OIDCSettings[]
  role_mapping: { group: string; role_id: string }[]
  default_role_id: string | null
  erp_url: string
  callback_url: string
}
export type AuthSettingsInput = Omit<AuthSettingsView, 'callback_url'>

const EMPTY: AuthSettingsView = {
  default: 'local',
  enabled: [],
  ldap: null,
  oidc: [],
  role_mapping: [],
  default_role_id: null,
  erp_url: '',
  callback_url: '',
}

export type LoadResult = { ok: true; settings: AuthSettingsView } | { ok: false; message: string }

/** A failed load must not look like an empty config: saving it would wipe the stored one. */
export async function getAuthSettings(): Promise<LoadResult> {
  try {
    const s = await apiRequest<AuthSettingsView>('GET', '/settings/auth')
    return {
      ok: true,
      settings: {
        ...EMPTY,
        ...s,
        oidc: s.oidc ?? [],
        role_mapping: s.role_mapping ?? [],
        enabled: s.enabled ?? [],
      },
    }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : '' }
  }
}

export async function saveAuthSettings(s: AuthSettingsInput): Promise<SaveResult> {
  try {
    await apiRequest('PUT', '/settings/auth', s)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : '' }
  }
}

export async function testAuthMethod(method: string): Promise<{ ok: boolean; message: string }> {
  try {
    return await apiRequest<{ ok: boolean; message: string }>('POST', '/settings/auth/test', {
      method,
    })
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : '' }
  }
}

export async function listRoles(): Promise<{ id: string; name: string }[]> {
  try {
    const roles = await apiRequest<
      { data?: { id: string; name: string }[] } | { id: string; name: string }[]
    >('GET', '/roles')
    return Array.isArray(roles) ? roles : (roles.data ?? [])
  } catch {
    return []
  }
}
