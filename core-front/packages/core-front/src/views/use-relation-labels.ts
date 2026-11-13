'use client'
import { useEffect, useRef, useState } from 'react'
import type { FieldDescriptor } from './descriptor'
import { useRelationOps } from './relation-ops'

// Labels of many2one values (ids) for display — Kanban cards, search-bar chips
// and group-by values — read with the related entity's own list (`in[id]=`, by
// chunks of LABEL_CHUNK), each id once per mounted view. While a label loads it
// reads as '' (never flashes the id); an id the read can't resolve (refused,
// deleted, empty label) falls back to the raw value.

const LABEL_CHUNK = 100

const keyOf = (field: string, id: string) => `${field}\u0000${id}`

export function useRelationLabels(
  fields: FieldDescriptor[],
  refs: Array<[field: string, value: unknown]>,
): (field: string, value: unknown) => string {
  const ops = useRelationOps()
  const cache = useRef(new Map<string, string | null>())
  const [, setVersion] = useState(0)

  const related = new Map(
    fields
      // A many2many filter value is one related id too (search.filterOnlyFields).
      .filter((f) => f.type === 'relation' && (f.relation?.kind === 'many2one' || f.relation?.kind === 'many2many'))
      .map((f) => [f.name, f]),
  )
  const wanted = [
    ...new Set(
      refs
        .filter(([f, v]) => related.has(f) && typeof v === 'string' && v !== '')
        .map(([f, v]) => keyOf(f, v as string)),
    ),
  ].sort()
  const wantedKey = wanted.join('\n')
  const fieldsRef = useRef(related)
  fieldsRef.current = related

  useEffect(() => {
    if (!ops || wantedKey === '') return
    const missing = new Map<string, string[]>()
    for (const k of wantedKey.split('\n')) {
      if (cache.current.has(k)) continue
      const [field, id] = k.split('\u0000')
      missing.set(field, [...(missing.get(field) ?? []), id])
    }
    if (missing.size === 0) return
    const loads = [...missing].map(async ([field, ids]) => {
      const rel = fieldsRef.current.get(field)?.relation
      if (!rel) return
      const labelField = rel.labelField ?? 'name'
      for (let i = 0; i < ids.length; i += LABEL_CHUNK) {
        const chunk = ids.slice(i, i + LABEL_CHUNK)
        const found = await ops
          .list(rel.entity, { in: { id: chunk }, pageSize: chunk.length })
          .catch(() => [])
        const byId = new Map(found.map((r) => [r.id, r[labelField]]))
        for (const id of chunk) {
          const label = byId.get(id)
          cache.current.set(keyOf(field, id), label == null || label === '' ? null : String(label))
        }
      }
    })
    void Promise.all(loads).then(() => setVersion((v) => v + 1))
  }, [ops, wantedKey])

  return (field: string, value: unknown) => {
    if (value == null) return ''
    if (!related.has(field) || typeof value !== 'string' || !ops) return String(value)
    const label = cache.current.get(keyOf(field, value))
    if (label === undefined) return ''
    return label ?? value
  }
}
