import type { StoreApi } from 'zustand'
import { createStore, useStore } from 'zustand'
import { ApiError, toApiError } from '../api/errors'
import {
  applyBehaviors,
  buildBehaviorPlan,
  seedDefaults,
  stripUnstored,
  type DraftRecord,
} from './behaviors'
import type { ViewDescriptor } from './descriptor'

// Per-view client stores. Each is SEEDED with server-fetched initialData and never
// fetches on mount — the server owns data + caching, the client owns interaction
// state (CONVENTIONS.md — State model). Zustand IS the state manager: no
// useSyncExternalStore controller layer. Stores are vanilla (one instance per
// mounted view); renderers bind to them with the selector hooks below.

/** Minimum record shape the engine relies on. */
export interface HasId {
  id: string
}

/**
 * Server Actions the engine binds per entity. Writes never go client -> Go; the
 * form store calls these (which run on the server, hit Go, then revalidateTag).
 */
export interface EntityActions<T extends HasId> {
  create: (body: Partial<T>) => Promise<T>
  update: (id: string, body: Partial<T>) => Promise<T>
  remove?: (id: string) => Promise<void>
}

// --- entity store (list + selection) ---

export interface EntityState<T extends HasId> {
  records: T[]
  selected: T | null
  error: ApiError | null
  setSelected: (record: T | null) => void
  setError: (error: ApiError | null) => void
}

export type EntityStoreApi<T extends HasId> = StoreApi<EntityState<T>>

export function createEntityStore<T extends HasId>(
  _descriptor: ViewDescriptor<T>,
  initialData: T[],
): EntityStoreApi<T> {
  return createStore<EntityState<T>>((set) => ({
    records: initialData,
    selected: null,
    error: null,
    setSelected: (selected) => set({ selected }),
    setError: (error) => set({ error }),
  }))
}

// --- form store (draft + commit via Server Action) ---

export interface FormState<T extends HasId> {
  draft: Partial<T>
  dirty: boolean
  error: ApiError | null
  /** Load a record into the draft for editing (clears dirty). */
  edit: (record: Partial<T>) => void
  setField: <K extends keyof T>(key: K, value: T[K]) => void
  /** Create (no id) or update (has id) via the bound Server Action; clears dirty. */
  commit: () => Promise<T | null>
  reset: () => void
}

export type FormStoreApi<T extends HasId> = StoreApi<FormState<T>>

export function createFormStore<T extends HasId>(
  descriptor: ViewDescriptor<T>,
  actions: EntityActions<T>,
  initial: Partial<T> = {},
): FormStoreApi<T> {
  // Resolve compute/on_change/store behaviors once (throws on cycles or unknown
  // function names — a module bug, not a runtime condition). Seeding first fills
  // missing fields with their defaults (declared `default` or the type's zero
  // value — defaults feed the computes).
  const plan = buildBehaviorPlan(descriptor)
  const seed = (record: Partial<T>): Partial<T> => {
    const defaulted = seedDefaults(plan, { ...record } as DraftRecord)
    // A record with an id already has real, possibly user-set values — loading
    // it for edit, or re-seeding it after commit with what Go just returned,
    // must NOT re-fire on_change (it would silently overwrite, e.g., a
    // manually chosen star rating with a fresh status-derived suggestion).
    // `null` runs the compute-only pass instead: display-only (store:false)
    // values still repopulate, without marking the form dirty.
    //
    // A record with no id is genuinely new: pass every defaulted key as
    // "changed", the same code path a real edit takes, so on_change
    // suggestions apply to the freshly defaulted values (e.g. status's
    // literal default seeding an initial score).
    const hasId = (record as Partial<HasId>).id != null
    const changed = hasId ? null : Object.keys(defaulted)
    return applyBehaviors(plan, defaulted, changed) as Partial<T>
  }

  return createStore<FormState<T>>((set, get) => ({
    draft: seed(initial),
    dirty: false,
    error: null,
    edit: (record) => set({ draft: seed(record), dirty: false, error: null }),
    setField: (key, value) =>
      set((state) => ({
        // One edit = on_change patches + dependent recomputes, in plan order.
        draft: applyBehaviors(
          plan,
          { ...state.draft, [key]: value } as DraftRecord,
          [key as string],
        ) as Partial<T>,
        dirty: true,
      })),
    commit: async () => {
      const { draft } = get()
      const id = (draft as Partial<HasId>).id
      // store:false fields never reach Go — they have no column.
      const payload = stripUnstored(draft, plan.unstored)
      try {
        const saved = id ? await actions.update(id, payload) : await actions.create(payload)
        // Reconcile with the authoritative server record; revalidation refreshes
        // lists. Re-seed so display-only computed values survive the reconcile
        // (the server response never carries them).
        set({ draft: seed(saved), dirty: false, error: null })
        return saved
      } catch (e) {
        set({ error: toApiError(e) })
        return null
      }
    },
    reset: () => set({ draft: seed(initial), dirty: false, error: null }),
  }))
}

// --- tree store (hierarchy + expansion) ---

export interface TreeNode extends HasId {
  parent_id?: string | null
}

export interface TreeState<T extends TreeNode> {
  records: T[]
  expanded: Set<string>
  roots: () => T[]
  children: (id: string) => T[]
  toggle: (id: string) => void
}

export type TreeStoreApi<T extends TreeNode> = StoreApi<TreeState<T>>

export function createTreeStore<T extends TreeNode>(
  _descriptor: ViewDescriptor<T>,
  initialData: T[],
): TreeStoreApi<T> {
  return createStore<TreeState<T>>((set, get) => ({
    records: initialData,
    expanded: new Set<string>(),
    roots: () => get().records.filter((r) => r.parent_id == null),
    children: (id) => get().records.filter((r) => r.parent_id === id),
    toggle: (id) =>
      set((state) => {
        const expanded = new Set(state.expanded)
        if (expanded.has(id)) expanded.delete(id)
        else expanded.add(id)
        return { expanded }
      }),
  }))
}

// --- dashboard store (widgets + refresh via Server Action) ---

export interface Widget {
  id: string
  title: string
  [key: string]: unknown
}

export interface DashboardState {
  widgets: Widget[]
  error: ApiError | null
  refresh: () => Promise<void>
}

export type DashboardStoreApi = StoreApi<DashboardState>

export function createDashboardStore<T = Record<string, unknown>>(
  _descriptor: ViewDescriptor<T>,
  refreshAction: () => Promise<Widget[]>,
  initialWidgets: Widget[] = [],
): DashboardStoreApi {
  return createStore<DashboardState>((set) => ({
    widgets: initialWidgets,
    error: null,
    refresh: async () => {
      try {
        set({ widgets: await refreshAction(), error: null })
      } catch (e) {
        set({ error: toApiError(e) })
      }
    },
  }))
}

// --- typed selector hooks (renderers bind via these) ---

export const useEntityRecords = <T extends HasId>(store: EntityStoreApi<T>): T[] =>
  useStore(store, (s) => s.records)
export const useEntitySelected = <T extends HasId>(store: EntityStoreApi<T>): T | null =>
  useStore(store, (s) => s.selected)
export const useEntityError = <T extends HasId>(store: EntityStoreApi<T>): ApiError | null =>
  useStore(store, (s) => s.error)

export const useFormDraft = <T extends HasId>(store: FormStoreApi<T>): Partial<T> =>
  useStore(store, (s) => s.draft)
export const useFormDirty = <T extends HasId>(store: FormStoreApi<T>): boolean =>
  useStore(store, (s) => s.dirty)
export const useFormError = <T extends HasId>(store: FormStoreApi<T>): ApiError | null =>
  useStore(store, (s) => s.error)
