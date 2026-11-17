'use client'
import type { MatrixConfig } from '../../api/view-fields'

export interface MatrixRendererProps {
  config: MatrixConfig
  projectId: string
}

// Matrices display mode of a project's task list (ADR-041): the Eisenhower, RACI
// and dependency matrices over the pinned project. Stub — the Matrices mode task fills it.
export function MatrixRenderer({ config, projectId }: MatrixRendererProps) {
  return (
    <div data-testid="matrix-renderer" data-project={projectId} data-raci-entity={config.raciEntity} />
  )
}
