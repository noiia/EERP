import Alert from '@mui/material/Alert'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { getMyBookings, type MyBooking } from '@/website/account'
import Link from '@mui/material/Link'
import { CancelMyBookingButton, ResendVerificationButton, When } from './MyBookingsClient'

/** /account's booking history: upcoming (cancellable) and past or cancelled. */
export async function MyBookings({ verified }: { verified: boolean }) {
  const bookings = (await getMyBookings()) ?? []
  const now = Date.now()
  // Still ahead and still cancellable: a confirmed seat, or a place on the waiting list.
  const upcoming = (b: MyBooking) => (b.status === 'confirmed' || b.status === 'waitlisted') && !!b.start && Date.parse(b.start) > now
  const row = (b: MyBooking, cancellable: boolean) => (
    <ListItem key={b.id} disableGutters secondaryAction={cancellable ? <CancelMyBookingButton id={b.id} /> : undefined}>
      <ListItemText
        primary={b.event_name}
        secondary={<>
          <When iso={b.start} /> · <T text="Seats" /> {b.seats} · <T text={b.status} />
          {cancellable && b.status === 'confirmed' && <> · <Link href={`/api/site-booking/${encodeURIComponent(b.id)}/calendar`}><T text="Add to calendar" /></Link></>}
        </>}
      />
    </ListItem>
  )
  return (
    <Stack spacing={2}>
      {!verified && (
        <Alert severity="info" action={<ResendVerificationButton />}>
          <T text="Confirm your email to see bookings made before you signed up." />
        </Alert>
      )}
      {bookings.length === 0 && <Typography color="text.secondary"><T text="Your bookings will appear here." /></Typography>}
      {bookings.some(upcoming) && (
        <section>
          <Typography variant="h6" component="h3"><T text="Upcoming" /></Typography>
          <List dense>{bookings.filter(upcoming).map((b) => row(b, true))}</List>
        </section>
      )}
      {bookings.some((b) => !upcoming(b)) && (
        <section>
          <Typography variant="h6" component="h3"><T text="Past and cancelled" /></Typography>
          <List dense>{bookings.filter((b) => !upcoming(b)).map((b) => row(b, false))}</List>
        </section>
      )}
    </Stack>
  )
}
