'use client'
import { useT } from './translate'

// Translated text as a component. The active locale is CLIENT state (persisted
// useI18nStore), so a Server Component can't call useT — it renders <T text="..."/>
// instead and this leaf translates at the client boundary. Titles computed on the
// server (e.g. the catch-all module page heading) localize this way; falls back to
// the source text like every lookup.
export function T({ text }: { text: string }) {
  const t = useT()
  return <>{t(text)}</>
}
