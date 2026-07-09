import Alert from '@mui/material/Alert'
import AlertTitle from '@mui/material/AlertTitle'
import Typography from '@mui/material/Typography'
import type { SerializedError } from '../api/errors'

// Shared error surface (code + message + request id) for every renderer that
// can fail a write: FormRenderer's Save, KanbanRenderer's drag-to-move, and —
// later — Calendar's drag-to-reschedule (docs/roadmaps/list-view-modes.md).
// A separate file (not defined inline in renderers.tsx) so kanban-renderer.tsx
// can import it without a circular import back into renderers.tsx.
export function ErrorAlert({ error }: { error: SerializedError }) {
  return (
    <Alert severity="error">
      <AlertTitle>{error.code}</AlertTitle>
      {error.message}
      {error.requestId ? (
        <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>
          request: {error.requestId}
        </Typography>
      ) : null}
    </Alert>
  )
}
