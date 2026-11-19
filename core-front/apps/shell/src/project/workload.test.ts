import { describe, expect, it } from 'vitest'
import { loadLevel, mondayOf, spreadWorkload } from './workload'

// A fixed 8-week window: the Mondays 2026-10-05 (a Monday) through
// 2026-11-23; the window itself runs Mon 2026-10-05 .. Sun 2026-11-29.
const WEEKS = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']
const task = (id: string, start: string, end: string, hours: number, assignees: string[]) => ({ id, start, end, hours, assignees })

describe('spreadWorkload', () => {
  it('10 h over Mon–Fri of one week land fully in that week', () => {
    const map = spreadWorkload([task('t1', '2026-10-05', '2026-10-09', 10, ['u1'])], WEEKS)
    expect(map.get('u1')).toEqual([10, 0, 0, 0, 0, 0, 0, 0])
  })

  it('a task spanning 2 weeks of 5 working days each splits 5 + 5', () => {
    // Mon 2026-10-05 .. Fri 2026-10-16: 10 working days, 1 h each.
    const map = spreadWorkload([task('t1', '2026-10-05', '2026-10-16', 10, ['u1'])], WEEKS)
    expect(map.get('u1')).toEqual([5, 5, 0, 0, 0, 0, 0, 0])
  })

  it('two assignees each get half the task hours', () => {
    const map = spreadWorkload([task('t1', '2026-10-05', '2026-10-09', 10, ['u1', 'u2'])], WEEKS)
    expect(map.get('u1')).toEqual([5, 0, 0, 0, 0, 0, 0, 0])
    expect(map.get('u2')).toEqual([5, 0, 0, 0, 0, 0, 0, 0])
    // No other row: the split does not invent an unassigned share.
    expect(map.has('')).toBe(false)
  })

  it('a weekend-only task lands its hours on the following Monday week', () => {
    // Sat 2026-10-10 .. Sun 2026-10-11 hold no working day: the whole 10 h
    // move to the Monday 2026-10-12, i.e. the second week. Never dropped,
    // never divided by zero.
    const map = spreadWorkload([task('t1', '2026-10-10', '2026-10-11', 10, ['u1'])], WEEKS)
    expect(map.get('u1')).toEqual([0, 10, 0, 0, 0, 0, 0, 0])
  })

  it('hours outside the window are dropped', () => {
    // Mon 2026-10-05 .. Fri 2026-11-06: 25 working days over 5 weeks at 1 h
    // each, but only the first 4 weeks are inside the 4-week window: 20 h
    // stay, the last week's 5 h are dropped.
    const map = spreadWorkload([task('t1', '2026-10-05', '2026-11-06', 25, ['u1'])], WEEKS.slice(0, 4))
    expect(map.get('u1')).toEqual([5, 5, 5, 5])
    // A task fully before the window contributes nothing at all.
    const before = spreadWorkload([task('t2', '2026-09-07', '2026-09-11', 10, ['u2'])], WEEKS)
    expect(before.has('u2')).toBe(false)
  })

  it('a task without assignees lands its hours on the Unassigned row', () => {
    const map = spreadWorkload([task('t1', '2026-10-05', '2026-10-09', 6, [])], WEEKS)
    expect(map.get('')).toEqual([6, 0, 0, 0, 0, 0, 0, 0])
  })

  it('a weekend-only task at the window edge with its fallback Monday outside the window is dropped', () => {
    // Sat 2026-11-28 / Sun 2026-11-29 are the window's last two days: the
    // following Monday (2026-12-06) is beyond the window, so the hours are
    // dropped — they are shown once the window moves on.
    const map = spreadWorkload([task('t1', '2026-11-28', '2026-11-29', 10, ['u1'])], WEEKS)
    expect(map.get('u1')).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })
})

describe('loadLevel', () => {
  it('colors cells by load/capacity: ≤ 0.8 neutral, ≤ 1.0 warning, > 1.0 error', () => {
    expect(loadLevel(20, 40)).toBe('neutral') // 0.5
    expect(loadLevel(32, 40)).toBe('neutral') // exactly 0.8
    expect(loadLevel(35, 40)).toBe('warning') // 0.875
    expect(loadLevel(40, 40)).toBe('warning') // exactly 1.0
    expect(loadLevel(41, 40)).toBe('error')
    expect(loadLevel(60, 40)).toBe('error')
  })
})

describe('mondayOf', () => {
  it('returns the Monday of the week containing the date, as ISO', () => {
    expect(mondayOf(new Date('2026-11-17T10:00:00'))).toBe('2026-11-16') // Tuesday
    expect(mondayOf(new Date('2026-11-22T08:00:00'))).toBe('2026-11-16') // Sunday
    expect(mondayOf(new Date('2026-11-16T08:00:00'))).toBe('2026-11-16') // Monday itself
  })
})
