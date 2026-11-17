'use client'
import { useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import type { MatrixConfig } from '../../api/view-fields'
import { useT } from '../../i18n/translate'
import { ErrorAlert } from '../error-alert'
import { usePhone } from '../use-phone'
import { useRelationOps } from '../relation-ops'
import { useOptimisticFieldMove } from '../use-optimistic-field-move'
import type { EntityActions } from '../stores'
import type { MatrixTask } from './matrix-renderer'

const DAY_MS = 86_400_000

export const QUADRANTS = [
  { id: 'do', label: 'Do' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'delegate', label: 'Delegate' },
  { id: 'eliminate', label: 'Eliminate' },
] as const
type QuadrantId = (typeof QUADRANTS)[number]['id']

/** True when a deadline exists and falls strictly before `now + urgentDays`
 * (overdue deadlines count too — they are even more urgent). */
export function isUrgent(deadline: unknown, urgentDays: number, now: Date): boolean {
  if (typeof deadline !== 'string' || !deadline) return false
  const d = new Date(deadline)
  if (Number.isNaN(d.getTime())) return false
  return d.getTime() < now.getTime() + urgentDays * DAY_MS
}

/** Do = important + urgent, Schedule = important, Delegate = urgent,
 * Eliminate = neither (the Global Constraints). */
export function quadrantOf(important: boolean, urgent: boolean): QuadrantId {
  if (important && urgent) return 'do'
  if (important) return 'schedule'
  if (urgent) return 'delegate'
  return 'eliminate'
}

/** Closed tasks are excluded; the rest bucket by priority (important) and
 * deadline urgency (urgent) into the four quadrants. */
export function eisenhowerQuadrants(tasks: MatrixTask[], config: MatrixConfig, now: Date): Record<QuadrantId, MatrixTask[]> {
  const out: Record<QuadrantId, MatrixTask[]> = { do: [], schedule: [], delegate: [], eliminate: [] }
  for (const task of tasks) {
    if (task[config.closedField]) continue
    const important = Boolean(task[config.priorityField])
    out[quadrantOf(important, isUrgent(task[config.deadlineField], config.urgentDays, now))].push(task)
  }
  return out
}

export interface EisenhowerProps {
  tasks: MatrixTask[]
  config: MatrixConfig
  canWrite: boolean
}

/**
 * The Eisenhower matrix: the project's open tasks in the four
 * Do / Schedule / Delegate / Eliminate quadrants. A card's `Toggle priority`
 * button (write permission only) flips the priority field through
 * `useOptimisticFieldMove`, moving the card across quadrants; a rejected
 * PATCH reverts the card and raises the error alert.
 */
export function Eisenhower({ tasks, config, canWrite }: EisenhowerProps) {
  const t = useT()
  const ops = useRelationOps()
  const phone = usePhone()
  const [collapsed, setCollapsed] = useState<Partial<Record<QuadrantId, boolean>>>({})

  // The renderer only mounts this tab when RelationOps exists; the
  // no-op fallbacks below are unreachable, they just keep the types whole.
  const actions = useMemo<EntityActions<MatrixTask>>(
    () =>
      ({
        create: (body) => ops?.create(config.taskEntity, body as Record<string, unknown>).then((r) => r as MatrixTask) ?? Promise.resolve(null as unknown as MatrixTask),
        update: (id, body) =>
          (ops?.update ? ops.update(config.taskEntity, id, body as Record<string, unknown>).then((r) => r as MatrixTask) : Promise.resolve(null as unknown as MatrixTask)),
        remove: (id) => ops?.remove(config.taskEntity, id) ?? Promise.resolve(),
      }) as EntityActions<MatrixTask>,
    [ops, config.taskEntity],
  )
  // The working set: initialData plus in-flight optimistic priority flips.
  const { records, error, moveField } = useOptimisticFieldMove<MatrixTask>(tasks, actions, config.priorityField)

  // "Today" is the current date: the urgency horizon slides with it.
  const quadrants = eisenhowerQuadrants(records, config, new Date())

  return (
    <>
      <ErrorAlert error={error} />
      <Box
        data-testid="eisenhower-list"
        sx={{ display: 'grid', gridTemplateColumns: phone ? '1fr' : '1fr 1fr', gap: 1, alignItems: 'start' }}
      >
        {QUADRANTS.map((quadrant) => {
          const rows = quadrants[quadrant.id]
          const isCollapsed = Boolean(collapsed[quadrant.id])
          return (
            <Box key={quadrant.id} data-testid={`eisenhower-${quadrant.id}`} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
              <Button
                fullWidth
                size="small"
                onClick={() => setCollapsed((c) => ({ ...c, [quadrant.id]: !c[quadrant.id] }))}
                sx={{ justifyContent: 'flex-start', textTransform: 'none', fontWeight: 'medium', py: phone ? 1.25 : 1, minHeight: phone ? 40 : undefined }}
              >
                {t(quadrant.label)} ({rows.length})
              </Button>
              {!isCollapsed && (
                <Box sx={{ px: 1, pb: 1 }}>
                  {rows.map((task) => {
                    const important = Boolean(task[config.priorityField])
                    const deadline = task[config.deadlineField]
                    return (
                      <Box key={task.id} data-testid={`eis-card-${task.id}`} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1, mb: 1, bgcolor: 'background.paper' }}>
                        <Typography variant="body2" noWrap>
                          {task.name}
                        </Typography>
                        {typeof deadline === 'string' && deadline ? (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                            {deadline}
                          </Typography>
                        ) : null}
                        {canWrite ? (
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => moveField(task.id, !important)}
                            sx={{ mt: 0.5, minHeight: phone ? 40 : undefined }}
                          >
                            {t('Toggle priority')}
                          </Button>
                        ) : null}
                      </Box>
                    )
                  })}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    </>
  )
}
