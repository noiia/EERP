// Pure helpers for the workload heatmap (the Workload page spreads each open
// task's planned hours over the Mon–Fri workdays of its span, per assignee).

/** Format a date as ISO YYYY-MM-DD (local time). */
export function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The Monday of the week containing `d`, as ISO. */
export function mondayOf(d: Date): string {
  const x = new Date(d)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return toIso(x)
}

/** The ISO date `days` after (or before, when negative) `iso`. */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return toIso(new Date(y, m - 1, d + days))
}

export type LoadLevel = 'neutral' | 'warning' | 'error'

/** Cell color by weekly load vs capacity: ≤ 80% neutral, ≤ 100% warning, above error. */
export function loadLevel(hours: number, capacity: number): LoadLevel {
  const ratio = hours / capacity
  if (ratio <= 0.8) return 'neutral'
  if (ratio <= 1) return 'warning'
  return 'error'
}

/** The first Monday strictly after `iso`. */
function mondayAfter(iso: string): string {
  const next = new Date(`${addDaysIso(iso, 1)}T00:00:00`)
  return addDaysIso(toIso(next), (8 - next.getDay()) % 7)
}

export type WorkloadTask = { id: string; start: string; end: string; hours: number; assignees: string[] }

/**
 * Spread open tasks' planned hours over the window's weeks.
 *
 * The key is the assignee user id ('' is the Unassigned row); the value has
 * one entry per `weeks` item (the Monday of that week, as ISO). A task's
 * hours are divided over the Mon–Fri workdays of its full span [start, end]
 * — only the workdays inside the window [weeks[0], weeks[last] + 7) are
 * kept, so hours falling outside the window are dropped. A span with no
 * workday (a weekend-only task) lands its whole load on the first Monday
 * strictly after `end`, when that Monday is inside the window (else the
 * hours are dropped). Each assignee gets an equal share; a task without
 * assignees goes to the '' row.
 */
export function spreadWorkload(tasks: WorkloadTask[], weeks: string[]): Map<string, number[]> {
  const map = new Map<string, number[]>()
  if (weeks.length === 0) return map
  const windowStart = weeks[0]
  const windowEnd = addDaysIso(weeks[weeks.length - 1], 7) // exclusive
  const inWindow = (day: string) => day >= windowStart && day < windowEnd
  const weekIndex = (day: string): number => {
    const a = new Date(`${windowStart}T00:00:00`).getTime()
    const b = new Date(`${day}T00:00:00`).getTime()
    return Math.floor((b - a) / (7 * 86_400_000))
  }
  const bump = (key: string, index: number, hours: number) => {
    let row = map.get(key)
    if (!row) {
      row = new Array(weeks.length).fill(0)
      map.set(key, row)
    }
    row[index] += hours
  }
  for (const task of tasks) {
    if (!task.start || !task.end) continue
    // A task whose span does not overlap the window contributes no row at
    // all (the list query already keeps such tasks out of the read).
    if (!(task.start < windowEnd && task.end >= windowStart)) continue
    // Mon–Fri workdays of the full span.
    const days: string[] = []
    for (let d = new Date(`${task.start}T00:00:00`); toIso(d) <= task.end; d.setDate(d.getDate() + 1)) {
      if (d.getDay() >= 1 && d.getDay() <= 5) days.push(toIso(d))
    }
    const keys = task.assignees.length > 0 ? task.assignees : ['']
    if (days.length === 0) {
      // Weekend-only span: the whole load moves to the following Monday
      // (dropped when that Monday is beyond the window).
      const monday = mondayAfter(task.end)
      if (inWindow(monday)) {
        for (const key of keys) bump(key, weekIndex(monday), task.hours / keys.length)
      }
    } else {
      const perDay = task.hours / days.length
      for (const key of keys) {
        for (const day of days) {
          if (inWindow(day)) bump(key, weekIndex(day), perDay / keys.length)
        }
      }
    }
    // The task is active in the window, so its rows exist even when no hour
    // landed in it (a weekend-only span at the window edge).
    for (const key of keys) map.set(key, map.get(key) ?? new Array(weeks.length).fill(0))
  }
  return map
}
