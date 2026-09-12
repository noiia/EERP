import { describe, expect, it } from 'vitest'
import {
  aggregate,
  bucketKey,
  MAX_PIE_SLICES,
  niceTicks,
  OTHER_LABEL,
  pieSlices,
  statValue,
  toNumber,
  xyPoints,
  xySeries,
} from './graph-aggregate'

describe('toNumber', () => {
  it('accepts a finite number as-is', () => {
    expect(toNumber(42)).toBe(42)
    expect(toNumber(-3.5)).toBe(-3.5)
  })
  it('parses a numeric string', () => {
    expect(toNumber('42')).toBe(42)
    expect(toNumber('  3.5  ')).toBe(3.5)
  })
  it('rejects non-numeric, NaN, Infinity, null, undefined, empty string', () => {
    expect(toNumber('abc')).toBeNull()
    expect(toNumber('')).toBeNull()
    expect(toNumber(NaN)).toBeNull()
    expect(toNumber(Infinity)).toBeNull()
    expect(toNumber(null)).toBeNull()
    expect(toNumber(undefined)).toBeNull()
  })
})

describe('aggregate', () => {
  it('count is the length, ignoring values', () => {
    expect(aggregate([1, 2, 3], 'count')).toBe(3)
    expect(aggregate([], 'count')).toBe(0)
  })
  it('sum adds', () => {
    expect(aggregate([1, 2, 3], 'sum')).toBe(6)
    expect(aggregate([], 'sum')).toBe(0)
  })
  it('avg and mean are the same math', () => {
    expect(aggregate([1, 2, 3, 4], 'avg')).toBe(2.5)
    expect(aggregate([1, 2, 3, 4], 'mean')).toBe(2.5)
    expect(aggregate([], 'mean')).toBe(0)
  })
  it('median sorts for the real middle value, odd count', () => {
    expect(aggregate([5, 1, 3], 'median')).toBe(3)
  })
  it('median averages the two middles on an even count', () => {
    expect(aggregate([1, 2, 3, 4], 'median')).toBe(2.5)
  })
  it('median is unaffected by input order (proves it sorts, not indexes blindly)', () => {
    expect(aggregate([100, 1, 2, 3, 4], 'median')).toBe(3)
  })
  it('median of empty is 0', () => {
    expect(aggregate([], 'median')).toBe(0)
  })
})

describe('bucketKey', () => {
  it('day returns the date unchanged', () => {
    expect(bucketKey('2024-03-15', 'day')).toBe('2024-03-15')
  })
  it('month truncates to year-month', () => {
    expect(bucketKey('2024-03-15', 'month')).toBe('2024-03')
  })
  it('week buckets to that week\'s Monday', () => {
    // 2024-03-15 is a Friday; Monday of that week is 2024-03-11.
    expect(bucketKey('2024-03-15', 'week')).toBe('2024-03-11')
    // A Monday buckets to itself.
    expect(bucketKey('2024-03-11', 'week')).toBe('2024-03-11')
    // A Sunday belongs to the PRECEDING Monday's week, not the next one.
    expect(bucketKey('2024-03-17', 'week')).toBe('2024-03-11')
  })
  it('handles a week bucket that crosses a month boundary', () => {
    // 2024-03-01 is a Friday; that week's Monday is 2024-02-26.
    expect(bucketKey('2024-03-01', 'week')).toBe('2024-02-26')
  })
  it('returns null for a non-date string', () => {
    expect(bucketKey('not-a-date', 'day')).toBeNull()
    expect(bucketKey('', 'month')).toBeNull()
  })
})

interface Deal {
  id: string
  closed_at?: string | null
  amount?: number | null
  status?: string | null
}

describe('xyPoints', () => {
  const records: Deal[] = [
    { id: '1', closed_at: '2024-01-05', amount: 100 },
    { id: '2', closed_at: '2024-01-20', amount: 50 },
    { id: '3', closed_at: '2024-02-10', amount: 200 },
    { id: '4', closed_at: null, amount: 999 }, // no date -> skipped
    { id: '5', closed_at: '2024-02-11', amount: null }, // no y value -> skipped
  ]

  it('buckets and aggregates yField per xField bucket, sorted chronologically', () => {
    expect(
      xyPoints(records, { xField: 'closed_at', yField: 'amount', aggregate: 'sum', bucket: 'month' }),
    ).toEqual([
      { bucket: '2024-01', value: 150 },
      { bucket: '2024-02', value: 200 },
    ])
  })

  it('supports avg and count aggregates', () => {
    expect(
      xyPoints(records, { xField: 'closed_at', yField: 'amount', aggregate: 'avg', bucket: 'month' }),
    ).toEqual([
      { bucket: '2024-01', value: 75 },
      { bucket: '2024-02', value: 200 },
    ])
    expect(
      xyPoints(records, { xField: 'closed_at', yField: 'amount', aggregate: 'count', bucket: 'month' }),
    ).toEqual([
      { bucket: '2024-01', value: 2 },
      { bucket: '2024-02', value: 1 },
    ])
  })

  it('skips records with no date or no numeric y value', () => {
    const points = xyPoints(records, { xField: 'closed_at', yField: 'amount', aggregate: 'sum', bucket: 'day' })
    expect(points.reduce((n, p) => n + p.value, 0)).toBe(350) // 100+50+200, never 999
  })

  it('returns an empty array when nothing matches', () => {
    expect(xyPoints([], { xField: 'closed_at', yField: 'amount', aggregate: 'sum', bucket: 'day' })).toEqual([])
  })
})

describe('xySeries', () => {
  const records: Deal[] = [
    { id: '1', closed_at: '2024-01-05', amount: 100, status: 'won' },
    { id: '2', closed_at: '2024-01-20', amount: 50, status: 'lost' },
    { id: '3', closed_at: '2024-02-10', amount: 200, status: 'won' },
    { id: '4', closed_at: '2024-02-11', amount: 999, status: null }, // no series value -> skipped
  ]

  it('with no seriesField, returns a single implicit series identical to xyPoints', () => {
    const result = xySeries(records, { xField: 'closed_at', yField: 'amount', aggregate: 'sum', bucket: 'month' })
    expect(result).toEqual([
      {
        label: '',
        points: xyPoints(records, { xField: 'closed_at', yField: 'amount', aggregate: 'sum', bucket: 'month' }),
      },
    ])
  })

  it('with a seriesField, splits into one series per distinct value, each independently aggregated', () => {
    const result = xySeries(records, {
      xField: 'closed_at',
      yField: 'amount',
      seriesField: 'status',
      aggregate: 'sum',
      bucket: 'month',
    })
    expect(result).toEqual([
      { label: 'lost', points: [{ bucket: '2024-01', value: 50 }] },
      { label: 'won', points: [{ bucket: '2024-01', value: 100 }, { bucket: '2024-02', value: 200 }] },
    ])
  })

  it('skips records with no value in seriesField, never a phantom series', () => {
    const result = xySeries(records, {
      xField: 'closed_at',
      yField: 'amount',
      seriesField: 'status',
      aggregate: 'count',
      bucket: 'month',
    })
    expect(result.every((s) => s.label !== '' && s.label !== 'null')).toBe(true)
  })
})

describe('niceTicks', () => {
  it('returns [0] for a non-positive max', () => {
    expect(niceTicks(0)).toEqual([0])
    expect(niceTicks(-5)).toEqual([0])
  })

  it('picks round (1/2/5 × 10^n) steps, starting at 0, covering max', () => {
    const ticks = niceTicks(4)
    expect(ticks[0]).toBe(0)
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(4)
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]! - ticks[i - 1]!).toBeCloseTo(ticks[1]! - ticks[0]!)
    }
  })

  it('scales sensibly for a much larger max, staying within a handful of ticks', () => {
    const ticks = niceTicks(9500)
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(9500)
    expect(ticks.length).toBeLessThanOrEqual(6)
  })
})

describe('pieSlices', () => {
  const records: Deal[] = [
    { id: '1', status: 'open', amount: 100 },
    { id: '2', status: 'open', amount: 50 },
    { id: '3', status: 'won', amount: 200 },
    { id: '4', status: null, amount: 10 }, // no group value -> skipped
  ]

  it('sizes slices by record count per group, displayValue equal to count with no valueField', () => {
    expect(pieSlices(records, { groupByField: 'status' })).toEqual([
      { label: 'open', count: 2, displayValue: 2 },
      { label: 'won', count: 1, displayValue: 1 },
    ])
  })

  it('a valueField only changes displayValue (the tooltip) — slice SIZE stays count-based', () => {
    // 'won' has the bigger amount SUM (200 vs 150) but FEWER records (1 vs 2) —
    // sizing must follow record count, so 'open' (count 2) sorts/sizes first,
    // not 'won'. This is the exact bug report this test guards against: two
    // groups with one record each must always render as EQUAL slices, no
    // matter how their valueField sums compare.
    expect(pieSlices(records, { groupByField: 'status', valueField: 'amount' })).toEqual([
      { label: 'open', count: 2, displayValue: 150 },
      { label: 'won', count: 1, displayValue: 200 },
    ])
  })

  it('two groups with one record each are exactly equal-sized slices, regardless of their valueField values', () => {
    const twoCompanies: Deal[] = [
      { id: '1', status: 'Acme', amount: 3 },
      { id: '2', status: 'Michel Corp.', amount: 2 },
    ]
    const slices = pieSlices(twoCompanies, { groupByField: 'status', valueField: 'amount' })
    expect(slices.map((s) => s.count)).toEqual([1, 1])
    // The differing amounts still show up as the displayed (tooltip) value.
    expect(slices.find((s) => s.label === 'Acme')?.displayValue).toBe(3)
    expect(slices.find((s) => s.label === 'Michel Corp.')?.displayValue).toBe(2)
  })

  it('sorts slices descending by count', () => {
    const slices = pieSlices(records, { groupByField: 'status', valueField: 'amount' })
    expect(slices[0]?.label).toBe('open')
  })

  it('folds groups past MAX_PIE_SLICES into one OTHER_LABEL slice, keeping the largest COUNTS individually', () => {
    const many: Deal[] = []
    for (let i = 0; i < MAX_PIE_SLICES + 3; i++) {
      // Group i has (i + 1) records — distinct counts, so "largest kept" is
      // meaningful (unlike all-equal-count groups, where sort order would
      // just reflect insertion order).
      for (let j = 0; j <= i; j++) {
        many.push({ id: `${i}-${j}`, status: `g${i}` })
      }
    }
    const slices = pieSlices(many, { groupByField: 'status' })
    expect(slices).toHaveLength(MAX_PIE_SLICES)
    expect(slices[slices.length - 1]?.label).toBe(OTHER_LABEL)
    // 11 groups with counts 1..11. Top (MAX_PIE_SLICES - 1) = 7 kept
    // individually (counts 11..5), the remaining 4 smallest (counts 4,3,2,1)
    // fold together = 10.
    expect(slices[slices.length - 1]?.count).toBe(10)
  })
})

describe('statValue', () => {
  const records: Deal[] = [
    { id: '1', amount: 10 },
    { id: '2', amount: 20 },
    { id: '3', amount: 30 },
    { id: '4', amount: null },
  ]

  it('count ignores the field entirely — every record counts', () => {
    expect(statValue(records, { field: 'amount', aggregate: 'count' })).toBe(4)
  })

  it('mean/median/sum skip non-numeric values', () => {
    expect(statValue(records, { field: 'amount', aggregate: 'sum' })).toBe(60)
    expect(statValue(records, { field: 'amount', aggregate: 'mean' })).toBe(20)
    expect(statValue(records, { field: 'amount', aggregate: 'median' })).toBe(20)
  })
})
