import { useEffect, useState } from 'react'
import { toApiError, type SerializedError } from '../api/errors'
import type { EntityActions, HasId } from './stores'

// Shared drag-to-update mechanics for Kanban (Phase 2) and Calendar (Phase 3)
// of docs/roadmaps/list-view-modes.md: both move a record by PATCHing ONE
// field through the entity's existing update Server Action — the same one
// FormRenderer's Save calls — optimistically, reverting on a rejected write.
// Written once here so Calendar reuses Kanban's logic instead of duplicating it.

export interface OptimisticFieldMove<T extends HasId> {
  /** The working record set: initialData, plus any in-flight optimistic edits. */
  records: T[]
  /** The last rejected move's error, or null. Cleared at the start of the next move. */
  error: SerializedError | null
  /**
   * Set `field` to `value` on the record `id`, optimistically, then PATCH it
   * via `actions.update`. A no-op if the record already holds that value. On
   * rejection (permission, a `states.required` block, ...) the record reverts
   * to its prior value and `error` is set — the same failure mode a form's
   * Save has, because this is a real write, not a display trick.
   */
  moveField: (id: string, value: unknown) => Promise<void>
}

export function useOptimisticFieldMove<T extends HasId>(
  initialData: T[],
  actions: EntityActions<T>,
  field: string,
): OptimisticFieldMove<T> {
  const [records, setRecords] = useState(initialData)
  const [error, setError] = useState<SerializedError | null>(null)

  // The server re-seeds initialData on every load (a fresh navigation, or a
  // revalidated Server Action elsewhere reflecting through this page); local
  // optimistic edits only need to survive until that authoritative data lands.
  useEffect(() => {
    setRecords(initialData)
  }, [initialData])

  async function moveField(id: string, value: unknown) {
    const record = records.find((r) => r.id === id)
    if (!record) return
    const current = (record as Record<string, unknown>)[field] ?? null
    if (current === (value ?? null)) return
    const previous = records
    setError(null)
    setRecords((rs) => rs.map((r) => (r.id === id ? ({ ...r, [field]: value } as T) : r)))
    try {
      await actions.update(id, { [field]: value } as Partial<T>)
    } catch (e) {
      setRecords(previous)
      const err = toApiError(e)
      setError({ code: err.code, message: err.message, requestId: err.requestId })
    }
  }

  return { records, error, moveField }
}
