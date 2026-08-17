'use client'
import { useEffect, useState } from 'react'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'
import { fieldLabel, type RelationDescriptor } from './descriptor'
import { moduleRegistry } from '../registry'
import { junctionColumns, MissingOpsHint, relationOf } from './relation-widgets'
import { useRelationOps, type RelationOps, type RelationRecord } from './relation-ops'
import type { WidgetProps } from './widgets'

// relation/summary — a many2one-only OPT-IN override of the stock `search`
// widget: a READ-ONLY one-row recap of the linked record, e.g.
// property_management_equipment's "Equipped in" page showing which
// property this equipment belongs to (name/city/tenant names) without
// duplicating the FK picker the equipment form already has elsewhere.
// A purpose-built widget (like TaxTotalsWidget), not a generalization of
// RelationListWidget's column system to arbitrary nested "relation.field"
// paths — it resolves exactly ONE level of nesting, declared explicitly via
// widgetOptions, never inferred.
//
// widgetOptions.fields: scalar column names read straight off the linked
// record (e.g. ['name', 'city']). widgetOptions.relatedRelationField:
// OPTIONAL — the name of a relation field DECLARED ON THE LINKED ENTITY'S
// OWN registered descriptor (looked up via moduleRegistry.formDescriptorFor,
// the SAME mechanism the create-wizard already uses to resolve a target
// entity's form — see relation-widgets.tsx's creationDescriptor) whose own
// linked records get resolved and comma-joined into one more column
// (property_management's `current_tenant` many2many -> "Tenant").

interface RelationSummaryOptions {
  fields: string[]
  relatedRelationField?: string
  relatedRelationLabel?: string
}

function widgetOptionsOf(field: WidgetProps['field']): RelationSummaryOptions {
  const raw = field.widgetOptions ?? {}
  const fields = Array.isArray(raw.fields) ? raw.fields.filter((f): f is string => typeof f === 'string') : ['name']
  return {
    fields: fields.length > 0 ? fields : ['name'],
    relatedRelationField: typeof raw.relatedRelationField === 'string' ? raw.relatedRelationField : undefined,
    relatedRelationLabel: typeof raw.relatedRelationLabel === 'string' ? raw.relatedRelationLabel : undefined,
  }
}

/** Resolve widgetOptions.relatedRelationField's OWN relation block off the
 * linked entity's registered descriptor — never redeclared here. */
function subRelationOf(entity: string, fieldName: string): RelationDescriptor | null {
  const descriptor = moduleRegistry.formDescriptorFor(entity)
  const field = descriptor?.fields.find((f) => f.name === fieldName)
  return field?.relation ?? null
}

/** Resolve subRel's linked records (both m2m via a junction and o2m
 * directly), scoped to the linked record's own id — same two data paths
 * RelationTagsWidget/RelationListWidget already use, just read-only here. */
async function loadSubRelation(
  ops: RelationOps,
  subRel: RelationDescriptor,
  ownEntity: string,
  ownRecordId: string,
): Promise<RelationRecord[]> {
  if (subRel.kind === 'one2many' && subRel.inverseField) {
    return ops.list(subRel.entity, { filter: { [subRel.inverseField]: ownRecordId }, pageSize: 100 })
  }
  if (subRel.kind === 'many2many' && subRel.via) {
    const cols = junctionColumns(subRel, ownEntity)
    const junctions = await ops.list(subRel.via, { filter: { [cols.own]: ownRecordId }, pageSize: 100 })
    const resolved = await Promise.all(
      junctions.map((row) => {
        const relatedId = row[cols.related]
        if (typeof relatedId !== 'string') return null
        return ops.get(subRel.entity, relatedId).catch((): RelationRecord => ({ id: relatedId }))
      }),
    )
    return resolved.filter((r): r is RelationRecord => r !== null)
  }
  return []
}

export function RelationSummaryWidget({ field, recordId: _recordId, value }: WidgetProps) {
  const t = useT()
  const ops = useRelationOps()
  const rel = relationOf(field)
  const options = widgetOptionsOf(field)
  const relatedId = typeof value === 'string' ? value : null

  const [related, setRelated] = useState<RelationRecord | null>(null)
  const [subRecords, setSubRecords] = useState<RelationRecord[]>([])

  useEffect(() => {
    if (!ops || !relatedId) {
      setRelated(null)
      setSubRecords([])
      return
    }
    let cancelled = false
    ops
      .get(rel.entity, relatedId)
      .then((found) => {
        if (cancelled) return
        setRelated(found)
        if (!options.relatedRelationField) return
        const subRel = subRelationOf(rel.entity, options.relatedRelationField)
        if (!subRel) return
        void loadSubRelation(ops, subRel, rel.entity, relatedId).then((rows) => {
          if (!cancelled) setSubRecords(rows)
        })
      })
      .catch(() => {
        if (!cancelled) setRelated(null)
      })
    return () => {
      cancelled = true
    }
  }, [ops, rel.entity, relatedId, options.relatedRelationField])

  if (!ops) return <MissingOpsHint label={field.hideLabel ? null : t(fieldLabel(field))} />
  if (!relatedId || !related) {
    return (
      <Typography variant="body2" color="text.secondary">
        {t('Not linked.')}
      </Typography>
    )
  }

  const relationLabel = options.relatedRelationLabel ?? t('Related')
  const subLabelField = options.relatedRelationField
    ? (subRelationOf(rel.entity, options.relatedRelationField)?.labelField ?? 'name')
    : 'name'
  const joined = subRecords.map((r) => String(r[subLabelField] ?? r.id)).join(', ')

  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          {options.fields.map((f) => (
            <TableCell key={f}>{t(fieldLabel({ name: f, type: 'text' }))}</TableCell>
          ))}
          {options.relatedRelationField && <TableCell>{relationLabel}</TableCell>}
        </TableRow>
      </TableHead>
      <TableBody>
        <TableRow>
          {options.fields.map((f) => (
            <TableCell key={f}>{String(related[f] ?? '')}</TableCell>
          ))}
          {options.relatedRelationField && <TableCell>{joined}</TableCell>}
        </TableRow>
      </TableBody>
    </Table>
  )
}
