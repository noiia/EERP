// The light seed's large Project demo (dev-seed.ts seedProjectPlan): the task tree and
// dependency network of a plan project, for the WBS and PERT views. Kept apart from
// dev-seed.ts because a 'use server' file may only export async functions.

/** Large projects for the WBS/PERT views (buildProjectPlan): hundreds of tasks each. */
export const PROJECT_PLAN_DEMOS = ['Platform migration', 'Factory expansion']
const PLAN_PHASES = ['Discovery', 'Design', 'Foundations', 'Build I', 'Build II', 'Integration', 'Testing', 'Hardening', 'Rollout', 'Handover']
const PLAN_PACKAGES = ['Scope', 'Specify', 'Prototype', 'Implement', 'Review', 'Sign-off']
const PLAN_STEPS = ['Prepare', 'Execute', 'Verify']
/** Phases before this one are done (in the past, closed stage); the next two are in progress. */
export const PLAN_DONE_PHASES = 3

/** One plan project's tasks, by level, and its dependencies as [blocker, dependent] keys.
 * Keys: phase "p", package "p.j", step "p.j.k" (0-based). Each package chains its 2–3 steps;
 * inside a phase two tracks (packages 0-2-4 and 1-3-5) chain step to step; a phase hands over
 * crosswise from its last two packages to the next phase's first two; the phases chain too. */
interface PlanTask { key: string; p: number; parent?: string; name: string; date_start: string; deadline: string; planned_hours?: number }

export function buildProjectPlan(now = Date.now()): { phases: PlanTask[]; packages: PlanTask[]; leaves: PlanTask[]; links: [string, string][] } {
  const day = 86_400_000
  const base = now - PLAN_DONE_PHASES * 14 * day
  const at = (days: number) => new Date(base + days * day).toISOString()
  const steps = (p: number, j: number) => 2 + ((p + j) % 2)
  const phases = PLAN_PHASES.map((name, p) => ({ key: `${p}`, p, name, date_start: at(p * 14), deadline: at(p * 14 + 13) }))
  const packages = phases.flatMap(({ p }) =>
    PLAN_PACKAGES.map((name, j) => ({ key: `${p}.${j}`, parent: `${p}`, p, name: `${PLAN_PHASES[p]}: ${name}`, date_start: at(p * 14 + j * 2), deadline: at(p * 14 + j * 2 + steps(p, j)) })),
  )
  const leaves = packages.flatMap(({ key, p, name }, i) => {
    const j = i % PLAN_PACKAGES.length
    return Array.from({ length: steps(p, j) }, (_, k) => ({
      key: `${key}.${k}`,
      parent: key,
      p,
      name: `${name.split(': ')[1]} – ${PLAN_STEPS[k]}`,
      planned_hours: 4 + ((p + j + k) % 5) * 2,
      date_start: at(p * 14 + j * 2 + k),
      deadline: at(p * 14 + j * 2 + k + 1),
    }))
  })
  const first = (p: number, j: number) => `${p}.${j}.0`
  const last = (p: number, j: number) => `${p}.${j}.${steps(p, j) - 1}`
  const links: [string, string][] = []
  for (let p = 0; p < PLAN_PHASES.length; p++) {
    for (let j = 0; j < PLAN_PACKAGES.length; j++) {
      for (let k = 1; k < steps(p, j); k++) links.push([`${p}.${j}.${k - 1}`, `${p}.${j}.${k}`])
      if (j + 2 < PLAN_PACKAGES.length) links.push([last(p, j), first(p, j + 2)])
    }
    if (p + 1 < PLAN_PHASES.length) {
      const [a, b] = [PLAN_PACKAGES.length - 2, PLAN_PACKAGES.length - 1]
      links.push([last(p, a), first(p + 1, 0)], [last(p, b), first(p + 1, 1)], [last(p, a), first(p + 1, 1)], [last(p, b), first(p + 1, 0)])
      links.push([`${p}`, `${p + 1}`])
    }
  }
  return { phases, packages, leaves, links }
}
