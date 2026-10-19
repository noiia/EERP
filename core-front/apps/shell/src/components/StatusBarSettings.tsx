'use client'
import { useState } from 'react'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormGroup from '@mui/material/FormGroup'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { type StatusBarConfig, useT, ViewBanner } from '@eerp/core-front'
import { setEntityStatusBarConfig } from '@/lib/status-bar-config'

// Settings -> Apps -> :module: each of this app's forms that shows a status
// breadcrumb (ViewDescriptor.statusBar) — which selection field it follows
// and which of that field's values it lists as steps. The module's own field
// and every one of its values are the default; saving that default stores
// "no override" (null parts), so a value the module adds later shows up on
// its own. Durable state is app_settings views.<entity>.status_bar (PUT
// /settings/views/:entity/status_bar, settings:views:write).

export interface StatusBarField {
  name: string
  label: string
  options: string[]
}

export interface StatusBarEntityRow {
  entity: string
  /** ViewDescriptor.statusBar.field — the module's own default. */
  moduleField: string
  /** Every selection field of the form, the choices for the breadcrumb. */
  fields: StatusBarField[]
  config: StatusBarConfig
}

function effective(row: StatusBarEntityRow): { field: string; steps: string[] } {
  const field =
    row.fields.find((f) => f.name === row.config.field) ?? row.fields.find((f) => f.name === row.moduleField)
  const options = field?.options ?? []
  const applies = row.config.field == null || row.config.field === field?.name
  const steps = applies && row.config.steps ? row.config.steps.filter((s) => options.includes(s)) : []
  return { field: field?.name ?? row.moduleField, steps: steps.length > 0 ? steps : options }
}

function StatusBarRow({ row, canEdit }: { row: StatusBarEntityRow; canEdit: boolean }) {
  const t = useT()
  const initial = effective(row)
  const [saved, setSaved] = useState(row.config)
  const [field, setField] = useState(initial.field)
  const [steps, setSteps] = useState<string[]>(initial.steps)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const options = row.fields.find((f) => f.name === field)?.options ?? []

  function pickField(name: string) {
    setField(name)
    setSteps(row.fields.find((f) => f.name === name)?.options ?? [])
  }

  function toggleStep(option: string, on: boolean) {
    // Steps keep the field's own option order.
    setSteps((current) => options.filter((o) => (o === option ? on : current.includes(o))))
  }

  async function save(config: StatusBarConfig) {
    setMsg(null)
    const res = await setEntityStatusBarConfig(row.entity, config)
    if (res.ok) {
      setSaved(config)
      setMsg({ ok: true, text: t('Saved.') })
    } else {
      setMsg({ ok: false, text: res.message })
    }
  }

  function saveCurrent() {
    const allSteps = steps.length === options.length
    void save({ field: field === row.moduleField ? null : field, steps: allSteps ? null : steps })
  }

  function revert() {
    pickField(row.moduleField)
    void save({ field: null, steps: null })
  }

  const overridden = saved.field != null || saved.steps != null
  return (
    <Stack spacing={1.5} sx={{ maxWidth: 560 }}>
      <Typography variant="subtitle2">{row.entity}</Typography>
      <FormControl size="small" disabled={!canEdit}>
        <InputLabel id={`status-bar-field-${row.entity}`}>{t('Field')}</InputLabel>
        <Select
          labelId={`status-bar-field-${row.entity}`}
          label={t('Field')}
          value={field}
          onChange={(e) => pickField(String(e.target.value))}
        >
          {row.fields.map((f) => (
            <MenuItem key={f.name} value={f.name}>
              {t(f.label)}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <FormGroup aria-label={t('Steps')}>
        {options.map((option) => (
          <FormControlLabel
            key={option}
            control={
              <Checkbox
                size="small"
                checked={steps.includes(option)}
                disabled={!canEdit}
                onChange={(e) => toggleStep(option, e.target.checked)}
              />
            }
            label={t(option)}
          />
        ))}
      </FormGroup>
      {canEdit && (
        <Stack direction="row" spacing={1}>
          <Button variant="contained" size="small" disabled={steps.length === 0} onClick={saveCurrent}>
            {t('Save')}
          </Button>
          {overridden && (
            <Button size="small" onClick={revert}>
              {t('Revert to module settings')}
            </Button>
          )}
        </Stack>
      )}
      <ViewBanner status="warning" open={steps.length === 0}>
        {t('Pick at least one step.')}
      </ViewBanner>
      {msg && <ViewBanner status={msg.ok ? 'info' : 'error'}>{msg.text}</ViewBanner>}
    </Stack>
  )
}

export default function StatusBarSettings({ rows, canEdit }: { rows: StatusBarEntityRow[]; canEdit: boolean }) {
  const t = useT()
  if (rows.length === 0) return null
  return (
    <Stack spacing={2}>
      <Typography variant="subtitle1">{t('Status bar')}</Typography>
      <Typography variant="body2" color="text.secondary">
        {t('The steps shown at the top of the form, taken from one of its selection fields. By default: the field the app chose, with every one of its values.')}
      </Typography>
      {rows.map((row) => (
        <StatusBarRow key={row.entity} row={row} canEdit={canEdit} />
      ))}
      {!canEdit && (
        <Typography variant="body2" color="text.secondary">
          {t('Changing the status bar requires the settings:views:write permission.')}
        </Typography>
      )}
    </Stack>
  )
}
