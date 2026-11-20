'use client'
import { useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import Collapse from '@mui/material/Collapse'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useT } from '../../i18n/translate'
import { parseError, serializeError, toApiError, type SerializedError } from '../../api/errors'
import type { ExchangeFormat, GanttExchangeConfig } from '../../api/view-fields'
import { Banner, BannerScope, BannerSlot } from '../banner'
import { ErrorAlert } from '../error-alert'
import { useNumberFormat } from '../format-store'
import { usePhone } from '../use-phone'
import { initialSelection, isRemoval, selectAll, selectAllRemovals, toggle, type ExchangeChange } from './selection'

// The import wizard (ADR-042): choose a plan file, read what it would change, apply
// the ticks. Three steps, one dialog, full screen on phone.
//
// The calls go to the shell's BFF (`/api/exchange/<scopeEntity>/<id>/<format>/<action>`)
// with fetch rather than the ApiClient: this is a browser-side upload and download of
// a user's own file, and the response's status code IS the wizard's control flow
// (413 too large, 409 stale preview, 422 refused selection), so it must not be
// flattened into an ApiError before the steps can read it.
//
// Go is the authority on what is safe to apply: the review list is only a rendering
// of its preview, the ticks only choose which keys to post, and a selection it
// refuses comes back to step 2 with its `fields` highlighted rather than being
// second-guessed here.

/** One preview warning: about the file the partner sent, or what the import drops. */
interface ExchangeWarning {
  code: string
  message: string
  task?: string
}

interface PreviewAnswer {
  base: string
  changes: ExchangeChange[]
  warnings: ExchangeWarning[]
}

/** The words the kind chip shows. The key is the Change.Kind Go sends. */
const KIND_LABEL: Record<string, string> = {
  create: 'Create',
  update: 'Update',
  move: 'Move',
  delete: 'Delete',
  dependency: 'Depends on',
  dependency_delete: 'Remove dependency',
  assign: 'Assign',
  assign_delete: 'Unassign',
  milestone_create: 'Create milestone',
  milestone_update: 'Update milestone',
  milestone_delete: 'Delete milestone',
}

/** The field a row reports, in the words the review list shows. */
const FIELD_LABEL: Record<string, string> = {
  name: 'Name',
  dates: 'Dates',
  planned_hours: 'Planned h.',
  closed: 'Closed',
  milestone_id: 'Milestone',
  parent: 'Parent',
}

/** A whole day read as the file's own day, never shifted by the machine's zone. */
function dayText(value: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString()
}

/**
 * One side of a row as the manager reads it: a day, a number in the workspace's own
 * format, or a short summary of the shapes `exchange_diff.go` sends (dates, move,
 * create, dependency, assignment, milestone).
 */
function makeValueText(t: (s: string) => string, num: (n: number) => string) {
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  const obj = (v: unknown): Record<string, unknown> | null =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  return (value: unknown): string => {
    if (value == null) return ''
    if (typeof value === 'boolean') return value ? t('Yes') : t('No')
    if (typeof value === 'number') return num(value)
    if (typeof value === 'string') return value
    const o = obj(value)
    if (!o) return String(value)
    const start = str(o.start)
    const end = str(o.end)
    const pred = str(o.pred_name) ?? str(o.pred)
    const succ = str(o.succ_name) ?? str(o.succ)
    if (pred && succ) return `${pred} → ${succ}`
    // A new task reads as one line: its parent, its days, its hours. The parent is the
    // half a manager decides about a create (the wireframe's "Create under 2 · Design"),
    // and it is the same name the move rows show.
    if (str(o.name) && (start || end || typeof o.planned_hours === 'number')) {
      const bits = [str(o.name)!]
      const bornUnder = str(o.parent_name) ?? str(o.parent)
      if (bornUnder) bits.push(`${t('under')} ${bornUnder}`)
      if (start && end) bits.push(`${dayText(start)} → ${dayText(end)}`)
      if (typeof o.planned_hours === 'number') bits.push(`${num(o.planned_hours)} ${t('h')}`)
      return bits.join(', ')
    }
    if (start && end) return `${dayText(start)} – ${dayText(end)}`
    if (start) return dayText(start)
    if (end) return dayText(end)
    if (str(o.email)) return str(o.name) ?? str(o.email)!
    // A move names its ends by their names (what the server sends beside the keys), never
    // by the task id: a UUID is not something a manager reads off a review list.
    const parts: string[] = []
    const under = str(o.parent_name) ?? str(o.parent)
    const behind = str(o.after_name) ?? str(o.after)
    if (under) parts.push(`${t('under')} ${under}`)
    if (behind) parts.push(`${t('after')} ${behind}`)
    if (parts.length) return parts.join(', ')
    if (str(o.name)) return str(o.name)!
    return ''
  }
}

export interface ImportWizardProps {
  open: boolean
  onClose: () => void
  /** After a successful apply: the renderer reads its records again (as after a drag). */
  onApplied: () => void
  config: GanttExchangeConfig
  scopeId: string
  format: ExchangeFormat
}

export function ImportWizard({ open, onClose, onApplied, config, scopeId, format }: ImportWizardProps) {
  const t = useT()
  const phone = usePhone()
  const { format: num } = useNumberFormat()
  const valueText = makeValueText(t, num)
  // A counted noun in the two forms the catalog holds (the PERT chip's idiom).
  const count = (one: string, many: string, n: number) => (n === 1 ? t(one) : t(many).replace('{n}', String(n)))
  const url = (action: string) =>
    `/api/exchange/${config.scopeEntity}/${encodeURIComponent(scopeId)}/${encodeURIComponent(format.key)}/${action}`

  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [base, setBase] = useState('')
  const [changes, setChanges] = useState<ExchangeChange[]>([])
  const [warnings, setWarnings] = useState<ExchangeWarning[]>([])
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const [warningsOpen, setWarningsOpen] = useState(false)
  const [error, setError] = useState<SerializedError | null>(null)
  const [tooLarge, setTooLarge] = useState(false)
  const [refused, setRefused] = useState<SerializedError | null>(null)
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(() => new Set())
  const [stale, setStale] = useState(false)
  const [applied, setApplied] = useState<number | null>(null)
  // The same file is posted twice (preview, then apply) and again after a 409: held in
  // state, not re-read from the input, which a re-render would have cleared.
  const inputRef = useRef<HTMLInputElement>(null)

  async function runPreview(pick: File) {
    setBusy(true)
    setError(null)
    setTooLarge(false)
    setRefused(null)
    setHighlight(new Set())
    setStale(false)
    try {
      const form = new FormData()
      form.append('file', pick)
      const res = await fetch(url('preview'), { method: 'POST', body: form })
      if (res.status === 413) {
        setTooLarge(true)
        return
      }
      if (!res.ok) throw await parseError(res)
      const answer = (await res.json()) as PreviewAnswer
      setFile(pick)
      setBase(answer.base)
      setChanges(answer.changes ?? [])
      setWarnings(answer.warnings ?? [])
      setSel(initialSelection(answer.changes ?? []))
      setWarningsOpen(false)
      setStep(2)
    } catch (e) {
      setError(serializeError(toApiError(e)))
    } finally {
      setBusy(false)
    }
  }

  async function runApply() {
    if (!file) return
    setBusy(true)
    setError(null)
    setRefused(null)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('base', base)
      // Exactly the ticked rows, in the preview's own order: only keys Go sent.
      for (const c of changes) if (sel.has(c.key)) form.append('keys', c.key)
      const res = await fetch(url('apply'), { method: 'POST', body: form })
      if (res.status === 409) {
        setStale(true)
        setStep(3)
        return
      }
      if (res.status === 422) {
        const e = await parseError(res)
        setRefused(serializeError(e))
        setHighlight(new Set(e.fields ?? []))
        setStep(2)
        return
      }
      if (!res.ok) throw await parseError(res)
      const body = (await res.json()) as { applied: number }
      setApplied(body.applied ?? 0)
      setStep(3)
      onApplied()
    } catch (e) {
      setError(serializeError(toApiError(e)))
    } finally {
      setBusy(false)
    }
  }

  function close() {
    onClose()
    setStep(1)
    setFile(null)
    setApplied(null)
    setError(null)
    setTooLarge(false)
    setRefused(null)
    setStale(false)
    setHighlight(new Set())
    setSel(new Set())
  }

  /** One group of the review list: every row about one task, in the preview's order.
   * The key carries the wbs too: two distinct tasks can share a name. */
  const groups: { key: string; task: string; wbs: string; fresh: boolean; rows: ExchangeChange[] }[] = []
  const byGroup = new Map<string, number>()
  changes.forEach((c) => {
    const groupKey = `${c.task}\u0000${c.wbs ?? ''}`
    const at = byGroup.get(groupKey)
    if (at == null) {
      byGroup.set(groupKey, groups.length)
      groups.push({ key: groupKey, task: c.task, wbs: c.wbs ?? '', fresh: false, rows: [] })
    }
    const g = groups[byGroup.get(groupKey)!]
    g.rows.push(c)
    if (c.kind === 'create') g.fresh = true
  })

  const selectedCount = changes.reduce((n, c) => (sel.has(c.key) ? n + 1 : n), 0)
  const additiveAll = changes.some((c) => !isRemoval(c)) && changes.every((c) => isRemoval(c) || sel.has(c.key))
  const removalsAll = changes.some(isRemoval) && changes.every((c) => !isRemoval(c) || sel.has(c.key))

  return (
    <Dialog
      open={open}
      onClose={close}
      fullWidth
      maxWidth="md"
      fullScreen={phone}
      aria-labelledby="exchange-import-title"
    >
      <BannerScope>
        <DialogTitle id="exchange-import-title">
          {t('Import')} {t(format.label)}
        </DialogTitle>
        <DialogContent dividers>
          <BannerSlot />
          <ErrorAlert error={error} />
          {step === 1 ? (
            <Stack spacing={1.5}>
              <Typography variant="body2">{t('Choose a plan file to compare with this project.')}</Typography>
              <Box>
                <input
                  ref={inputRef}
                  type="file"
                  accept={format.accept}
                  aria-label={t('Plan file')}
                  disabled={busy}
                  onChange={(e) => {
                    const pick = e.target.files?.[0]
                    if (pick) void runPreview(pick)
                  }}
                />
              </Box>
              {tooLarge ? (
                <Banner status="warning" title={t('The file is too large.')} />
              ) : null}
            </Stack>
          ) : null}

          {step === 2 ? (
            <Stack spacing={1.5}>
              {refused ? (
                <Banner status="error" title={refused.message}>
                  <Typography variant="body2">{refused.code}</Typography>
                  {refused.requestId ? (
                    <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>
                      {t('Reference for your administrator')}: {refused.requestId}
                    </Typography>
                  ) : null}
                </Banner>
              ) : null}
              {warnings.length ? (
                <Box>
                  <Button
                    size="small"
                    aria-expanded={warningsOpen}
                    onClick={() => setWarningsOpen((o) => !o)}
                  >
                    {count('1 warning', '{n} warnings', warnings.length)}
                  </Button>
                  <Collapse in={warningsOpen} unmountOnExit>
                    <Banner status="warning">
                      {warnings.map((w) => (
                        <Box key={`${w.code}:${w.task ?? ''}:${w.message}`}>
                          {w.task ? `${w.task}: ` : ''}
                          {w.message}
                        </Box>
                      ))}
                    </Banner>
                  </Collapse>
                </Box>
              ) : null}
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                <Checkbox
                  size="small"
                  checked={additiveAll}
                  slotProps={{ input: { 'aria-label': t('Select all') } }}
                  onChange={(_e, on) => setSel(selectAll(changes, sel, on))}
                />
                <Checkbox
                  size="small"
                  checked={removalsAll}
                  slotProps={{ input: { 'aria-label': t('Select all removals') } }}
                  onChange={(_e, on) => setSel(selectAllRemovals(changes, sel, on))}
                />
                <Typography variant="body2" sx={{ ml: 'auto' }}>
                  {t('{n} of {m} selected')
                    .replace('{n}', String(selectedCount))
                    .replace('{m}', String(changes.length))}
                </Typography>
              </Stack>
              {changes.length === 0 ? (
                <Typography variant="body1">{t('No changes')}</Typography>
              ) : (
                groups.map((g) => (
                  <Box key={g.key} data-testid={`exchange-group-${g.task}`}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      {[g.wbs, g.task, g.fresh ? `(${t('new')})` : null].filter(Boolean).join(' ')}
                    </Typography>
                    {g.rows.map((c) => (
                        <Stack
                          key={c.key}
                          direction="row"
                          spacing={1}
                          data-testid={`exchange-row-${c.key}`}
                          data-highlighted={highlight.has(c.key) ? 'true' : undefined}
                          sx={(th) => ({
                            alignItems: 'center',
                            ...(highlight.has(c.key)
                              ? { bgcolor: th.palette.action.selected, borderRadius: 1 }
                              : null),
                          })}
                        >
                          <Checkbox
                            size="small"
                            checked={sel.has(c.key)}
                            slotProps={{
                              input: {
                                // Every row would otherwise announce the same "Select change": name what is being ticked.
                                'aria-label': `${t('Select change')}, ${g.task}, ${
                                  c.field ? t(FIELD_LABEL[c.field] ?? c.field) : t(KIND_LABEL[c.kind] ?? c.kind)
                                }`,
                              },
                            }}
                            onChange={(e) => setSel(toggle(changes, sel, c.key, e.target.checked))}
                          />
                          <Chip size="small" label={t(KIND_LABEL[c.kind] ?? c.kind)} />
                          {c.field ? (
                            <Typography variant="body2" sx={{ minWidth: 88 }}>
                              {t(FIELD_LABEL[c.field] ?? c.field)}
                            </Typography>
                          ) : null}
                          {c.before != null ? (
                            <Typography variant="body2">{valueText(c.before)}</Typography>
                          ) : null}
                          {c.before != null && c.after != null ? <Typography variant="body2">→</Typography> : null}
                          {c.after != null ? <Typography variant="body2">{valueText(c.after)}</Typography> : null}
                          {c.was_unscheduled ? (
                            <Typography variant="caption" color="text.secondary">
                              {t('(was unscheduled)')}
                            </Typography>
                          ) : null}
                          {isRemoval(c) && c.dependents ? (
                            <Typography variant="caption" color="text.secondary">
                              {t('has')}{' '}
                              {[
                                c.dependents.timesheets
                                  ? count('1 timesheet', '{n} timesheets', c.dependents.timesheets)
                                  : null,
                                c.dependents.risk_links
                                  ? count('1 risk link', '{n} risk links', c.dependents.risk_links)
                                  : null,
                                c.dependents.subtasks
                                  ? count('1 subtask', '{n} subtasks', c.dependents.subtasks)
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(', ')}
                            </Typography>
                          ) : null}
                        </Stack>
                      ))}
                  </Box>
                ))
              )}
            </Stack>
          ) : null}

          {step === 3 ? (
            <Stack spacing={1}>
              {stale ? (
                <Banner status="warning" title={t('The project changed since the preview')} />
              ) : (
                <Typography variant="body1">
                  {count('1 change applied', '{n} changes applied', applied ?? 0)}
                </Typography>
              )}
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          {step === 1 ? (
            <Button onClick={close}>{t('Cancel')}</Button>
          ) : step === 2 ? (
            <>
              <Button
                onClick={() => {
                  setStep(1)
                  setRefused(null)
                  setHighlight(new Set())
                  if (inputRef.current) inputRef.current.value = ''
                }}
              >
                {t('Back')}
              </Button>
              <Button variant="contained" disabled={busy || selectedCount === 0} onClick={() => void runApply()}>
                {count('Apply 1 change', 'Apply {n} changes', selectedCount)}
              </Button>
            </>
          ) : (
            <>
              {stale ? (
                <Button
                  onClick={() => {
                    if (file) void runPreview(file)
                  }}
                >
                  {t('Preview again')}
                </Button>
              ) : null}
              <Button variant="contained" onClick={close}>
                {t('Done')}
              </Button>
            </>
          )}
        </DialogActions>
      </BannerScope>
    </Dialog>
  )
}
