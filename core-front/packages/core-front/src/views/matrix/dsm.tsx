'use client'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import type { MatrixConfig } from '../../api/view-fields'
import { useT } from '../../i18n/translate'
import { ErrorAlert } from '../error-alert'
import { DiagramLoading } from '../diagram/diagram-canvas'
import { compareOrder } from '../diagram/wbs'
import { useGraphPalette } from '../graph-widgets'
import { useRelationOps, type RelationRecord } from '../relation-ops'
import type { MatrixTask } from './matrix-renderer'

const DSM_TASK_CAP = 150
const DEPENDENCY_CHUNK = 100
const PAGE_SIZE = 200

/** Tasks in `wbs_number` order (dotted comparison, segment by segment;
 * unnumbered last, id as tiebreak). */
export function dsmOrder(tasks: MatrixTask[]): MatrixTask[] {
  return [...tasks].sort((a, b) => compareOrder(a.wbs_number, b.wbs_number) || a.id.localeCompare(b.id))
}

export interface DsmProps {
  tasks: MatrixTask[]
  config: MatrixConfig
  /** Opens the dependent task's form (a tapped mark). */
  onOpen: (taskId: string) => void
}

/**
 * The dependency structure matrix (DSM): rows and columns are the project's
 * tasks in WBS order, and a dependency "A depends on B" fills the cell at
 * row A (the dependent), column B (the blocker). The diagonal is greyed
 * (a task does not depend on itself). Over `DSM_TASK_CAP` tasks the grid
 * caps and says so; hovering a cell highlights its row and column, and
 * tapping a mark opens the dependent task's form.
 */
export function Dsm({ tasks, config, onOpen }: DsmProps) {
  const t = useT()
  const th = useTheme()
  const ops = useRelationOps()
  const { categorical } = useGraphPalette()
  const [deps, setDeps] = useState<RelationRecord[] | null>(null)
  const [error, setError] = useState<SerializedError | null>(null)
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null)

  const listPage = ops?.listPage
  const { entity, toField, fromField } = config.dependencies
  const visible = useMemo(() => dsmOrder(tasks).slice(0, DSM_TASK_CAP), [tasks])
  useEffect(() => {
    if (!listPage) return
    let cancelled = false
    // The dependencies touching the visible tasks, read in id chunks (the
    // 1000-capped task list keeps each `in` clause small, like the Gantt).
    const load = async () => {
      const out: RelationRecord[] = []
      const ids = visible.map((task) => task.id)
      for (let i = 0; i < ids.length; i += DEPENDENCY_CHUNK) {
        const chunk = ids.slice(i, i + DEPENDENCY_CHUNK)
        for (let page = 1; ; page++) {
          const res = await listPage(entity, { in: { [toField]: chunk }, order: toField, pageSize: PAGE_SIZE, page })
          out.push(...res.records)
          if (res.records.length < PAGE_SIZE) break
        }
      }
      return out
    }
    load().then(
      (rows) => {
        if (!cancelled) setDeps(rows)
      },
      (e: unknown) => {
        if (cancelled) return
        setDeps([])
        setError(serializeError(toApiError(e)))
      },
    )
    return () => {
      cancelled = true
    }
  }, [listPage, entity, toField, visible])

  const rows = visible
  const capped = tasks.length > DSM_TASK_CAP
  const index = useMemo(() => new Map(rows.map((task, i) => [task.id, i])), [rows])
  // One key per filled cell: row = the dependent task, column = its blocker.
  const marks = useMemo(() => {
    const out = new Set<string>()
    if (!deps) return out
    for (const dep of deps) {
      const r = index.get(dep[toField] as string)
      const c = index.get(dep[fromField] as string)
      if (r !== undefined && c !== undefined) out.add(`${r}:${c}`)
    }
    return out
  }, [deps, index, toField, fromField])

  if (!deps) return <DiagramLoading />

  const cellStyle = (r: number, c: number): CSSProperties => {
    if (r === c) return { backgroundColor: th.palette.action.disabled }
    if (marks.has(`${r}:${c}`)) return { backgroundColor: categorical[0] }
    if (hover && (hover.r === r || hover.c === c)) return { backgroundColor: th.palette.action.hover }
    return {}
  }
  const headerStyle = (edge: 'top' | 'left'): CSSProperties => ({
    position: 'sticky',
    ...(edge === 'top' ? { top: 0 } : { left: 0 }),
    zIndex: 1,
    backgroundColor: th.palette.background.paper,
    border: `1px solid ${th.palette.divider}`,
    padding: th.spacing(0.5, 1),
    whiteSpace: 'nowrap',
  })

  return (
    <Box sx={{ pt: 0.5 }}>
      <ErrorAlert error={error} />
      {capped && (
        <Typography variant="caption" color="text.secondary">
          {t('First 150 tasks shown')}
        </Typography>
      )}
      <Box
        data-testid="dsm-box"
        sx={{ overflow: 'auto', maxHeight: 'calc(100dvh - 240px)', border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default' }}
        onMouseLeave={() => setHover(null)}
      >
        <table style={{ borderCollapse: 'collapse', width: 'max-content' }}>
          <thead>
            <tr>
              <th style={{ ...headerStyle('left'), zIndex: 2 }} aria-label="corner" />
              {rows.map((task, c) => (
                <th key={task.id} data-testid={`dsm-col-${c}`} scope="col" style={{ ...headerStyle('top'), minWidth: 96 }}>
                  {task.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={row.id}>
                <th data-testid={`dsm-row-${r}`} scope="row" style={{ ...headerStyle('left'), textAlign: 'left', maxWidth: 240, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                  {row.name}
                </th>
                {rows.map((col, c) => {
                  const diagonal = r === c
                  const marked = marks.has(`${r}:${c}`)
                  return (
                    <td
                      key={col.id}
                      data-testid={`dsm-cell-${r}-${c}`}
                      data-diagonal={diagonal ? '' : undefined}
                      style={{ ...cellStyle(r, c), width: 44, height: 44, border: `1px solid ${th.palette.divider}` }}
                      onMouseEnter={() => setHover({ r, c })}
                    >
                      {marked ? (
                        <Button
                          data-testid={`dsm-mark-${r}-${c}`}
                          size="small"
                          aria-label={col.name}
                          onClick={() => onOpen(row.id)}
                          sx={{ width: '100%', height: '100%', minWidth: 32, minHeight: 32, p: 0, borderRadius: '50%' }}
                        >
                          <Typography variant="body2" color="common.contrast" sx={{ display: 'block', textAlign: 'center' }}>
                            &#9679;
                          </Typography>
                        </Button>
                      ) : null}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Box>
    </Box>
  )
}
