'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { useTheme } from '@mui/material/styles'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import type { RiskConfig } from '../../api/view-fields'
import { useT } from '../../i18n/translate'
import { erpPath } from '../../navigation'
import { ErrorAlert } from '../error-alert'
import { DiagramLoading } from '../diagram/diagram-canvas'
import { useRelationOps } from '../relation-ops'
import { Ishikawa } from './ishikawa'
import { RiskMatrix } from './risk-matrix'
import { RiskRegister } from './risk-register'
import { type RiskRow } from './scoring'

export interface RiskRendererProps {
  config: RiskConfig
  projectId: string
}

const PAGE_SIZE = 200
type Tab = 'matrix' | 'ishikawa' | 'register'
type Category = { id: string; name: string }

// Risk display mode of a project's risk list: criticity matrix, Ishikawa fishbone and the AMDEC register.
export function RiskRenderer({ config, projectId }: RiskRendererProps) {
  const t = useT()
  const ops = useRelationOps()
  const router = useRouter()
  const th = useTheme()
  const [tab, setTab] = useState<Tab>('matrix')
  const [residual, setResidual] = useState(false)
  const [rows, setRows] = useState<RiskRow[] | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [project, setProject] = useState('')
  const [error, setError] = useState<SerializedError | null>(null)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const area = useRef<HTMLDivElement>(null)
  const { entity, projectField, categoryEntity } = config

  const listPage = ops?.listPage
  const get = ops?.get
  useEffect(() => {
    if (!listPage) return
    let cancelled = false
    const load = async () => {
      const out: RiskRow[] = []
      for (let page = 1; ; page++) {
        const res = await listPage(entity, { filter: { [projectField]: projectId }, order: '-criticity', pageSize: PAGE_SIZE, page })
        out.push(...(res.records as unknown as RiskRow[]))
        if (res.records.length < PAGE_SIZE) break
      }
      const cats = await listPage(categoryEntity, { order: 'name', pageSize: PAGE_SIZE, page: 1 })
      const proj = await get?.('project', projectId).catch(() => null)
      return { out, cats: cats.records as unknown as Category[], name: typeof proj?.name === 'string' ? proj.name : '' }
    }
    load().then(
      (r) => {
        if (cancelled) return
        setRows(r.out)
        setCategories(r.cats)
        setProject(r.name)
      },
      (e: unknown) => {
        if (cancelled) return
        setRows([])
        setError(serializeError(toApiError(e)))
      },
    )
    return () => {
      cancelled = true
    }
  }, [listPage, get, entity, projectField, categoryEntity, projectId])

  if (!rows) return <DiagramLoading />
  const open = (id: string) => router.push(erpPath(config.formPath.replace(':id', id)))
  const exportable = tab !== 'register'
  const doExport = (kind: 'png' | 'pdf') => {
    setMenu(null)
    const el = area.current
    if (!el) return
    const name = `${tab}-${projectId}`
    const bg = th.palette.background.paper
    const meta = { title: `${project} — ${tab === 'matrix' ? t('Matrix') : t('Ishikawa')}`, date: new Date(), legend: [], background: bg }
    const run = async () => {
      const { exportElementPdf, exportElementPng } = await import('../diagram/export')
      return kind === 'png' ? exportElementPng(el, name, bg) : exportElementPdf(el, meta, name)
    }
    run().catch((e: unknown) => setError(serializeError(toApiError(e))))
  }

  return (
    <Box sx={{ p: 1 }}>
      <ErrorAlert error={error} />
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tab} onChange={(_, v: Tab) => setTab(v)}>
          <Tab value="matrix" label={t('Matrix')} />
          <Tab value="ishikawa" label={t('Ishikawa')} />
          <Tab value="register" label={t('Register')} />
        </Tabs>
        <Stack direction="row" spacing={1}>
          {tab === 'matrix' && (
            <ToggleButtonGroup size="small" exclusive value={residual ? 'after' : 'now'} onChange={(_, v: string | null) => v && setResidual(v === 'after')}>
              <ToggleButton value="now">{t('Current')}</ToggleButton>
              <ToggleButton value="after">{t('After remediation')}</ToggleButton>
            </ToggleButtonGroup>
          )}
          {exportable && <Button size="small" onClick={(e) => setMenu(e.currentTarget)}>{t('Export')}</Button>}
        </Stack>
        <Menu open={!!menu} anchorEl={menu} onClose={() => setMenu(null)}>
          <MenuItem onClick={() => doExport('png')}>{t('Export PNG')}</MenuItem>
          <MenuItem onClick={() => doExport('pdf')}>{t('Export PDF')}</MenuItem>
        </Menu>
      </Stack>
      <Box sx={{ pt: 2, overflow: 'auto' }}>
        {tab === 'matrix' && <Box ref={area} sx={{ display: 'block', width: 'max-content' }}><RiskMatrix rows={rows} residual={residual} onOpen={open} /></Box>}
        {tab === 'ishikawa' && <Box ref={area} sx={{ display: 'block', width: 'max-content' }}><Ishikawa rows={rows} categories={categories} project={project} onOpen={open} /></Box>}
        {tab === 'register' && <RiskRegister rows={rows} categories={categories} onOpen={open} />}
      </Box>
    </Box>
  )
}
