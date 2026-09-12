import { create } from 'zustand'

// Cross-cutting client mirror of "what's the current form record actually
// called" — the host shell's breadcrumb is a route-derived component with no
// access to the fetched record (it only sees the id in the URL), so
// FormRenderer reports the record's title-field value here and the
// breadcrumb reads it for the trailing crumb instead of a raw uuid. Session-
// only, like recently-changed-store — no persistence needed, and a stale
// entry is harmless since it's only ever read when its `id` still matches
// the current path segment.

export interface RecordLabelState {
  id: string | null
  label: string | null
  setLabel: (id: string, label: string | null) => void
}

export const useRecordLabelStore = create<RecordLabelState>((set) => ({
  id: null,
  label: null,
  setLabel: (id, label) => set({ id, label }),
}))
