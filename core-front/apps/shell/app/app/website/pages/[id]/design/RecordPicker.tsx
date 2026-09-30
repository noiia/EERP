'use client'
import { useEffect, useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import TextField from '@mui/material/TextField'
import { useT } from '@eerp/core-front'
import { listEditorRecords } from '@/website/editor-actions'

type Option = { id: string; label: string }

/** Searchable record picker over `table` (labels from `labelField`). `multiple`
 * keeps the picked order — the carousel shows them in that order. */
export function RecordPicker({ table, labelField, value, onChange, multiple, label }: {
  table: string
  labelField: string
  value: string[]
  onChange: (ids: string[]) => void
  multiple?: boolean
  label: string
}) {
  const t = useT()
  const [options, setOptions] = useState<Option[]>([])
  const [known, setKnown] = useState<Record<string, string>>({}) // id → label of picked rows
  const [search, setSearch] = useState('')

  useEffect(() => {
    let live = true
    void listEditorRecords(table, labelField, { search }).then((o) => live && setOptions(o))
    return () => { live = false }
  }, [table, labelField, search])
  const missing = value.filter((id) => !(id in known)).join(',')
  useEffect(() => {
    if (!missing) return
    void listEditorRecords(table, labelField, { ids: missing.split(',') })
      .then((o) => setKnown((k) => ({ ...k, ...Object.fromEntries(o.map((x) => [x.id, x.label])) })))
  }, [table, labelField, missing])

  const toOption = (id: string): Option => ({ id, label: known[id] ?? id.slice(0, 8) })
  const remember = (picked: Option[]) => setKnown((k) => ({ ...k, ...Object.fromEntries(picked.map((o) => [o.id, o.label])) }))
  const common = {
    size: 'small' as const,
    options,
    filterOptions: (o: Option[]) => o, // the server already searched
    isOptionEqualToValue: (a: Option, b: Option) => a.id === b.id,
    onInputChange: (_: unknown, v: string, reason: string) => { if (reason === 'input') setSearch(v) },
    renderInput: (p: object) => <TextField {...p} label={t(label)} />,
    noOptionsText: t('No records'),
  }
  return multiple ? (
    <Autocomplete {...common} multiple value={value.map(toOption)}
      onChange={(_, v) => { remember(v); onChange(v.map((o) => o.id)) }} />
  ) : (
    <Autocomplete {...common} value={value[0] ? toOption(value[0]) : null}
      onChange={(_, v) => { if (v) remember([v]); onChange(v ? [v.id] : []) }} />
  )
}
