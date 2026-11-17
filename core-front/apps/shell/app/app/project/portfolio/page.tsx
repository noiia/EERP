import { Portfolio } from '@/project/Portfolio'
import { requireProjectPage } from '@/project/pages'

// Portfolio: the visible active projects as one bubble each (x = % tasks
// done, y = % hours used, size = planned hours, color = the worst risk band)
// over a table (gate + Planning menu line live in the project module's
// views; this page does the rendering).
export default async function PortfolioPage() {
  await requireProjectPage('/project/portfolio')
  return <Portfolio />
}
