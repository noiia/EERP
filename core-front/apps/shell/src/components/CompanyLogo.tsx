'use client'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import { FontAwesomeIcon, byPrefixAndName, usePermission, usePictureClient, useT } from '@eerp/core-front'

/** The active company's logo at the top bar's start. With company:company:write it
 * is also the upload control: click to add or replace the logo (the same picture
 * anchor as Settings → Company's logo field; Go flips the `logo` flag itself). */
export function CompanyLogo({ companyId }: { companyId: string }) {
  const t = useT()
  const pictures = usePictureClient()
  const canEdit = usePermission('company:company:write')
  const input = useRef<HTMLInputElement>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const anchor = { table: 'company', recordId: companyId, field: 'logo' }

  useEffect(() => {
    let live = true
    pictures.find({ table: 'company', recordId: companyId, field: 'logo' })
      .then((p) => live && setSrc(p ? `${pictures.url(p.id)}?v=${p.size}` : null), () => live && setSrc(null))
    return () => { live = false }
  }, [companyId, pictures])

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // picking the same file again still fires
    if (!file) return
    setBusy(true)
    try {
      const p = await pictures.upload(anchor, file, file.name)
      setSrc(`${pictures.url(p.id)}?v=${Date.now()}`)
    } finally {
      setBusy(false)
    }
  }

  if (!src && !canEdit) return null
  const img = src && <Box component="img" src={src} alt={t('Company logo')} sx={{ height: 28, maxWidth: 120, objectFit: 'contain', display: 'block' }} />
  if (!canEdit) return <Box sx={{ mr: 1.5 }}>{img}</Box>
  return (
    <>
      <Tooltip title={t(src ? 'Change the company logo' : 'Add the company logo')}>
        <IconButton color="inherit" size="small" disabled={busy} onClick={() => input.current?.click()} sx={{ mr: 1, borderRadius: 1 }}
          aria-label={t(src ? 'Change the company logo' : 'Add the company logo')}>
          {img || <FontAwesomeIcon icon={byPrefixAndName.fas['image']} />}
        </IconButton>
      </Tooltip>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void upload(e)} />
    </>
  )
}
