'use server'
import { meFetch } from './account'

/** `error` is a code the account form translates client-side. */
export type ProfileResult = { ok: true } | { ok: false; error: 'session' | 'invalid' | 'failed' } | null

/** Server action behind the /account profile form: PUT /api/v1/website/me. */
export async function saveProfile(_prev: ProfileResult, form: FormData): Promise<ProfileResult> {
  const field = (k: string) => String(form.get(k) ?? '')
  const res = await meFetch({
    method: 'PUT',
    body: JSON.stringify({ name: field('name'), surname: field('surname'), phone: field('phone') }),
  }).catch(() => undefined)
  if (res === null || res?.status === 401) return { ok: false, error: 'session' }
  if (res?.status === 400) return { ok: false, error: 'invalid' }
  return res?.ok ? { ok: true } : { ok: false, error: 'failed' }
}
