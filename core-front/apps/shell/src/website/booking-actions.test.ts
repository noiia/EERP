import { beforeEach, describe, expect, it, vi } from 'vitest'

const goSiteFetch = vi.hoisted(() => vi.fn())
vi.mock('./account', () => ({ goSiteFetch }))
const getJSON = vi.hoisted(() => vi.fn())
vi.mock('./public-api', () => ({ getJSON }))
const revalidateTag = vi.hoisted(() => vi.fn())
vi.mock('next/cache', () => ({ revalidateTag }))

import { cancelByToken, cancelMyBooking, claimByToken, fetchSlots, resendVerification, verifyEmail } from './booking-actions'

const form = (token?: string) => {
  const f = new FormData()
  if (token) f.set('token', token)
  return f
}
const status = (s: number) => new Response(null, { status: s === 204 ? 204 : s })

beforeEach(() => {
  goSiteFetch.mockReset()
  getJSON.mockReset()
  revalidateTag.mockReset()
})

describe('fetchSlots', () => {
  it('reads the cached slot window', async () => {
    getJSON.mockResolvedValueOnce({ data: [{ start: 's' }] })
    expect(await fetchSlots('e 1', 'a', 'b')).toEqual([{ start: 's' }])
    expect(getJSON).toHaveBeenCalledWith('/event/e%201/slots?from=a&to=b', ['event'])
    getJSON.mockResolvedValueOnce(null)
    expect(await fetchSlots('e', 'a', 'b')).toBeNull()
  })
})

describe('token actions', () => {
  it('cancelByToken maps statuses and expires the event cache on success', async () => {
    goSiteFetch.mockResolvedValueOnce(status(204))
    expect(await cancelByToken(null, form('t'))).toBe('ok')
    expect(goSiteFetch).toHaveBeenCalledWith('/website/bookings/cancel', { method: 'POST', body: '{"token":"t"}' }, 'none')
    expect(revalidateTag).toHaveBeenCalledWith('event', { expire: 0 })
    goSiteFetch.mockResolvedValueOnce(status(404))
    expect(await cancelByToken(null, form())).toBe('invalid')
    goSiteFetch.mockRejectedValueOnce(new Error('down'))
    expect(await cancelByToken(null, form('t'))).toBe('failed')
  })

  it('claimByToken answers taken on a 409', async () => {
    goSiteFetch.mockResolvedValueOnce(status(204))
    expect(await claimByToken(null, form('t'))).toBe('ok')
    goSiteFetch.mockResolvedValueOnce(status(404))
    expect(await claimByToken(null, form('t'))).toBe('invalid')
    goSiteFetch.mockResolvedValueOnce(status(409))
    expect(await claimByToken(null, form('t'))).toBe('taken')
    goSiteFetch.mockRejectedValueOnce(new Error('down'))
    expect(await claimByToken(null, form('t'))).toBe('failed')
  })

  it('verifyEmail needs the owner session', async () => {
    goSiteFetch.mockResolvedValueOnce(null)
    expect(await verifyEmail(null, form('t'))).toBe('session')
    goSiteFetch.mockResolvedValueOnce(status(401))
    expect(await verifyEmail(null, form('t'))).toBe('session')
    goSiteFetch.mockResolvedValueOnce(status(204))
    expect(await verifyEmail(null, form('t'))).toBe('ok')
    goSiteFetch.mockResolvedValueOnce(status(400))
    expect(await verifyEmail(null, form())).toBe('invalid')
    goSiteFetch.mockRejectedValueOnce(new Error('down'))
    expect(await verifyEmail(null, form('t'))).toBe('failed')
  })
})

describe('account booking actions', () => {
  it('resends the verification email', async () => {
    goSiteFetch.mockResolvedValueOnce(status(204))
    expect(await resendVerification()).toBe(true)
    goSiteFetch.mockRejectedValueOnce(new Error('down'))
    expect(await resendVerification()).toBe(false)
  })

  it("cancels the visitor's own booking", async () => {
    goSiteFetch.mockResolvedValueOnce(status(204))
    expect(await cancelMyBooking('b/1')).toBe(true)
    expect(goSiteFetch).toHaveBeenCalledWith('/website/me/bookings/b%2F1/cancel', { method: 'POST' })
    expect(revalidateTag).toHaveBeenCalled()
    goSiteFetch.mockResolvedValueOnce(status(404))
    expect(await cancelMyBooking('b')).toBe(false)
    goSiteFetch.mockRejectedValueOnce(new Error('down'))
    expect(await cancelMyBooking('b')).toBe(false)
  })
})
