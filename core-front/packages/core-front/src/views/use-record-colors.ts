'use client'
import { useCallback, useEffect, useState } from 'react'
import { moduleRegistry } from '../registry'
import { isHexColor } from './color-tags'
import type { FieldDescriptor, ViewDescriptor } from './descriptor'
import { useRelationOps, type RelationRecord } from './relation-ops'
import { junctionColumns } from './relation-widgets'

// The colors of the records on screen, through a color-tags many2many field
// (ViewModeDefaults.colorTagsField): junction rows `in[<own>]=<ids>` by chunks
// of COLOR_CHUNK ids, each paged until a short page, sorted by creation (the
// stripe order), then the related records `in[id]=` by chunks. Keyed on the
// sorted id set, so moving or reordering records never refetches.

const COLOR_CHUNK = 100

/** The many2many field `name` of the descriptor, else of the entity's form
 * descriptor (a list rarely declares a relation it can't show as a column). */
export function colorTagsFieldOf(
  descriptor: ViewDescriptor,
  name: string | undefined,
): FieldDescriptor | null {
  if (!name) return null
  const field =
    descriptor.fields.find((f) => f.name === name) ??
    moduleRegistry.formDescriptorFor(descriptor.entity)?.fields.find((f) => f.name === name)
  return field?.relation?.kind === 'many2many' && field.relation.via ? field : null
}

function chunks<V>(values: V[]): V[][] {
  const out: V[][] = []
  for (let i = 0; i < values.length; i += COLOR_CHUNK) out.push(values.slice(i, i + COLOR_CHUNK))
  return out
}

export function useRecordColors(entity: string, field: FieldDescriptor | null, ids: string[]) {
  const ops = useRelationOps()
  const [colors, setColors] = useState<Map<string, string[]>>(() => new Map())
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((v) => v + 1), [])

  const rel = field?.relation
  const colorField =
    typeof field?.widgetOptions?.colorField === 'string' ? field.widgetOptions.colorField : 'color'
  const cols = rel ? junctionColumns(rel, entity) : null
  const configKey =
    rel?.via && cols
      ? [rel.entity, rel.via, cols.own, cols.related, colorField].join('\u0000')
      : null
  const idsKey = [...ids].sort().join(',')

  useEffect(() => {
    if (!ops || configKey == null || idsKey === '') {
      setColors(new Map())
      return
    }
    const [related, via, own, link, colorKey] = configKey.split('\u0000')
    let cancelled = false
    const load = async () => {
      const junctions: RelationRecord[] = []
      for (const chunk of chunks(idsKey.split(','))) {
        for (let page = 1; ; page++) {
          const rows = await ops.list(via, {
            in: { [own]: chunk },
            order: 'created_at',
            page,
            pageSize: COLOR_CHUNK,
          })
          junctions.push(...rows)
          if (rows.length < COLOR_CHUNK) break
        }
      }
      const relatedIds = [
        ...new Set(junctions.map((j) => j[link]).filter((v): v is string => typeof v === 'string')),
      ]
      const byId = new Map<string, unknown>()
      for (const chunk of chunks(relatedIds)) {
        for (const r of await ops.list(related, { in: { id: chunk }, pageSize: COLOR_CHUNK }))
          byId.set(r.id, r[colorKey])
      }
      const out = new Map<string, string[]>()
      for (const j of junctions) {
        const color = byId.get(String(j[link]))
        if (!isHexColor(color)) continue
        const key = String(j[own])
        out.set(key, [...(out.get(key) ?? []), color])
      }
      return out
    }
    void load()
      .then((out) => {
        if (!cancelled) setColors(out)
      })
      // Decoration only: a refused read (no right on the junction) shows no colors.
      .catch(() => {
        if (!cancelled) setColors(new Map())
      })
    return () => {
      cancelled = true
    }
  }, [ops, configKey, idsKey, version])

  return { colors, reload }
}
