package devseed

import "slices"

// eventSteps seed the Event app: n/100 events (one in five an appointment
// event, one in ten unpublished), weekday 09:00–17:00 availability for the
// appointment ones, n/10 two-hour sessions spread over the past and next six
// months, and n bookings — 90% on sessions (round-robin, so every session
// gets about the same number and stays far below its 40–80 capacity), 10% on
// appointment slots aligned with the availability. Every booking is tied to
// a seeded contact (as the booking service does). Status follows time: past
// bookings are attended (70%), no-show (15%) or cancelled; upcoming ones are
// confirmed, 1 in 10 cancelled. seats_taken is then recomputed from the
// bookings that hold seats, so the seat invariant (ADR-026) holds. Free
// events only: priced ones would need an invoice per booking.
var eventSteps = slices.Concat([]step{
	{"event", `
INSERT INTO event (tenant_id, name, description, location, published, kind, timezone, slot_minutes, slot_capacity, buffer_minutes,
  booking_horizon_days, min_notice_hours, max_seats_per_booking, created_at)
SELECT $1,
  'Seed event ' || lpad(i::text, 5, '0') || ' — ' || (ARRAY['Pottery workshop','Yoga class','Wine tasting','Coding bootcamp','Photo walk',
    'Cooking class','Product demo','Consultation','Language exchange','Board game night'])[1 + i % 10],
  'A seeded demo event.',
  (ARRAY['Studio A','Main hall','Online','Room 2','Rooftop'])[1 + i % 5],
  i % 10 <> 0,
  CASE WHEN i % 5 = 0 THEN 'appointment' ELSE 'sessions' END,
  'Europe/Paris', 30,
  CASE WHEN i % 5 = 0 THEN 100 ELSE 1 END, -- generous slot capacity: seeded slot bookings may share a slot
  0, 365, 2, 10,
  now() - interval '400 days' + i * interval '1 minute'
FROM generate_series(1, greatest($2 / 100, 2)) AS i`},

	{"", `
CREATE TEMP TABLE seed_events ON COMMIT DROP AS
SELECT row_number() OVER (PARTITION BY kind ORDER BY name) AS idx, id, kind
FROM event WHERE tenant_id = $1 AND name LIKE 'Seed event %' AND $2::int IS NOT NULL`},
	// idx counts per kind, hence a (kind, idx) index rather than analyze()'s (idx).
	{sql: "CREATE UNIQUE INDEX ON seed_events (kind, idx)"},
	{sql: "ANALYZE seed_events"},
	{sql: "ANALYZE event"},
}, []step{

	{"event_availability", `
INSERT INTO event_availability (tenant_id, event_id, weekday, from_time, to_time)
SELECT $1, e.id, d, '09:00', '17:00'
FROM seed_events e CROSS JOIN generate_series(1, 5) AS d
WHERE e.kind = 'appointment' AND $2::int IS NOT NULL`},

	{"event_session", `
INSERT INTO event_session (tenant_id, event_id, starts_at, ends_at, capacity, seats_taken, created_at)
SELECT $1, e.id, t.start, t.start + interval '2 hours', 40 + (i * 31) % 41, 0, t.start - interval '30 days'
FROM generate_series(0, $2 / 10 - 1) AS i
CROSS JOIN LATERAL (SELECT count(*) AS n FROM seed_events WHERE kind = 'sessions') ec
JOIN seed_events e ON e.kind = 'sessions' AND e.idx = 1 + i % ec.n
CROSS JOIN LATERAL (SELECT date_trunc('day', now()) - interval '180 days' + ((i::bigint * 7919) % 360) * interval '1 day'
  + (9 + i % 9) * interval '1 hour' AS start) t`},

	{"", `
CREATE TEMP TABLE seed_sessions ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY id) AS idx, id, event_id, starts_at
FROM event_session WHERE tenant_id = $1 AND $2::int IS NOT NULL
  AND event_id IN (SELECT id FROM seed_events)`},
}, analyze("seed_sessions", "event_session"), []step{

	// Session bookings: (i × 7919) mod sessions walks every session once per round.
	{"event_booking", `
INSERT INTO event_booking (tenant_id, event_id, session_id, seats, email, name, contact_id, status, cancel_token, starts_at, cancelled_at, created_at)
SELECT $1, s.event_id, s.id, 1 + i % 2, c.email, c.name, c.id, st.status,
  encode(sha256(convert_to($1::uuid::text || ':seed-booking:' || i, 'UTF8')), 'hex'),
  s.starts_at,
  CASE WHEN st.status = 'cancelled' THEN least(now(), s.starts_at - interval '3 days') END,
  least(now(), s.starts_at - interval '10 days')
FROM generate_series(1, $2 - $2 / 10) AS i
CROSS JOIN LATERAL (SELECT count(*) AS n FROM seed_sessions) sc
JOIN seed_sessions s ON s.idx = 1 + (i::bigint * 7919) % sc.n
JOIN seed_contacts c ON c.idx = 1 + (i::bigint * 104729) % $2
CROSS JOIN LATERAL (SELECT CASE
  WHEN s.starts_at > now() THEN CASE WHEN i % 10 = 0 THEN 'cancelled' ELSE 'confirmed' END
  WHEN i % 20 < 14 THEN 'attended' WHEN i % 20 < 17 THEN 'no_show' ELSE 'cancelled' END AS status) st`},

	// Appointment bookings: a 30-minute slot on a weekday, 09:00–16:30 Paris
	// time, in the 26 weeks around now.
	{"event_booking", `
INSERT INTO event_booking (tenant_id, event_id, slot_start, slot_end, seats, email, name, contact_id, status, cancel_token, starts_at, cancelled_at, created_at)
SELECT $1, e.id, t.start, t.start + interval '30 minutes', 1, c.email, c.name, c.id, st.status,
  encode(sha256(convert_to($1::uuid::text || ':seed-slot:' || i, 'UTF8')), 'hex'),
  t.start,
  CASE WHEN st.status = 'cancelled' THEN least(now(), t.start - interval '1 day') END,
  least(now(), t.start - interval '5 days')
FROM generate_series(1, $2 / 10) AS i
CROSS JOIN LATERAL (SELECT count(*) AS n FROM seed_events WHERE kind = 'appointment') ec
JOIN seed_events e ON e.kind = 'appointment' AND e.idx = 1 + i % ec.n
JOIN seed_contacts c ON c.idx = 1 + (i::bigint * 15485863) % $2
CROSS JOIN LATERAL (SELECT ((date_trunc('week', now() AT TIME ZONE 'Europe/Paris')::date + ((i / 5) % 52 - 26) * 7 + i % 5)::timestamp
  + ((i / 260) % 16) * interval '30 minutes' + interval '9 hours') AT TIME ZONE 'Europe/Paris' AS start) t
CROSS JOIN LATERAL (SELECT CASE
  WHEN t.start > now() THEN CASE WHEN i % 10 = 0 THEN 'cancelled' ELSE 'confirmed' END
  WHEN i % 20 < 14 THEN 'attended' WHEN i % 20 < 17 THEN 'no_show' ELSE 'cancelled' END AS status) st`},

	{"", `
UPDATE event_session s SET seats_taken = b.seats
FROM (SELECT session_id, sum(seats) AS seats FROM event_booking
      WHERE tenant_id = $1 AND session_id IS NOT NULL AND status IN ('confirmed', 'attended', 'no_show') GROUP BY session_id) b
WHERE s.id = b.session_id AND s.tenant_id = $1 AND $2::int IS NOT NULL`},
}, analyze2("event_booking"))
