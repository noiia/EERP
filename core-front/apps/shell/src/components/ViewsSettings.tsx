'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Container from '@mui/material/Container'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import { fieldLabel, useT, type FieldDescriptor, type ViewFieldsConfig } from '@eerp/core-front'
import { setEntityViewFields } from '@/lib/view-fields'

// Settings → Views: which field powers each entity's Kanban status column and
// Calendar date positioning (docs/roadmaps/list-view-modes.md, ADR-006). The
// durable value is server state (app_settings key views.<entity>.fields, PUT
// /settings/views/:entity/fields, permission settings:views:write — Go
// re-authorizes every write); this component holds only the optimistic
// client-side mirror the page seeded it with.

export interface ViewEntityRow {
  entity: string
  kanbanFields: FieldDescriptor[]
  dateFields: FieldDescriptor[]
  config: ViewFieldsConfig
}

/** Sentinel for "no field chosen" — a Select can't use '' AND a real empty
 * meaning both (mirrors FormatSettings' NONE_VALUE pattern). */
const NONE_VALUE = '__none__'

export default function ViewsSettings({
  rows: initialRows,
  canEdit,
}: {
  rows: ViewEntityRow[]
  canEdit: boolean
}) {
  const t = useT()
  const [rows, setRows] = useState(initialRows)
  const [error, setError] = useState<string | null>(null)

  async function onChange(entity: string, patch: Partial<ViewFieldsConfig>) {
    const row = rows.find((r) => r.entity === entity)
    if (!row) return
    const nextConfig = { ...row.config, ...patch }
    const previous = rows
    setError(null)
    setRows((rs) => rs.map((r) => (r.entity === entity ? { ...r, config: nextConfig } : r)))
    const result = await setEntityViewFields(entity, nextConfig)
    if (!result.ok) {
      setRows(previous)
      setError(result.message)
    }
  }

  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Stack spacing={1}>
          <Typography variant="h4" component="h1">
            {t('Views')}
          </Typography>
          <Typography color="text.secondary">
            {t("Which field powers each list's Kanban and Calendar display modes.")}
          </Typography>
        </Stack>

        {rows.length === 0 ? (
          <Typography color="text.secondary">{t('No list views are registered yet.')}</Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('Entity')}</TableCell>
                <TableCell>{t('Kanban status field')}</TableCell>
                <TableCell>{t('Calendar date field')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.entity}>
                  <TableCell>{row.entity}</TableCell>
                  <TableCell>
                    <FormControl
                      size="small"
                      sx={{ minWidth: 180 }}
                      disabled={!canEdit || row.kanbanFields.length === 0}
                    >
                      <InputLabel id={`kanban-${row.entity}`}>{t('Status field')}</InputLabel>
                      <Select
                        labelId={`kanban-${row.entity}`}
                        label={t('Status field')}
                        value={row.config.kanbanStatusField ?? NONE_VALUE}
                        onChange={(e) =>
                          void onChange(row.entity, {
                            kanbanStatusField: e.target.value === NONE_VALUE ? null : e.target.value,
                          })
                        }
                      >
                        <MenuItem value={NONE_VALUE}>{t('None')}</MenuItem>
                        {row.kanbanFields.map((f) => (
                          <MenuItem key={f.name} value={f.name}>
                            {t(fieldLabel(f))}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </TableCell>
                  <TableCell>
                    <FormControl
                      size="small"
                      sx={{ minWidth: 180 }}
                      disabled={!canEdit || row.dateFields.length === 0}
                    >
                      <InputLabel id={`calendar-${row.entity}`}>{t('Date field')}</InputLabel>
                      <Select
                        labelId={`calendar-${row.entity}`}
                        label={t('Date field')}
                        value={row.config.calendarDateField ?? NONE_VALUE}
                        onChange={(e) =>
                          void onChange(row.entity, {
                            calendarDateField: e.target.value === NONE_VALUE ? null : e.target.value,
                          })
                        }
                      >
                        <MenuItem value={NONE_VALUE}>{t('None')}</MenuItem>
                        {row.dateFields.map((f) => (
                          <MenuItem key={f.name} value={f.name}>
                            {t(fieldLabel(f))}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {!canEdit && (
          <Typography variant="body2" color="text.secondary">
            {t('Changing view field configuration requires the settings:views:write permission.')}
          </Typography>
        )}
        {error && <Alert severity="error">{error}</Alert>}
      </Stack>
    </Container>
  )
}
