'use client'
import Typography from '@mui/material/Typography'
import type { RiskConfig } from '../../api/view-fields'

export interface RiskRendererProps {
  config: RiskConfig
  projectId: string
}

// Placeholder: the real risk analysis lands in the next task.
export function RiskRenderer({ projectId }: RiskRendererProps) {
  return <Typography data-project={projectId}>Risk analysis</Typography>
}
