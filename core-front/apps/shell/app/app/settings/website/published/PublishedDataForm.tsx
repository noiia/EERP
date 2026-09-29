'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'
import { savePublished, type PublishedTable } from '@/lib/website-settings'

// One card per table the website module declares: which columns the public
// site may read, and optional "only rows where column = value" filters.
function TableCard({ table }: { table: PublishedTable }) {
  const t = useT()
  const [fields, setFields] = useState(new Set(table.fields))
  const [rows, setRows] = useState(Object.entries(table.filter ?? {}))
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const toggle = (f: string) =>
    setFields((prev) => {
      const next = new Set(prev)
      if (!next.delete(f)) next.add(f)
      return next
    })
  const setRow = (i: number, k: 0 | 1, v: string) =>
    setRows((prev) => prev.map((r, j) => (j === i ? (k === 0 ? [v, r[1]] : [r[0], v]) : r)))

  async function save() {
    const filter = Object.fromEntries(rows.filter(([c]) => c.trim() !== ''))
    const res = await savePublished(table.table, { fields: [...fields], filter })
    setMsg(res.ok ? { ok: true, text: t('Saved.') } : { ok: false, text: res.message })
  }

  return (
    <Card variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1}>
        <Typography variant="h6">{table.table}</Typography>
        <Stack direction="row" sx={{ flexWrap: 'wrap' }}>
          {table.declared.map((f) => (
            <FormControlLabel
              key={f}
              label={f}
              control={<Checkbox checked={fields.has(f)} onChange={() => toggle(f)} />}
            />
          ))}
        </Stack>
        <Typography variant="subtitle2">{t('Only rows where')}</Typography>
        {rows.map(([c, v], i) => (
          <Stack key={i} direction="row" spacing={1}>
            <TextField size="small" label={t('Column')} value={c} onChange={(e) => setRow(i, 0, e.target.value)} />
            <TextField size="small" label={t('Value')} value={v} onChange={(e) => setRow(i, 1, e.target.value)} />
            <IconButton aria-label={t('Remove filter')} onClick={() => setRows((p) => p.filter((_, j) => j !== i))}>
              ×
            </IconButton>
          </Stack>
        ))}
        <Stack direction="row" spacing={1}>
          <Button onClick={() => setRows((p) => [...p, ['', '']])}>{t('Add filter')}</Button>
          <Button variant="contained" onClick={() => void save()}>
            {t('Save')}
          </Button>
        </Stack>
        {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
      </Stack>
    </Card>
  )
}

export default function PublishedDataForm({ tables }: { tables: PublishedTable[] }) {
  const t = useT()
  if (tables.length === 0) return <Typography color="text.secondary">{t('No table is declared for publication.')}</Typography>
  return (
    <Stack spacing={2}>
      {tables.map((tb) => (
        <TableCard key={tb.table} table={tb} />
      ))}
    </Stack>
  )
}
