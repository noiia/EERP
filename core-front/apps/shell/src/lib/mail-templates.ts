'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// Server Actions for Settings → Email templates (Go: internal/mail's
// TemplateHandler, ADR-027). Mutations return a result object — Next masks
// errors thrown inside Server Actions.

export interface TemplateContent { subject: string; html: string }

/** One registered email: its variables, code defaults and this workspace's overrides, per language. */
export interface MailTemplate {
  key: string
  label: string
  vars: string[]
  defaults: Record<string, TemplateContent>
  overrides: Record<string, TemplateContent>
}

/** `message` is Go's message, or '' for an unexpected failure (the form shows its own fallback). */
export type SaveResult = { ok: true } | { ok: false; message: string }

const path = (key: string, locale: string) => `/settings/mail_templates/${encodeURIComponent(key)}/${encodeURIComponent(locale)}`

export async function getMailTemplates(): Promise<MailTemplate[]> {
  try {
    return (await apiRequest<{ data: MailTemplate[] }>('GET', '/settings/mail_templates')).data ?? []
  } catch {
    return []
  }
}

async function run(fn: () => Promise<unknown>): Promise<SaveResult> {
  try {
    await fn()
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : '' }
  }
}

export async function saveMailTemplate(key: string, locale: string, content: TemplateContent): Promise<SaveResult> {
  return run(() => apiRequest('PUT', path(key, locale), content))
}

/** Drops the workspace's override: the default text applies again. */
export async function resetMailTemplate(key: string, locale: string): Promise<SaveResult> {
  return run(() => apiRequest('DELETE', path(key, locale)))
}
