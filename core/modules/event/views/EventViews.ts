import {
  FORM_NOTEBOOK_ID,
  registerHeaderButtonAction,
  registerHeaderMenu,
  useEntityRefreshStore,
  type FrontModule,
  type HeaderButtonDescriptor,
  type Operation,
  type ViewDescriptor,
} from '@eerp/core-front'

// event frontend — DESCRIPTORS ONLY. Entities map 1:1 to the Go route prefixes
// (event, event_session, event_availability, event_booking); permissions
// mirror the route (<table>:<table>:<action>). Routes live under /website/…
// so they belong to the Website app: the top bar picks the current module's
// menus by the path's first segment, hence registerHeaderMenu('website', …)
// below instead of an app of their own.
//
// Seat accounting is Go's (core/modules/event/handler.go): a booking POST goes
// through the booking service, a PUT only changes name/phone or cancels, a
// DELETE is refused — so the booking form never offers delete, and cancelling
// is a header button.

/** An event as served by Go's /event endpoints. */
export interface Event {
  id: string
  name: string
  description?: string | null
  location?: string | null
  published?: boolean | null
  kind: 'sessions' | 'appointment'
  timezone: string
  slot_minutes: number
  slot_capacity: number
  buffer_minutes?: number | null
  booking_horizon_days: number
  min_notice_hours: number
  max_seats_per_booking: number
}

const isAppointment = { field: 'kind', op: 'eq', value: 'appointment' } as const
const isSessions = { field: 'kind', op: 'eq', value: 'sessions' } as const

// Defaults mirror Go's eventDefaults (validate.go): the form sends every
// field, so a number's zero default would otherwise fail Go's ranges.
const eventListFields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'kind', label: 'Kind', type: 'selection', selection: { options: ['sessions', 'appointment'] } },
  { name: 'location', label: 'Location', type: 'text' },
  { name: 'published', label: 'Published', type: 'boolean', widget: 'switch' },
]

const eventFormFields: ViewDescriptor['fields'] = [
  ...eventListFields,
  { name: 'timezone', label: 'Time zone (IANA, e.g. Europe/Paris)', type: 'text', required: true, default: 'Europe/Paris' },
  { name: 'max_seats_per_booking', label: 'Max seats per booking', type: 'number', widget: 'int', default: 10 },
  { name: 'slot_minutes', label: 'Slot length (minutes)', type: 'number', widget: 'int', default: 30, states: { visible: isAppointment } },
  { name: 'slot_capacity', label: 'Seats per slot', type: 'number', widget: 'int', default: 1, states: { visible: isAppointment } },
  { name: 'buffer_minutes', label: 'Buffer between slots (minutes)', type: 'number', widget: 'int', states: { visible: isAppointment } },
  { name: 'booking_horizon_days', label: 'Bookable up to (days ahead)', type: 'number', widget: 'int', default: 60, states: { visible: isAppointment } },
  { name: 'min_notice_hours', label: 'Minimum notice (hours)', type: 'number', widget: 'int', default: 2, states: { visible: isAppointment } },
  { name: 'description', label: 'Description', type: 'text', widget: 'long' },
  {
    name: 'sessions',
    label: 'Sessions',
    type: 'relation',
    relation: { entity: 'event_session', kind: 'one2many', inverseField: 'event_id', labelField: 'starts_at', formPath: '/website/sessions/:id' },
    widgetOptions: {
      deletable: true,
      columns: [
        { key: 'ends_at', label: 'End' },
        { key: 'capacity', label: 'Capacity' },
        { key: 'seats_taken', label: 'Seats taken' },
      ],
    },
    states: { visible: isSessions },
  },
  {
    name: 'repeat_weeks',
    label: 'Weekly copies to add (Repeat weekly)',
    type: 'number',
    widget: 'int',
    store: false,
    default: 4,
    states: { visible: isSessions },
  },
  {
    name: 'availability',
    label: 'Weekly availability',
    type: 'relation',
    relation: { entity: 'event_availability', kind: 'one2many', inverseField: 'event_id', labelField: 'weekday', formPath: '/website/availability/:id' },
    widgetOptions: {
      deletable: true,
      columns: [
        { key: 'from_time', label: 'From' },
        { key: 'to_time', label: 'To' },
      ],
    },
    states: { visible: isAppointment },
  },
  {
    name: 'bookings',
    label: 'Bookings',
    type: 'relation',
    relation: { entity: 'event_booking', kind: 'one2many', inverseField: 'event_id', labelField: 'name', formPath: '/website/bookings/:id' },
    widgetOptions: {
      columns: [
        { key: 'email', label: 'Email' },
        { key: 'seats', label: 'Seats' },
        { key: 'status', label: 'Status' },
      ],
    },
  },
]

// "Repeat weekly": copies the latest session `repeat_weeks` times (a display-
// only field beside the sessions table), one week apart. Weeks are added in
// UTC, so a copy crossing a DST change keeps its UTC time (one hour off in
// local time) — staff adjust by hand; acceptable for v1.
registerHeaderButtonAction({
  entity: 'event',
  name: 'event.duplicateWeekly',
  handler: async (ctx) => {
    const ops = ctx.relationOps
    const n = Number(ctx.draft.repeat_weeks)
    if (!ops || !Number.isInteger(n) || n < 1 || n > 52) return
    const sessions = await ops.list('event_session', { filter: { event_id: ctx.recordId }, pageSize: 200 })
    const latest = [...sessions].sort((a, b) => Date.parse(String(b.starts_at)) - Date.parse(String(a.starts_at)))[0]
    if (!latest) return
    const week = 7 * 24 * 3600 * 1000
    for (let i = 1; i <= n; i++) {
      await ops.create('event_session', {
        event_id: ctx.recordId,
        starts_at: new Date(Date.parse(String(latest.starts_at)) + i * week).toISOString(),
        ends_at: new Date(Date.parse(String(latest.ends_at)) + i * week).toISOString(),
        capacity: latest.capacity,
        price: latest.price ?? null,
      })
    }
    useEntityRefreshStore.getState().bump('event_session')
  },
})

const eventHeaderButtons: HeaderButtonDescriptor[] = [
  {
    name: 'event.duplicateWeekly',
    label: 'Repeat weekly',
    variant: 'secondary',
    states: { visible: { all: [{ field: 'id', op: 'set' }, isSessions] } },
  },
]

// Sessions / Availability / Bookings each get their own notebook page, after
// the synthesized Settings page (description).
export const eventPagesOperations: Operation[] = [
  { op: 'addNode', node: { kind: 'page', title: 'Sessions', children: [{ kind: 'field', name: 'sessions' }, { kind: 'field', name: 'repeat_weeks' }] }, target: FORM_NOTEBOOK_ID, position: 'first' },
  { op: 'addNode', node: { kind: 'page', title: 'Availability', children: [{ kind: 'field', name: 'availability' }] }, target: FORM_NOTEBOOK_ID, position: 'first' },
  { op: 'addNode', node: { kind: 'page', title: 'Bookings', children: [{ kind: 'field', name: 'bookings' }] }, target: FORM_NOTEBOOK_ID, position: 'last' },
]

const sessionFields: ViewDescriptor['fields'] = [
  { name: 'event_id', label: 'Event', type: 'relation', required: true, relation: { entity: 'event', kind: 'many2one', labelField: 'name', filter: { kind: 'sessions' } } },
  { name: 'starts_at', label: 'Start', type: 'date', widget: 'datetime', required: true },
  { name: 'ends_at', label: 'End', type: 'date', widget: 'datetime', required: true },
  { name: 'capacity', label: 'Capacity', type: 'number', widget: 'int', default: 10 },
  { name: 'seats_taken', label: 'Seats taken', type: 'number', widget: 'int', readOnly: true },
  { name: 'price', label: 'Price (display only)', type: 'number', widget: 'monetary' },
]

const availabilityFields: ViewDescriptor['fields'] = [
  { name: 'event_id', label: 'Event', type: 'relation', required: true, relation: { entity: 'event', kind: 'many2one', labelField: 'name', filter: { kind: 'appointment' } } },
  { name: 'weekday', label: 'Weekday (0 = Sunday … 6 = Saturday)', type: 'number', widget: 'int', default: 1 },
  { name: 'from_time', label: 'From (HH:MM)', type: 'text', required: true, default: '09:00' },
  { name: 'to_time', label: 'To (HH:MM)', type: 'text', required: true, default: '17:00' },
]

const bookingListFields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'email', label: 'Email', type: 'text', required: true },
  { name: 'seats', label: 'Seats', type: 'number', widget: 'int', default: 1 },
  { name: 'status', label: 'Status', type: 'selection', selection: { options: ['confirmed', 'cancelled'] }, readOnly: true },
  { name: 'slot_start', label: 'Slot', type: 'date', widget: 'datetime' },
  { name: 'created_at', label: 'Booked on', type: 'date', widget: 'datetime', readOnly: true },
]

// A booking targets EITHER a session (sessions events) or a slot start
// (appointment events); Go rejects anything else with a 400.
const bookingFormFields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'event_id', label: 'Event', type: 'relation', required: true, relation: { entity: 'event', kind: 'many2one', labelField: 'name' } },
  { name: 'session_id', label: 'Session', type: 'relation', relation: { entity: 'event_session', kind: 'many2one', labelField: 'starts_at' } },
  { name: 'slot_start', label: 'Slot start (appointments)', type: 'date', widget: 'datetime' },
  { name: 'seats', label: 'Seats', type: 'number', widget: 'int', default: 1 },
  { name: 'email', label: 'Email', type: 'text', required: true },
  { name: 'phone', label: 'Phone', type: 'text', widget: 'phone' },
  { name: 'status', label: 'Status', type: 'selection', selection: { options: ['confirmed', 'cancelled'] }, readOnly: true },
  { name: 'contact_id', label: 'Contact', type: 'relation', readOnly: true, relation: { entity: 'contact', kind: 'many2one', labelField: 'name' } },
  { name: 'cancelled_at', label: 'Cancelled on', type: 'date', widget: 'datetime', readOnly: true },
]

registerHeaderButtonAction({
  entity: 'event_booking',
  name: 'event.cancelBooking',
  handler: async (ctx) => {
    await ctx.setFieldAndCommit({ status: 'cancelled' })
  },
})

const bookingHeaderButtons: HeaderButtonDescriptor[] = [
  {
    name: 'event.cancelBooking',
    label: 'Cancel booking',
    variant: 'secondary',
    states: { visible: { all: [{ field: 'id', op: 'set' }, { field: 'status', op: 'eq', value: 'confirmed' }] } },
  },
]

registerHeaderMenu('website', 'events', {
  label: 'Events',
  entries: [
    { kind: 'line', label: 'Events', path: '/website/events', permission: 'event:event:read' },
    { kind: 'line', label: 'Bookings', path: '/website/bookings', permission: 'event_booking:event_booking:read' },
  ],
})

const perm = (table: string) => [`${table}:${table}:read`]

const event: FrontModule = {
  name: 'event',
  routes: [
    {
      path: '/website/events',
      descriptor: { entity: 'event', viewType: 'tree', fields: eventListFields, formPath: '/website/events/:id', createPermission: 'event:event:write', permissions: perm('event') },
    },
    {
      path: '/website/events/:id',
      descriptor: { entity: 'event', viewType: 'form', fields: eventFormFields, headerButtons: eventHeaderButtons, permissions: perm('event') },
    },
    {
      path: '/website/sessions/:id',
      descriptor: { entity: 'event_session', viewType: 'form', fields: sessionFields, permissions: perm('event_session') },
    },
    {
      path: '/website/availability/:id',
      descriptor: { entity: 'event_availability', viewType: 'form', fields: availabilityFields, permissions: perm('event_availability') },
    },
    {
      path: '/website/bookings',
      descriptor: {
        entity: 'event_booking',
        viewType: 'tree',
        fields: bookingListFields,
        formPath: '/website/bookings/:id',
        createPermission: 'event_booking:event_booking:write',
        permissions: perm('event_booking'),
      },
    },
    {
      path: '/website/bookings/:id',
      descriptor: {
        entity: 'event_booking',
        viewType: 'form',
        fields: bookingFormFields,
        headerButtons: bookingHeaderButtons,
        statusBar: { field: 'status' },
        permissions: perm('event_booking'),
      },
    },
  ],
  extends: [{ path: '/website/events/:id', operations: eventPagesOperations }],
}

export default event
