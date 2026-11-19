'use client'
import { useState } from 'react'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { useT } from '@eerp/core-front'
import { BLOCK_LABELS, type WfNode, type WfPage } from '@/website/workflow'
import { linkSlots, type LinkSlot, type NewLink } from '@/website/workflow-edit'

// The workflow map's two dialogs: what a new arrow becomes on its source page, and
// the confirmation before an arrow is removed.

const SLOT_LABELS: Record<LinkSlot['key'], string> = {
  cta_href: 'Button', href: 'Image link', detail_slug: 'Card detail page', 'after.slug': 'Page after submit',
}
const slotId = (s: LinkSlot) => `${s.blockId}|${s.key}`

/** A short hint telling apart two blocks of the same type: its title or heading. */
function blockHint(page: WfPage, blockId: string): string {
  const c = page.layout.find((b) => b.id === blockId)?.config ?? {}
  const hint = [c.title, c.heading, c.cta_label].find((v) => typeof v === 'string' && v.trim())
  return typeof hint === 'string' ? ` “${hint.trim().slice(0, 40)}”` : ''
}

export function NewLinkDialog({ page, to, pages, onCancel, onSave }: {
  page: WfPage
  to: WfNode
  /** Every site page, for the "after login" picker. */
  pages: WfPage[]
  onCancel: () => void
  onSave: (link: NewLink) => Promise<void>
}) {
  const t = useT()
  const slots = linkSlots(page.layout, to.id)
  const [choice, setChoice] = useState<string>(slots[0] ? slotId(slots[0]) : 'new')
  const [label, setLabel] = useState(to.id.startsWith('sys:') ? t(to.label) : to.label)
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const slot = slots.find((s) => slotId(s) === choice)
  const button = choice === 'new' || !!slot?.button
  const viaLogin = to.id === 'sys:login' || to.id === 'sys:signup'

  const save = async () => {
    setBusy(true)
    await onSave({ slot: slot ? { blockId: slot.blockId, key: slot.key } : 'new', to: to.id, label: button ? label : undefined, next: viaLogin ? next : undefined })
    setBusy(false)
  }

  return (
    <Dialog open onClose={busy ? undefined : onCancel} fullWidth maxWidth="sm">
      <DialogTitle>{t('New link')}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <DialogContentText component="div">
            <div>{t('From')}: <strong>{page.title || `/${page.slug}`}</strong></div>
            <div>{t('To')}: <strong>{to.id.startsWith('sys:') ? t(to.label) : to.label}</strong></div>
          </DialogContentText>
          <FormControl>
            <RadioGroup value={choice} onChange={(e) => setChoice(e.target.value)} aria-label={t('Which block holds the link?')}>
              {slots.map((s) => (
                <FormControlLabel
                  key={slotId(s)}
                  value={slotId(s)}
                  control={<Radio />}
                  label={`${t(BLOCK_LABELS[s.blockType] ?? s.blockType)}${blockHint(page, s.blockId)} — ${t(SLOT_LABELS[s.key])}`}
                />
              ))}
              <FormControlLabel value="new" control={<Radio />} label={t('Add a new button block at the bottom of the page')} />
            </RadioGroup>
          </FormControl>
          {button && <TextField label={t('Button text')} value={label} onChange={(e) => setLabel(e.target.value)} required />}
          {viaLogin && (
            <FormControl fullWidth>
              <InputLabel id="wf-next">{t('After login, go to')}</InputLabel>
              <Select labelId="wf-next" label={t('After login, go to')} value={next} onChange={(e) => setNext(e.target.value)}>
                <MenuItem value="">{t('My account')}</MenuItem>
                {pages.filter((p) => p.slug).map((p) => <MenuItem key={p.id} value={p.slug}>{p.title || `/${p.slug}`}</MenuItem>)}
              </Select>
            </FormControl>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy || (button && !label.trim())}>{t('Add link')}</Button>
      </DialogActions>
    </Dialog>
  )
}

export function RemoveLinkDialog({ label, pageTitle, onCancel, onConfirm }: {
  label: string
  pageTitle: string
  onCancel: () => void
  onConfirm: () => Promise<void>
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open onClose={busy ? undefined : onCancel}>
      <DialogTitle>{t('Remove this link?')}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          <strong>{label}</strong> · {pageTitle}
        </DialogContentText>
        <DialogContentText sx={{ mt: 1 }}>
          {t('The block stays on the page; only its link is removed.')}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>{t('Cancel')}</Button>
        <Button color="error" variant="contained" disabled={busy} onClick={async () => { setBusy(true); await onConfirm(); setBusy(false) }}>{t('Remove')}</Button>
      </DialogActions>
    </Dialog>
  )
}
