import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'

export default function SiteNotFound() {
  return (
    <Container maxWidth="sm" sx={{ py: 8, textAlign: 'center' }}>
      <Typography variant="h4" component="h1" gutterBottom><T text="Page not found" /></Typography>
      <Button href="/" variant="contained"><T text="Back to home" /></Button>
    </Container>
  )
}
