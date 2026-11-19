import { MyDay } from '@/project/MyDay'
import { requireProjectPage } from '@/project/pages'

// My day: the caller's open assigned tasks, grouped by deadline, with quick
// actions (log time, mark done). The route lives in the project module's
// views (gate + Planning menu line); this page does the rendering.
export default async function MyDayPage() {
  await requireProjectPage('/project/my-day')
  return <MyDay />
}
