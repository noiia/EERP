'use client'
import { useEffect, useState } from 'react'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import { useT } from '../../i18n/translate'
import type { ExchangeFormat, GanttExchangeConfig } from '../../api/view-fields'
import { kanbanColumnsGuard } from '../kanban-columns'
import { useRelationOps } from '../relation-ops'
import { ToolButton } from '../diagram/toolbar'
import { ImportWizard } from './import-wizard'

// The plan exchange's menu (ADR-042), shared by the Gantt, WBS and PERT modes of a
// pinned project. It owns the import guard, the format menu and the wizard, so the
// wizard survives the menu closing.
//
// - 'toolbar': an Import button with its format menu. The host's own Export menu
//   carries the downloads (the Gantt folds them in beside PNG/SVG/PDF).
// - 'menuItems': one "Plan file" button whose menu lists "Export <label>" downloads
//   and "Import <label>" entries per format (the diagram canvases' toolbars, which
//   already have an image Export menu).

/** The format's export URL through the shell's BFF. */
export function exchangeExportUrl(config: GanttExchangeConfig, scopeId: string, key: string): string {
  return `/api/exchange/${config.scopeEntity}/${encodeURIComponent(scopeId)}/${encodeURIComponent(key)}/export`
}

/** Resolves the descriptor's `canImport` guard for one scope; false while unknown. */
export function useCanImport(config: GanttExchangeConfig | undefined, scopeId: string | null): boolean {
  const relationOps = useRelationOps()
  const [can, setCan] = useState(false)
  useEffect(() => {
    const guard = config?.canImport && scopeId != null ? kanbanColumnsGuard(config.canImport) : undefined
    if (!guard || scopeId == null) {
      setCan(false)
      return
    }
    let cancelled = false
    guard(scopeId, relationOps).then(
      (ok) => !cancelled && setCan(ok),
      () => !cancelled && setCan(false),
    )
    return () => {
      cancelled = true
    }
  }, [config?.canImport, scopeId, relationOps])
  return can
}

export interface ExchangeMenuProps {
  config: GanttExchangeConfig
  scopeId: string
  variant: 'toolbar' | 'menuItems'
  /** After an applied import: the host reads its records again. */
  onImported: () => void
}

export function ExchangeMenu({ config, scopeId, variant, onImported }: ExchangeMenuProps) {
  const t = useT()
  const canImport = useCanImport(config, scopeId)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [format, setFormat] = useState<ExchangeFormat | null>(null)
  const pick = (f: ExchangeFormat) => {
    setAnchor(null)
    setFormat(f)
  }

  let button = null
  let items: React.ReactNode[] = []
  if (variant === 'toolbar') {
    if (canImport) {
      button = <ToolButton icon="upload" label={t('Import')} aria-haspopup="menu" onClick={(e) => setAnchor(e.currentTarget)} />
      items = config.formats.map((f) => (
        <MenuItem key={f.key} onClick={() => pick(f)}>
          {t(f.label)}
        </MenuItem>
      ))
    }
  } else {
    button = <ToolButton icon="file-export" label={t('Plan file')} aria-haspopup="menu" onClick={(e) => setAnchor(e.currentTarget)} />
    items = [
      ...config.formats.map((f) => (
        <MenuItem key={`export-${f.key}`} component="a" href={exchangeExportUrl(config, scopeId, f.key)} download onClick={() => setAnchor(null)}>
          {t('Export {label}').replace('{label}', t(f.label))}
        </MenuItem>
      )),
      ...(canImport
        ? config.formats.map((f) => (
            <MenuItem key={`import-${f.key}`} onClick={() => pick(f)}>
              {t('Import {label}').replace('{label}', t(f.label))}
            </MenuItem>
          ))
        : []),
    ]
  }

  return (
    <>
      {button}
      <Menu open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)}>
        {items}
      </Menu>
      {format ? (
        <ImportWizard open onClose={() => setFormat(null)} onApplied={onImported} config={config} scopeId={scopeId} format={format} />
      ) : null}
    </>
  )
}
