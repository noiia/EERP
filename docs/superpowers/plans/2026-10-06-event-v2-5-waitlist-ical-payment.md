# Event v2 · SP5 — Waiting list, iCal, invoicing, payment — Implementation Plan

**Spec:** [Event v2 overview § SP5](../specs/2026-10-06-event-v2-overview.md#sp5-waiting-list-ical-invoicing-payment)
· [ADR-028](../../adr/ADR-028-payment-providers.md)

**Goal:** full sessions keep a waiting list, bookings land in calendars, paid events invoice
their bookings and take card payments when Stripe is connected.

**Global constraints:** every seat change goes through the booking service; statuses holding
seats are confirmed, attended, no_show and pending_payment; no network call inside a booking
transaction; an unconnected workspace keeps working (pay at the event).

## File structure

- `core/modules/event/waitlist.go` — `offerNext`, `ClaimOffer`, `ExpireOffers`
- `core/modules/event/ics.go`, `feeds.go` — iCalendar writer, public/visitor/staff feeds
- `core/internal/mail` — `Message.Attachments`, `multipart/mixed`
- `core/modules/sale/external.go` — `CreateInvoice`, `SetInvoiceStatus`, `VariantPricing`, `WorkspaceCurrency`
- `core/modules/event/billing.go` — invoicing, pay-later template, `MarkPaid`
- `core/internal/payment` — provider registry; `core/modules/payment_stripe` — Stripe
- `core/modules/event/payment.go` — hold, checkout, webhook, hold expiry
- frontend: `BookingForm` (waitlist, price, checkout redirect), `/booking/claim`, `/booking/paid`,
  `EventFeedSettings`, `StripeConnectorSettings`, booking `.ics` BFF route, ERP views

### Stage a: Waiting list

- [x] Failing tests (`waitlist_test.go`, app subtest); implement; frontend (join, claim page,
  settings); run.

### Stage b: iCal

- [x] Failing tests (`ics_test.go`, invites on emails, `TestCalendarFeeds`, MIME attachment);
  implement; frontend (My bookings link, feed link, staff feed settings).

### Stage c: Invoicing

- [x] Failing tests (`billing_test.go`, paid-event app subtest); implement; ERP views (product,
  invoice summary, Mark paid); public price.

### Stage d: Payment

- [x] Failing tests (`internal/payment`, `payment_stripe`, `payment_test.go`,
  `TestStripeSettingsAndWebhook`); implement; frontend (redirect, paid page, Stripe settings).

### Docs

- [x] ADR-028, ADR-026 pitfall, CLAUDE.md, core-front CLAUDE.md, overview as-built, i18n.
