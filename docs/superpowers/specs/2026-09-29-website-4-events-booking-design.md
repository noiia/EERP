# Spec 4 — Events and booking

**Date:** 2026-09-29 · **Status:** implemented (see Implementation notes; [ADR-026](../../adr/ADR-026-booking-capacity.md)) · **Depends on:** specs [1](2026-09-29-website-1-public-access-design.md),
[2](2026-09-29-website-2-core-design.md), [3](2026-09-29-website-3-mail-outbox-design.md)
· **Overview:** [website overview](2026-09-29-website-overview.md)

## Problem
Visitors must book dates from the website — fixed sessions with limited seats, and appointment
slots derived from staff availability — without overbooking, with an emailed confirmation, and
optionally tied to a website account.

## 1. Module `core/modules/event` (`type: go`, `app_mode: false`, menus under the Website app)
All tables ride the generic CRUD surface for the ERP side.

| Table | Fields |
|---|---|
| `event` | `name`, `description`, `picture` (pictures widget), `location`, `published`, `kind` (`sessions`\|`appointment`), appointment settings: `slot_minutes`, `slot_capacity` (default 1), `buffer_minutes`, `booking_horizon_days` (default 60), `min_notice_hours` (default 2), `max_seats_per_booking` (default 10) |
| `event_session` | `event_id`, `start`, `end` (`timestamptz`), `capacity`, `seats_taken` (read-only), `price` (display only) |
| `event_availability` | `event_id`, `weekday` (0–6), `from_time`, `to_time` (local times) |
| `event_booking` | `event_id`, `session_id` (nullable), `slot_start`/`slot_end` (nullable), `seats`, `email`, `name`, `phone`, `contact_id`, `user_id` (nullable), `status` (`confirmed`\|`cancelled`), `cancel_token` (random 32 bytes, unique), `cancelled_at` |

Check constraint: exactly one of `session_id` / `slot_start` is set. `event` declares public
fields (name, description, picture, location, kind, slot_minutes), seeded selection scoped
`{published: true}`. `event_session` and `event_booking` are **not** on the generic public
group: a session's visibility depends on its parent event, which a single-table forced filter
cannot express. Sessions are served by a dedicated
`GET /api/v1/public/event/:id/sessions` (future sessions of a published event: id, start, end,
capacity, seats_taken, price), alongside `/slots`.

ERP form: `event` has Sessions (o2m) and Availability (o2m) notebook pages shown by `kind`
(field states), a Bookings o2m, and a header button **Duplicate weekly × N** (copies the latest
session N times, +7 days each). Workspace timezone: new setting `general.timezone`
(IANA name, default `Europe/Paris`) used to expand availability.

## 2. Capacity
**Sessions** — one statement, no lock table, no overbooking under concurrency:
```sql
UPDATE event_session SET seats_taken = seats_taken + $2
WHERE id = $1 AND seats_taken + $2 <= capacity AND start > now()
```
0 rows → 409 "full". Cancel decrements in the same transaction as the status change.

**Appointments** — slots are computed, never stored.
`GET /api/v1/public/event/:id/slots?from=&to=` (range capped to 31 days) expands
`event_availability` in `general.timezone` into `slot_minutes` steps separated by
`buffer_minutes`, drops slots before `now + min_notice_hours` or after the horizon, and drops
slots with `slot_capacity` confirmed seats already booked. Booking a slot:
`pg_advisory_xact_lock(hashtextextended(event_id || slot_start, 0))`, re-validate the slot
against the availability, recount confirmed seats, insert — all in one transaction.

## 3. Public booking API (group `/api/v1/website`, rate-limited)
| Route | Auth | Behavior |
|---|---|---|
| `POST /website/bookings` | none or website token | body `{event_id, session_id? , slot_start?, seats, email, name, phone?}` |
| `POST /website/bookings/cancel` | none | body `{token}` — cancels by `cancel_token` |
| `GET /website/me/bookings` | website token | caller's bookings, newest first |
| `POST /website/me/bookings/:id/cancel` | website token | owner-only |
| `POST /website/auth/verify` | none | body `{token}` — sets `email_verified_at` |

`POST /website/bookings`, in one transaction:
1. Validate: email format, `1 ≤ seats ≤ max_seats_per_booking`, event `published`, session/slot
   in the future and belonging to the event.
2. Capture capacity (§2).
3. Upsert `contact` by `(tenant_id, lower(email))` (reuses the `contact` module; fills name/phone
   only when creating).
4. Insert the booking (`user_id` = caller if a website token).
5. `mail.Enqueue` the confirmation (event, date/time in the workspace timezone, seats, location,
   cancel link `https://<site>/booking/cancel?token=…`).
6. After commit, post a `kind: "log"` chatter message on the event record.

Responses never reveal whether an email already has an account.

## 4. Accounts
- Signup (spec 1) now also enqueues a verification email (token = random, stored hashed with
  expiry 48 h on the user row).
- On verification, confirmed anonymous bookings with the same `lower(email)` and `user_id IS
  NULL` are attached to the account. Before verification the account sees only bookings made
  while logged in — so nobody can claim someone else's history by signing up with their address.
- "My bookings" (`/account`) lists them with cancel buttons.

## 5. Website blocks (spec 2's closed set)
- `event_booking` — event summary, list of future sessions with remaining seats, seat count,
  booking form (email required; prefilled when logged in), success screen.
- `appointment_booking` — week picker over `/slots`, then the same form.
- `/booking/cancel?token=` — confirmation page then cancel.

## 6. Roles
`website_admin` gets `event:*`, `event_session:*`, `event_availability:*`, `event_booking:*`.
Staff can create/cancel bookings from the ERP; ERP-side creation goes through the same capacity
logic (Create override on `event_booking`), never a raw insert.

## Testing
- Concurrency: 20 goroutines book 1 seat on a capacity-5 session → exactly 5 succeed; same for a
  slot with `slot_capacity` 2.
- Slot expansion table tests including DST start/end in `Europe/Paris`, min notice, horizon,
  buffer.
- Booking tx rollback leaves no booking, no seat increment, no outbox row.
- Verification attach: only after verify, only `user_id IS NULL` rows.
- Cancel by token idempotent; cancelled seats become bookable again.

## Out of scope
Payment, waiting lists, reminders before the event (a cron action can add it later), staff
assignment per appointment, iCal export.

## Implementation notes
Where the build differs from this draft:
- **Time zone is per event** (`event.timezone`, IANA, default `Europe/Paris`) instead of a
  workspace `general.timezone` setting: events in different places can differ, and no new
  settings endpoint is needed. Emails and the site show times in that zone.
- **Session window columns are `starts_at`/`ends_at`**: the ORM doesn't quote identifiers and
  `end` is reserved in Postgres.
- **Contact linking is SQL on the `contact` table** (select by `lower(email)` in the tenant,
  insert if absent): `contact` lives in an internal, non-importable package. No unique index on
  contact email yet (ADR-026).
- **`site_url`** (new config key, the public site origin) builds email links;
  `frontend_base_url` is internal (pdf-service) and unsuitable.
- **ERP-side `event_booking`**: POST books through the service, PUT changes only name/phone or
  sets `status: "cancelled"`, DELETE is refused (409) — seat counts can't drift.
- **Verification is `POST /api/v1/website/me/verify`** (not `/website/auth/verify`): it must come
  from the account's own session, so a leaked link can't verify an address into someone else's
  account; `POST /website/me/verify/resend` re-issues it. The site's `/account/verify` page asks
  the visitor to sign in first and spends the token on a button click (link scanners prefetch
  GETs).
- **"Duplicate weekly × N"** is the **Repeat weekly** header button, N read from a display-only
  field beside the sessions table (module views have no DOM, so no prompt). Copies keep their UTC
  time across a DST change.
- **`picture` on `event`** is not built; events publish name, description, location, kind,
  slot_minutes and timezone. `max_seats_per_booking` isn't public, so the site caps seats at
  seats-left and 10, and Go enforces the event's real maximum (400).
- **Emails are English-only in v1** (Go has no per-visitor locale).
- The site books through the BFF route `POST /api/site-booking` (visitor token forwarded, never
  the ERP one); seats-left and slot reads are cached 60 s and expired on every site booking or
  cancel — Go's 409 is the truth.
