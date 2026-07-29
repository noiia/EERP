'use client'
import { useState, useTransition } from 'react'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { ErrorAlert, toApiError, serializeError, usePermission, useT, type SerializedError } from '@eerp/core-front'
import { getModuleLogs, type ModuleLogEntry } from '@/lib/module-actions'

// The Logs wizard: every activate/deactivate/reload run's backend- and
// DB-level log lines, grouped by operation and sorted by elapsed time
// (docs/roadmaps/app-store.md). Host chrome beside Activate/Reload, same
// posture — its own fetch, no relation to the read-only record form.

interface OperationGroup {
  operationId: string
  operation: string
  startedAt: number
  entries: ModuleLogEntry[]
}

// entries arrives newest-operation-first (Registry.Logs / OpLogRepository.
// forModule sort every row across every operation by created_at desc) — group
// by operationId preserving that order, then reverse EACH group to
// chronological order so "+Nms" offsets below are relative to the run's start.
function groupByOperation(entries: ModuleLogEntry[]): OperationGroup[] {
  const order: string[] = []
  const byId = new Map<string, ModuleLogEntry[]>()
  for (const entry of entries) {
    if (!byId.has(entry.operationId)) {
      byId.set(entry.operationId, [])
      order.push(entry.operationId)
    }
    byId.get(entry.operationId)!.push(entry)
  }
  return order.map((operationId) => {
    const rows = [...byId.get(operationId)!].reverse()
    return {
      operationId,
      operation: rows[0].operation,
      startedAt: Date.parse(rows[0].createdAt),
      entries: rows,
    }
  })
}

function offsetLabel(entry: ModuleLogEntry, startedAt: number): string {
  const deltaMs = Date.parse(entry.createdAt) - startedAt
  if (deltaMs < 1000) return `+${deltaMs}ms`
  return `+${(deltaMs / 1000).toFixed(2)}s`
}

const LEVEL_COLOR: Record<string, 'default' | 'warning' | 'error'> = {
  info: 'default',
  warn: 'warning',
  error: 'error',
}

export function LogsButton({ name }: { name: string }) {
  const t = useT()
  const allowed = usePermission('modules:modules:read')
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [groups, setGroups] = useState<OperationGroup[] | null>(null)
  const [error, setError] = useState<SerializedError | null>(null)

  if (!allowed) return null

  const onOpen = () => {
    setOpen(true)
    setError(null)
    startTransition(async () => {
      try {
        const entries = await getModuleLogs(name)
        setGroups(groupByOperation(entries))
      } catch (e) {
        setError(serializeError(toApiError(e)))
      }
    })
  }

  return (
    <>
      <Button variant="text" onClick={onOpen}>
        {t('Logs')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('Operation logs')}</DialogTitle>
        <DialogContent>
          {error ? <ErrorAlert error={error} /> : null}
          {!error && pending ? <Typography color="text.secondary">{t('Loading…')}</Typography> : null}
          {!error && !pending && groups?.length === 0 ? (
            <Typography color="text.secondary">{t('No operations recorded yet.')}</Typography>
          ) : null}
          {!error &&
            groups?.map((group) => (
              <Accordion key={group.operationId} disableGutters>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Chip size="small" label={group.operation} />
                    <Typography variant="body2" color="text.secondary">
                      {new Date(group.startedAt).toLocaleString()}
                    </Typography>
                  </Stack>
                </AccordionSummary>
                <AccordionDetails>
                  <Stack spacing={0.5}>
                    {group.entries.map((entry, i) => (
                      <Box key={i} sx={{ display: 'flex', gap: 1, fontFamily: 'monospace', fontSize: '0.8rem' }}>
                        <Typography component="span" variant="body2" color="text.secondary" sx={{ minWidth: 64 }}>
                          {offsetLabel(entry, group.startedAt)}
                        </Typography>
                        <Chip size="small" variant="outlined" label={entry.source} />
                        {entry.level !== 'info' ? (
                          <Chip size="small" color={LEVEL_COLOR[entry.level] ?? 'default'} label={entry.level} />
                        ) : null}
                        <Typography component="span" variant="body2">
                          {entry.message}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                </AccordionDetails>
              </Accordion>
            ))}
        </DialogContent>
      </Dialog>
    </>
  )
}
