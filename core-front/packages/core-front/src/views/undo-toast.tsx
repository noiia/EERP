'use client'
import { create } from 'zustand'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Paper from '@mui/material/Paper'
import Slide, { type SlideProps } from '@mui/material/Slide'
import Snackbar from '@mui/material/Snackbar'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'
import { byPrefixAndName, FontAwesomeIcon } from './icons'

// The generic "undo a hard delete" toast — meant to be the DEFAULT recovery
// mechanism for any hard-delete action in the app (search-bar.tsx's saved-
// filter delete and calendar-renderer.tsx's drag-to-unschedule are the first
// two adopters), not a one-off. Plain Zustand store (no persist — purely
// transient client UI state, same shape as useUiStore/useRecordLabelStore),
// not an ops-context: this holds no host-injected data operation, just a
// pending callback pair a caller provides inline.
//
// Two supported shapes, both via the same `show()` call:
//   - DEFERRED commit: the caller hasn't actually done the delete yet: pass
//     `onExpire` to do it once the window elapses un-recovered; `onRecover`
//     is then a no-op restore of local state only (zero backend calls if
//     the user clicks Recover).
//   - EAGER commit with reversal: the caller already performed the action
//     optimistically (matching how this app's other optimistic mutations —
//     Kanban/Calendar drags — already work) and only needs `onRecover` to
//     undo it; `onExpire` is omitted.
//
// ponytail: a single pending slot, not a queue — triggering a second show()
// while one is still pending immediately expires the first rather than
// stacking toasts. Add a real queue if a workflow ever needs to delete two
// things back-to-back inside one undo window.

const UNDO_WINDOW_MS = 6000

export interface PendingUndo {
  id: string
  message: string
  onRecover: () => void
  onExpire?: () => void
}

interface UndoToastStore {
  pending: PendingUndo | null
  show: (opts: { message: string; onRecover: () => void; onExpire?: () => void }) => void
  recover: () => void
  /** Hides the banner only — the scheduled onExpire still fires on its
   * original timer. Dismissing a "deleted" toast doesn't un-delete it. */
  dismiss: () => void
}

// Lives outside the store's own state on purpose: dismiss() must be able to
// clear the VISIBLE banner without touching the still-running timer.
let timer: ReturnType<typeof setTimeout> | null = null
// A monotonic counter, not crypto.randomUUID() — this id only ever needs to
// be unique within one tab's lifetime (telling apart two show() calls when
// the timer fires), and crypto.randomUUID() throws outside a secure context
// (plain HTTP, not localhost — exactly how this app can be deployed).
let nextId = 0

export const useUndoToastStore = create<UndoToastStore>((set, get) => ({
  pending: null,
  show: ({ message, onRecover, onExpire }) => {
    if (timer) {
      clearTimeout(timer)
      timer = null
      get().pending?.onExpire?.()
    }
    const id = String(nextId++)
    timer = setTimeout(() => {
      timer = null
      set((s) => (s.pending?.id === id ? { pending: null } : s))
      onExpire?.()
    }, UNDO_WINDOW_MS)
    set({ pending: { id, message, onRecover, onExpire } })
  },
  recover: () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    get().pending?.onRecover()
    set({ pending: null })
  },
  dismiss: () => set({ pending: null }),
}))

/** Mount once at the root layout — every `show()` call anywhere in the app
 * renders through this single instance. */
export function UndoToastHost() {
  const t = useT()
  const pending = useUndoToastStore((s) => s.pending)
  const recover = useUndoToastStore((s) => s.recover)
  const dismiss = useUndoToastStore((s) => s.dismiss)

  return (
    <Snackbar
      open={pending != null}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      slots={{ transition: Slide }}
      slotProps={{ transition: { direction: 'up' } as SlideProps }}
    >
      <Paper
        elevation={6}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          pl: 1,
          pr: 1,
          py: 0.5,
          borderRadius: 2,
          minWidth: 320,
        }}
      >
        <Button size="small" color="inherit" onClick={recover}>
          {t('Recover')}
        </Button>
        <Typography variant="body2" sx={{ flexGrow: 1 }}>
          {pending?.message}
        </Typography>
        <IconButton size="small" aria-label={t('Dismiss')} onClick={dismiss}>
          <FontAwesomeIcon icon={byPrefixAndName.fas['xmark']} size="sm" />
        </IconButton>
      </Paper>
    </Snackbar>
  )
}
