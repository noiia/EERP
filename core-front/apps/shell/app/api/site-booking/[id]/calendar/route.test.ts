import { afterEach, expect, it, vi } from 'vitest'

const { goSiteFetch } = vi.hoisted(() => ({ goSiteFetch: vi.fn() }))
vi.mock('@/website/account', () => ({ goSiteFetch }))

import { GET } from './route'

afterEach(() => vi.clearAllMocks())
const call = () => GET(new Request('http://x/api/site-booking/b1/calendar'), { params: Promise.resolve({ id: 'b1' }) })

it("serves the visitor's booking as an .ics download", async () => {
  goSiteFetch.mockResolvedValue(new Response('BEGIN:VCALENDAR', { status: 200 }))
  const res = await call()
  expect(goSiteFetch).toHaveBeenCalledWith('/website/me/bookings/b1/calendar.ics')
  expect(res.headers.get('Content-Type')).toContain('text/calendar')
  expect(await res.text()).toBe('BEGIN:VCALENDAR')
})

it("passes Go's 404 through and answers 401 without a site session", async () => {
  goSiteFetch.mockResolvedValueOnce(new Response(null, { status: 404 }))
  expect((await call()).status).toBe(404)
  goSiteFetch.mockResolvedValueOnce(null)
  expect((await call()).status).toBe(401)
})
