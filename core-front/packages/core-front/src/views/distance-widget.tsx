'use client'
import { useEffect, useState } from 'react'
import Typography from '@mui/material/Typography'
import { useI18nStore } from '../i18n/i18n-store'
import { formatDistance } from './distance-format'
import { useUnitStore } from './unit-store'
import type { WidgetProps } from './widgets'

interface Side {
  entity: string
  /** Draft field holding the record id; omitted = this record. */
  id?: string
  field: string
}

function ref(
  side: unknown,
  draft: Record<string, unknown> | undefined,
  recordId: string | null | undefined,
): string | null {
  const s = side as Side | undefined
  if (!s?.entity || !s.field) return null
  const id = s.id ? draft?.[s.id] : recordId
  return typeof id === 'string' && id !== '' ? `${s.entity}:${id}:${s.field}` : null
}

/** distance/meters — the database's distance between two geo values (ADR-029). */
export function DistanceWidget({ field, draft, recordId }: WidgetProps) {
  const system = useUnitStore((s) => s.system)
  const locale = useI18nStore((s) => s.locale)
  const from = ref(
    field.widgetOptions?.from,
    draft as Record<string, unknown> | undefined,
    recordId,
  )
  const to = ref(field.widgetOptions?.to, draft as Record<string, unknown> | undefined, recordId)
  const [meters, setMeters] = useState<number | null>(null)

  useEffect(() => {
    setMeters(null)
    if (!from || !to) return
    let cancelled = false
    fetch(`/api/geo/distance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((res) =>
        res.ok ? (res.json() as Promise<{ meters: number | null }>) : { meters: null },
      )
      .then((body) => !cancelled && setMeters(body.meters ?? null))
      .catch(() => !cancelled && setMeters(null))
    return () => {
      cancelled = true
    }
  }, [from, to])

  return <Typography>{formatDistance(meters, system, locale)}</Typography>
}
