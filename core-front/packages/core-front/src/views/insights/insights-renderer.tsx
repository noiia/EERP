'use client'
import type { InsightsConfig } from '../../api/view-fields'

export interface InsightsRendererProps {
  config: InsightsConfig
  projectId: string
}

// Insights display mode of a project's task list (ADR-041): the earned-value and
// burndown charts over the pinned project. Stub — the Insights mode task fills it.
export function InsightsRenderer({ config, projectId }: InsightsRendererProps) {
  return (
    <div data-testid="insights-renderer" data-project={projectId} data-metrics-path={config.metricsPath} />
  )
}
