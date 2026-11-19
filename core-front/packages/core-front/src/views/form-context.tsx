'use client'
import { createContext, useContext, type ReactNode } from 'react'

// A form's context: values a field condition may test that aren't part of the
// record — e.g. a workspace setting deciding whether a field is editable
// (warehouse's automatic product reference). A form view names a settings
// endpoint in `ViewDescriptor.formContext`; the loader reads it server-side
// and FormRenderer provides its JSON here. Conditions see each key as
// `context.<key>` (`{ field: 'context.auto_reference', op: 'eq', value: true }`)
// — merged only into what conditions read, never into the draft, so nothing
// of it is ever sent with a save or lost when the record reloads.

const FormContextValues = createContext<Record<string, unknown> | null>(null)

export function FormContextProvider({ values, children }: { values?: Record<string, unknown> | null; children: ReactNode }) {
  return <FormContextValues.Provider value={values ?? null}>{children}</FormContextValues.Provider>
}

/** The record field conditions evaluate against: the draft, plus the form's
 * context as `context.<key>` keys. */
export function useConditionRecord(draft: Record<string, unknown>): Record<string, unknown> {
  const values = useContext(FormContextValues)
  if (!values) return draft
  const out: Record<string, unknown> = { ...draft }
  for (const [key, value] of Object.entries(values)) out[`context.${key}`] = value
  return out
}
