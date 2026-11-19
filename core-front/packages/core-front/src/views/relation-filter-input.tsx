'use client'
import { useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import TextField from '@mui/material/TextField'
import { useT } from '../i18n/translate'
import type { FieldDescriptor } from './descriptor'
import { useRelationOps } from './relation-ops'

type Option = { id: string; label: string }

const keepKeys = (e: { stopPropagation: () => void }) => e.stopPropagation()

/** The value of a relation filter, picked among the related records (searched
 * on the relation's label field) instead of typed as an id. `multiple` (the
 * `in` operator) keeps several, as the comma-joined ids the bar already splits. */
export function RelationFilterInput({
  field,
  multiple = false,
  onChange,
}: {
  field: FieldDescriptor
  multiple?: boolean
  onChange: (value: string) => void
}) {
  const t = useT()
  const ops = useRelationOps()
  const [options, setOptions] = useState<Option[]>([])
  const rel = field.relation
  const labelField = rel?.labelField ?? 'name'

  const find = (q: string) => {
    if (!ops || !rel) return
    ops
      .list(rel.entity, { ...(q ? { search: { [labelField]: q } } : {}), ...(rel.filter ? { filter: rel.filter } : {}), pageSize: 20 })
      .then((rows) =>
        setOptions(
          (rows as unknown as Record<string, unknown>[]).map((r) => ({ id: String(r.id), label: String(r[labelField] ?? r.id) })),
        ),
      )
      .catch(() => setOptions([]))
  }

  const common = {
    size: 'small' as const,
    options,
    sx: { minWidth: 160, flex: 1 },
    filterOptions: (o: Option[]) => o, // the server already searched
    getOptionLabel: (o: Option) => o.label,
    isOptionEqualToValue: (a: Option, b: Option) => a.id === b.id,
    onOpen: () => find(''),
    onInputChange: (_: unknown, q: string, reason: string) => {
      if (reason === 'input') find(q)
    },
    noOptionsText: t('No results'),
    onKeyDown: keepKeys,
    renderInput: (params: object) => <TextField {...params} placeholder={t('Value')} />,
  }
  return multiple ? (
    <Autocomplete multiple {...common} onChange={(_, v) => onChange(v.map((o) => o.id).join(','))} />
  ) : (
    <Autocomplete {...common} onChange={(_, v) => onChange(v?.id ?? '')} />
  )
}
