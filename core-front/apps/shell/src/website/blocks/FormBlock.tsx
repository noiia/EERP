import { getSiteIdentity } from '@/lib/site-session'
import { getMyContact, getWebsiteMe, type MyContact, type WebsiteMe } from '../account'
import { ADDRESS_SUFFIXES } from '../form-config'
import type { FormConfig } from '../types'
import { LoginGate } from './LoginGate'
import { SiteForm, type FormValues } from './SiteForm'

/** The Form block (ADR-033): a login gate for an anonymous visitor when login is
 * required, else the form — prefilled for a signed-in visitor from their website
 * contact, falling back to their account for any empty field. `pageId` empty (the
 * editor preview of an unsaved page) renders it without a working submit. */
export async function FormBlock({ config, pageId, blockId, path }: { config: FormConfig; pageId: string; blockId: string; path: string }) {
  const signedIn = !!(await getSiteIdentity())
  if (config.login_required && !signedIn) {
    return <LoginGate next={config.after_login_slug ? `/${config.after_login_slug}` : path} />
  }
  let defaults: FormValues = {}
  const locked: string[] = []
  if (signedIn) {
    const [contact, me] = await Promise.all([getMyContact().catch(() => null), getWebsiteMe().catch(() => null)])
    defaults = prefill(config, contact, me)
    // Go keeps the account's email on the visitor's own contact: typing another is pointless.
    for (const f of config.fields) if (isContactField(config, f.target) && f.type === 'email' && f.column === 'email') locked.push(f.id)
  }
  return <SiteForm pageId={pageId} blockId={blockId} config={config} defaults={defaults} signedIn={signedIn} locked={locked} />
}

const isContactField = (c: FormConfig, target: number) => c.targets[target]?.table === 'contact'

/** Per field mapped onto a contact target: the contact's value, else the account's. */
function prefill(config: FormConfig, contact: MyContact | null, me: WebsiteMe | null): FormValues {
  const from = (col: string): unknown => {
    const v = (contact as Record<string, unknown> | null)?.[col]
    if (v != null && v !== '') return v
    const a = (me as Record<string, unknown> | null)?.[col]
    return typeof a === 'string' && a !== '' ? a : undefined
  }
  const out: FormValues = {}
  for (const f of config.fields) {
    if (!isContactField(config, f.target)) continue
    if (f.type === 'address') {
      const addr: Record<string, unknown> = {}
      for (const s of ADDRESS_SUFFIXES) {
        const v = from(f.column + s)
        if (v !== undefined) addr[s.slice(1)] = v
      }
      if (Object.keys(addr).length) out[f.id] = addr
    } else if (f.type !== 'checkbox') {
      const v = from(f.column)
      if (v !== undefined) out[f.id] = v
    }
  }
  return out
}
