'use client'

import type { ObsConfig } from '../../api/view-fields'

export interface ObsRendererProps {
  config: ObsConfig
  projectId: string
}

// Stub: the chart itself lands in the next task.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ObsRenderer(_props: ObsRendererProps) {
  return null
}
