import Box from '@mui/material/Box'
import LinearProgress from '@mui/material/LinearProgress'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'

// Shown by Next while an ERP page's server render is in flight (every /app route
// fetches its data server-side, so a navigation can take a moment). A progress bar
// plus the rough shape of a page — title, toolbar, rows — instead of the old page
// sitting frozen. `erp-loading` (ErpUiStyle) delays its appearance slightly, so a
// fast navigation never flashes it.
export default function Loading() {
  return (
    <Box className="erp-loading" role="status" aria-label="Loading" aria-busy="true">
      <LinearProgress sx={{ mb: 3, borderRadius: 1, height: 3 }} />
      <Stack spacing={2}>
        <Skeleton variant="text" width="28%" height={36} />
        <Stack direction="row" spacing={1}>
          <Skeleton variant="rounded" width={96} height={32} />
          <Skeleton variant="rounded" width={96} height={32} />
          <Box sx={{ flex: 1 }} />
          <Skeleton variant="rounded" width={240} height={32} />
        </Stack>
        <Skeleton variant="rounded" height={44} />
        {[0.95, 0.85, 0.9, 0.75, 0.88, 0.8].map((w, i) => (
          <Skeleton key={i} variant="rounded" height={36} width={`${w * 100}%`} />
        ))}
      </Stack>
    </Box>
  )
}
