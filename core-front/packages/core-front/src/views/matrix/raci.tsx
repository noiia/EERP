'use client'
import type { MatrixConfig } from '../../api/view-fields'
import type { MatrixTask } from './matrix-renderer'

export interface RaciProps {
  tasks: MatrixTask[]
  config: MatrixConfig
  projectId: string
}

// The RACI accountability matrix (ADR-041): who is Responsible / Accountable
// / Consulted / Informed for each task, over the project's staff.
// Stub — the RACI matrix task fills it.
export function Raci({ tasks, config, projectId }: RaciProps) {
  return (
    <div data-testid="raci-matrix" data-project={projectId} data-raci-entity={config.raciEntity} data-tasks={tasks.length} />
  )
}
