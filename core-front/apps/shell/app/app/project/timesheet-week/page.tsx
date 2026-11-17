import { Suspense } from 'react'
import { TimesheetWeek } from '@/project/TimesheetWeek'
import { requireProjectPage } from '@/project/pages'

// Timesheet week: a Mon–Sun grid of my logged tasks plus my open assigned
// tasks, edited in place. The route lives in the project module's views
// (gate + Planning menu line); this page does the rendering. useSearchParams
// (the ?week= param) needs a Suspense boundary.
export default async function TimesheetWeekPage() {
  const identity = await requireProjectPage('/project/timesheet-week')
  return (
    <Suspense fallback={null}>
      <TimesheetWeek userId={identity.userId} />
    </Suspense>
  )
}
