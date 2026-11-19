'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Server Actions for Settings → Global settings → Integrations → Stripe (Go:
// modules/payment_stripe, GET|PUT /settings/integrations/stripe,
// settings:integrations:read|write). The keys are write-only: Go never sends
// them back, only whether each is set.

export interface StripeStatus {
  enabled: boolean
  secret_key_set: boolean
  webhook_secret_set: boolean
  /** The payment_stripe module is active (App Store). */
  active: boolean
}

export type SaveResult = { ok: true } | { ok: false; message: string }

/** null: the module isn't installed (or the caller can't read integrations). */
export async function getStripeStatus(): Promise<StripeStatus | null> {
  try {
    return await apiRequest<StripeStatus>('GET', '/settings/integrations/stripe')
  } catch {
    return null
  }
}

/** Empty keys keep the saved ones. */
export async function saveStripeSettings(s: { enabled: boolean; secret_key: string; webhook_secret: string }): Promise<SaveResult> {
  try {
    await apiRequest('PUT', '/settings/integrations/stripe', s)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : '' }
  }
}
