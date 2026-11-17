'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import Typography from '@mui/material/Typography'
import { usePermission } from '../../auth/Can'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import type { MatrixConfig } from '../../api/view-fields'
import { useT } from '../../i18n/translate'
import { erpPath } from '../../navigation'
import { ErrorAlert } from '../error-alert'
import { DiagramLoading } from '../diagram/diagram-canvas'
import { usePhone } from '../use-phone'
import { useRelationOps } from '../relation-ops'
import { Dsm } from './dsm'
import { Eisenhower } from './eisenhower'
import { Raci } from './raci'

/** A task row as the matrices read it: id/name plus the module-declared
 * field accessors (priority, deadline, closed) and the literal WBS number
 * the ordering matrices sort by. */
export interface MatrixTask {
  id: string
  name: string
  wbs_number: string | null
  [field: string]: unknown
}

export interface MatrixRendererProps {
  config: MatrixConfig
  projectId: string
}

const PAGE_SIZE = 200
const RECORD_CAP = 1000
type TabId = 'eisenhower' | 'raci' | 'dependencies'

/**
 * Matrices display mode of a project's task list (ADR-041): the Eisenhower
 * priority matrix, the RACI accountability matrix and the dependency
 * structure matrix (DSM), all over the pinned project. The tasks load once
 * for the three tabs (`filter[project]`, pages of 200, capped at 1000 with
 * a visible "first 1000 shown" caption per ADR-032); each tab fetches its
 * own extras (dependency rows, RACI rows and members) as it renders.
 */
export function MatrixRenderer({ config, projectId }: MatrixRendererProps) {
  const t = useT()
  const ops = useRelationOps()
  const router = useRouter()
  const phone = usePhone()
  const canWrite = usePermission(`${config.taskEntity}:${config.taskEntity}:write`)
  const [tab, setTab] = useState<TabId>('eisenhower')
  const [tasks, setTasks] = useState<MatrixTask[] | null>(null)
  const [capped, setCapped] = useState(false)
  const [error, setError] = useState<SerializedError | null>(null)
  const { taskEntity, projectField, taskFormPath } = config

  const listPage = ops?.listPage
  useEffect(() => {
    if (!listPage) return
    let cancelled = false
    const load = async () => {
      const out: MatrixTask[] = []
      let isCapped = false
      for (let page = 1; ; page++) {
        const res = await listPage(taskEntity, { filter: { [projectField]: projectId }, order: 'created_at', pageSize: PAGE_SIZE, page })
        out.push(...(res.records as unknown as MatrixTask[]))
        if (res.records.length < PAGE_SIZE) break
        if (out.length >= RECORD_CAP) {
          // One probe row past the cap: exactly RECORD_CAP matches isn't "more".
          const probe = await listPage(taskEntity, { filter: { [projectField]: projectId }, order: 'created_at', pageSize: 1, page: RECORD_CAP + 1 })
          isCapped = probe.records.length > 0
          break
        }
      }
      return { out, isCapped }
    }
    load().then(
      (r) => {
        if (cancelled) return
        setTasks(r.out)
        setCapped(r.isCapped)
      },
      (e: unknown) => {
        if (cancelled) return
        setTasks([])
        setError(serializeError(toApiError(e)))
      },
    )
    return () => {
      cancelled = true
    }
  }, [listPage, taskEntity, projectField, projectId])

  if (!tasks) return <DiagramLoading />
  const open = (id: string) => router.push(erpPath(taskFormPath.replace(':id', id)))

  return (
    <Box sx={{ p: 1 }}>
      <ErrorAlert error={error} />
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tab} onChange={(_, v: TabId) => setTab(v)} variant={phone ? 'fullWidth' : 'standard'}>
          <Tab value="eisenhower" label={t('Eisenhower')} />
          <Tab value="raci" label={t('RACI')} />
          <Tab value="dependencies" label={t('Dependencies')} />
        </Tabs>
      </Box>
      {capped && (
        <Typography variant="caption" color="text.secondary">
          {t('First 1000 shown')}
        </Typography>
      )}
      <Box sx={{ pt: 1 }}>
        {tab === 'eisenhower' && ops ? <Eisenhower tasks={tasks} config={config} canWrite={canWrite} /> : null}
        {tab === 'raci' && ops ? <Raci tasks={tasks} config={config} projectId={projectId} /> : null}
        {tab === 'dependencies' && ops ? <Dsm tasks={tasks} config={config} onOpen={open} /> : null}
      </Box>
    </Box>
  )
}
