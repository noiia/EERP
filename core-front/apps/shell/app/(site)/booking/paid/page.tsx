import Alert from '@mui/material/Alert'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'

// Where the payment provider sends the visitor back after paying. The booking
// is confirmed by the provider's webhook, not by this page (a visitor can land
// here without paying), so it only says what happens next.
export default function PaidPage() {
  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1"><T text="Thank you" /></Typography>
        <Alert severity="success">
          <T text="Your payment is being confirmed. Your booking confirmation will arrive by email in a moment." />
        </Alert>
      </Stack>
    </Container>
  )
}
