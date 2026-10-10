'use client'
import { useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Button from '@mui/material/Button'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { useT } from '../i18n/translate'
import { useOSMSuggestions } from './address-widget'
import { useRelationOps } from './relation-ops'

const keepKeys = (e: { stopPropagation: () => void }) => e.stopPropagation()

/** A filter center ("lon,lat") picked from an address or the browser's
 * position, plus an optional radius in km (stored as meters: "lon,lat,m").
 * `radius={false}` hides the radius (point-in-zone "covers" filters). */
export function GeoCenterInput({
  value,
  onChange,
  radius = true,
}: {
  value: string
  onChange: (v: string) => void
  radius?: boolean
}) {
  const t = useT()
  const { options, search } = useOSMSuggestions()
  const [lon, lat, m] = value.split(',')
  const center = lon && lat ? `${lon},${lat}` : ''
  const set = (c: string, meters: string) =>
    onChange(c ? (radius && meters ? `${c},${meters}` : c) : '')
  const myLocation = () =>
    navigator.geolocation?.getCurrentPosition((pos) =>
      set(`${pos.coords.longitude},${pos.coords.latitude}`, m ?? ''),
    )
  return (
    <Stack spacing={1} onKeyDown={keepKeys}>
      <Autocomplete
        size="small"
        options={options}
        filterOptions={(o) => o}
        getOptionLabel={(o) => (typeof o === 'string' ? o : (o as { label: string }).label)}
        onInputChange={(_, q, reason) => {
          if (reason === 'input') search(q)
        }}
        onChange={(_, o) => {
          if (o && typeof o !== 'string' && o.lon != null && o.lat != null)
            set(`${o.lon},${o.lat}`, m ?? '')
        }}
        renderInput={(params) => <TextField {...params} label={t('Near an address')} />}
      />
      <Button size="small" onClick={myLocation}>
        {t('Use my location')}
      </Button>
      {radius && (
        <TextField
          size="small"
          type="number"
          label={t('Within (km, optional)')}
          value={m ? String(Number(m) / 1000) : ''}
          onChange={(e) =>
            set(
              center,
              e.target.value === '' ? '' : String(Math.round(Number(e.target.value) * 1000)),
            )
          }
        />
      )}
    </Stack>
  )
}

/** A zone record ("table:id:column") among the zone entities a point field declares. */
export function ZoneRecordInput({
  zones,
  value: _value,
  onChange,
}: {
  zones: { entity: string; field: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  const t = useT()
  const ops = useRelationOps()
  const [entity, setEntity] = useState(zones[0]?.entity ?? '')
  const zone = zones.find((z) => z.entity === entity)
  const [records, setRecords] = useState<{ id: string; name?: string }[]>([])
  const find = (q: string) =>
    !entity
      ? undefined
      : ops
          ?.list(entity, { search: { name: q }, pageSize: 20 })
          .then((rows) => setRecords(rows as unknown as { id: string; name?: string }[]))
          .catch(() => setRecords([]))
  return (
    <Stack spacing={1} onKeyDown={keepKeys}>
      {zones.length > 1 && (
        <TextField
          select
          size="small"
          label={t('Zone of')}
          value={entity}
          onChange={(e) => {
            setEntity(e.target.value)
            setRecords([])
          }}
        >
          {zones.map((z) => (
            <MenuItem key={z.entity} value={z.entity}>
              {t(z.label)}
            </MenuItem>
          ))}
        </TextField>
      )}
      <Autocomplete
        size="small"
        options={records}
        getOptionLabel={(r) => r.name ?? r.id}
        onInputChange={(_, q) => void find(q)}
        onChange={(_, r) => {
          if (r && zone) onChange(`${zone.entity}:${r.id}:${zone.field}`)
        }}
        renderInput={(params) => <TextField {...params} label={t(zone?.label ?? 'Zone')} />}
      />
    </Stack>
  )
}
