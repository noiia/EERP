import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'

// Placeholder landing route for Phase 0. Module routes arrive via the
// catch-all app/[...module]/page.tsx in Phase 2.
export default function HomePage() {
  return (
    <Container sx={{ py: 6 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        EERP
      </Typography>
      <Typography color="text.secondary">Frontend service — Phase 0 (Next.js)</Typography>
    </Container>
  )
}
