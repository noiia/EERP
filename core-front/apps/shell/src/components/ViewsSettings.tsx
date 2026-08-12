'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import {
  byPrefixAndName,
  effectiveViewFields,
  fieldLabel,
  FontAwesomeIcon,
  useT,
  type FieldDescriptor,
  type ViewFieldsConfig,
  type ViewModeDefaults,
} from '@eerp/core-front'
import { setEntityViewFields } from '@/lib/view-fields'

// Settings → Views: which field powers each entity's Kanban status column and
// Calendar date positioning, and whether Graph mode is on
// (docs/roadmaps/list-view-modes.md, ADR-006 and its module-defaults
// amendment). The durable value is server state (app_settings key
// views.<entity>.fields, PUT /settings/views/:entity/fields, permission
// settings:views:write — Go re-authorizes every write): this component holds
// only the optimistic client-side mirror the page seeded it with, PLUS each
// entity's own `defaults` (a module's hardcoded baseline, sourced from its
// ViewDescriptor — never written here, only read and offered as "revert to").

export interface ViewEntityRow {
  entity: string
  kanbanFields: FieldDescriptor[]
  dateFields: FieldDescriptor[]
  config: ViewFieldsConfig
  defaults: ViewModeDefaults
}

/** Sentinel for "no field chosen" — a Select can't use '' AND a real empty
 * meaning both (mirrors FormatSettings' NONE_VALUE pattern). */
const NONE_VALUE = '__none__'

/** True once ANY field/flag the module hardcoded a default for is actively
 * overridden — the only state a "revert to module settings" action makes
 * sense in. */
function hasOverride(row: ViewEntityRow): boolean {
  const { defaults, config } = row
  return (
    (defaults.kanbanStatusField !== undefined && config.kanbanStatusField != null) ||
    (defaults.calendarDateField !== undefined && config.calendarDateField != null) ||
    (defaults.enableGraphs !== undefined && config.enableGraphs != null)
  )
}

function hasAnyDefault(defaults: ViewModeDefaults): boolean {
  return (
    defaults.kanbanStatusField !== undefined ||
    defaults.calendarDateField !== undefined ||
    defaults.enableGraphs !== undefined
  )
}

/** The pending edit awaiting confirmation — set only when the field/flag being
 * changed has a module-declared default, so changing it is a genuine override
 * rather than just filling in a previously-unset choice. */
interface PendingOverride {
  entity: string
  patch: Partial<ViewFieldsConfig>
  label: string
  moduleValue: string
}

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
  const [pending, setPending] = useState<PendingOverride | null>(null)

  async function apply(entity: string, patch: Partial<ViewFieldsConfig>) {
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

  /** Routes a UI-initiated change through the override warning when the
   * touched field/flag has a module default; applies immediately otherwise
   * (the pre-existing, no-module-opinion behavior). */
  function requestChange(
    row: ViewEntityRow,
    patch: Partial<ViewFieldsConfig>,
    label: string,
    moduleValue: string | undefined,
  ) {
    if (moduleValue !== undefined) {
      setPending({ entity: row.entity, patch, label, moduleValue })
    } else {
      void apply(row.entity, patch)
    }
  }

  function revert(row: ViewEntityRow) {
    const patch: Partial<ViewFieldsConfig> = {}
    if (row.defaults.kanbanStatusField !== undefined) patch.kanbanStatusField = null
    if (row.defaults.calendarDateField !== undefined) patch.calendarDateField = null
    if (row.defaults.enableGraphs !== undefined) patch.enableGraphs = null
    void apply(row.entity, patch)
  }

  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Stack spacing={1}>
          <Typography variant="h4" component="h1">
            {t('Views')}
          </Typography>
          <Typography color="text.secondary">
            {t("Which field powers each list's Kanban and Calendar display modes, and whether Graph mode is on.")}
          </Typography>
        </Stack>

        {rows.length === 0 ? (
          <Typography color="text.secondary">{t('No list views are registered yet.')}</Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell />
                <TableCell>{t('Entity')}</TableCell>
                <TableCell>{t('Kanban status field')}</TableCell>
                <TableCell>{t('Calendar date field')}</TableCell>
                <TableCell>{t('Graphs')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => {
                const effective = effectiveViewFields(row.defaults, row.config)
                return (
                  <TableRow key={row.entity}>
                    <TableCell sx={{ width: 40 }}>
                      {hasAnyDefault(row.defaults) && hasOverride(row) ? (
                        <Tooltip title={t('Revert to module settings')}>
                          <span>
                            <IconButton
                              size="small"
                              aria-label={t('Revert to module settings')}
                              disabled={!canEdit}
                              onClick={() => revert(row)}
                            >
                              <FontAwesomeIcon icon={byPrefixAndName.fas['arrow-rotate-left']} size="sm" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      ) : null}
                    </TableCell>
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
                          value={effective.kanbanStatusField ?? NONE_VALUE}
                          onChange={(e) => {
                            const value = e.target.value === NONE_VALUE ? null : e.target.value
                            requestChange(
                              row,
                              { kanbanStatusField: value },
                              t('Kanban status field'),
                              row.defaults.kanbanStatusField,
                            )
                          }}
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
                          value={effective.calendarDateField ?? NONE_VALUE}
                          onChange={(e) => {
                            const value = e.target.value === NONE_VALUE ? null : e.target.value
                            requestChange(
                              row,
                              { calendarDateField: value },
                              t('Calendar date field'),
                              row.defaults.calendarDateField,
                            )
                          }}
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
                    <TableCell>
                      <FormControlLabel
                        control={
                          <Switch
                            size="small"
                            checked={effective.enableGraphs}
                            disabled={!canEdit}
                            onChange={(e) =>
                              requestChange(
                                row,
                                { enableGraphs: e.target.checked },
                                t('Enable Graphs'),
                                row.defaults.enableGraphs === undefined
                                  ? undefined
                                  : String(row.defaults.enableGraphs),
                              )
                            }
                          />
                        }
                        label={t('Enable Graphs')}
                      />
                    </TableCell>
                  </TableRow>
                )
              })}
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

      <Dialog open={pending != null} onClose={() => setPending(null)}>
        <DialogTitle>{t('Override the module default?')}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Typography variant="body2">
              {t('The module sets')} <strong>{pending?.label}</strong> {t('to')}{' '}
              <strong>{pending?.moduleValue}</strong> {t('by default.')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t(
                'Overriding it here only changes this workspace — the module keeps its own default, and you can revert to it at any time.',
              )}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPending(null)}>{t('Cancel')}</Button>
          <Button
            variant="contained"
            onClick={() => {
              if (pending) void apply(pending.entity, pending.patch)
              setPending(null)
            }}
          >
            {t('Override anyway')}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  )
}
