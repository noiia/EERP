import { create } from 'zustand'

// Session-only side-channel: whether a REQUIRED, DEFERRED many2many field
// (relation-widgets.tsx's RelationTagsWidget, widgetOptions.deferred)
// currently resolves to at least one link — existing junction rows plus
// anything staged to link, minus anything staged to unlink.
//
// requiredMissing() (descriptor.ts) is a pure function over the draft alone,
// and a deferred field's draft value only ever carries the staged DELTA (see
// its own doc comment): for a brand-new record that delta IS the whole
// truth, but for an EXISTING record the pre-existing links live only in this
// widget's own resolved state, never in the draft. The widget publishes its
// live count here; requiredMissing consults it through an injected lookup
// (keeping the function itself pure/testable) for exactly that
// existing-record case it otherwise can't see.
//
// Single-slot-per-field-name, like record-label-store.ts's single current
// form — only one form is ever mounted at a time, so this doesn't need to be
// scoped by entity/record id too.
export interface HasLinksState {
  hasLinks: Readonly<Record<string, boolean>>
  setHasLinks: (fieldName: string, value: boolean) => void
}

export const useHasLinksStore = create<HasLinksState>((set, get) => ({
  hasLinks: {},
  setHasLinks: (fieldName, value) => {
    if (get().hasLinks[fieldName] === value) return
    set((s) => ({ hasLinks: { ...s.hasLinks, [fieldName]: value } }))
  },
}))
