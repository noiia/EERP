'use client'
import { lazyComponent } from '@eerp/core-front'

// React Flow (and its CSS) stays in the workflow map's own chunk: only this page
// imports this wrapper, so no other ERP page ships it (see "Heavy widgets load on
// their own" in core-front/CLAUDE.md).
export const LazyWorkflowMap = lazyComponent(() => import('./WorkflowMap').then((m) => m.WorkflowMap))
