import { Workload } from '@/project/Workload'
import { requireProjectPage } from '@/project/pages'

// Workload: the per-assignee x week heatmap of planned hours over the coming
// window (gate + Planning menu line live in the project module's views; this
// page does the rendering).
export default async function WorkloadPage() {
  await requireProjectPage('/project/workload')
  return <Workload />
}
