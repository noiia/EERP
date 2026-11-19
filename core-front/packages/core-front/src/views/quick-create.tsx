'use client'
import { useState, type ReactNode } from 'react'
import type { EntityListOptions } from '../api/list-options'
import { usePermission } from '../auth/Can'
import { moduleRegistry } from '../registry'
import { useRelationOps, type RelationRecord } from './relation-ops'
import { RelationCreateWizard } from './relation-widgets'

// Quick create from a Gantt row, a Calendar day or a Kanban column: a click on
// an empty spot opens the entity's own form as a dialog (the relation
// wizard), pre-filled from where the user clicked plus the many2one values the
// list is scoped to (a project's task list → that project); the created record
// is handed back so the view shows it in place.

/** The view's scope (`filter[col]=<id>`) as many2one values of the entity's form. */
export function scopePreset(entity: string, scope: EntityListOptions | undefined): Record<string, unknown> {
  const fields = moduleRegistry.formDescriptorFor(entity)?.fields ?? []
  const preset: Record<string, unknown> = {}
  for (const f of fields) {
    const value = scope?.filter?.[f.name]
    if (typeof value === 'string' && value && f.type === 'relation' && f.relation?.kind === 'many2one') {
      preset[f.name] = value
    }
  }
  return preset
}

export function useQuickCreate(
  entity: string,
  scope: EntityListOptions | undefined,
  onCreated: (record: RelationRecord) => void,
): { canCreate: boolean; open: (at: Record<string, unknown>) => void; dialog: ReactNode } {
  const ops = useRelationOps()
  const canWrite = usePermission(`${entity}:${entity}:write`)
  const [preset, setPreset] = useState<Record<string, unknown> | null>(null)
  const canCreate = Boolean(ops) && canWrite
  return {
    canCreate,
    open: (at) => {
      if (canCreate) setPreset({ ...scopePreset(entity, scope), ...at })
    },
    dialog:
      ops && preset ? (
        <RelationCreateWizard
          rel={{ entity, kind: 'many2one' }}
          ops={ops}
          preset={preset}
          onClose={() => setPreset(null)}
          onCreated={onCreated}
        />
      ) : null,
  }
}

/** A click that landed on the view's own background, not on a card, bar or control. */
export function isEmptyZoneClick(event: React.MouseEvent): boolean {
  const target = event.target as Element
  return !target.closest('.MuiCard-root, button, a, input, [role="button"], [data-no-quick-create]')
}
