'use client'
import type { DataGridProps } from '@mui/x-data-grid'
import type { RichTreeViewProps } from '@mui/x-tree-view/RichTreeView'
import type { TreeViewDefaultItemModelProperties } from '@mui/x-tree-view/models'
import type { HasId } from './stores'
import type { GraphRendererProps } from './graph-renderer'
import type { HtmlEditorProps } from './html-editor'
import type { WbsRendererProps } from './diagram/wbs-renderer'
import type { PertRendererProps } from './diagram/pert-renderer'
import type { ObsRendererProps } from './diagram/obs-renderer'
import { lazyComponent } from './lazy-component'

// The engine's heavy widgets, each in its own chunk (see lazy-component.tsx).
// Import these, never the libraries directly: one static import of
// '@mui/x-data-grid' (types aside) puts the whole grid back in every page.

export const DataGrid = lazyComponent<DataGridProps>(() =>
  import('@mui/x-data-grid').then((m) => m.DataGrid as React.ComponentType<DataGridProps>),
)

type TreeProps = RichTreeViewProps<TreeViewDefaultItemModelProperties, false>

export const RichTreeView = lazyComponent<TreeProps>(() =>
  import('@mui/x-tree-view/RichTreeView').then(
    (m) => m.RichTreeView as unknown as React.ComponentType<TreeProps>,
  ),
)

export const HtmlEditor = lazyComponent<HtmlEditorProps>(() =>
  import('./html-editor').then((m) => m.HtmlEditor),
)

export const GraphRenderer = lazyComponent<GraphRendererProps<HasId>>(() =>
  import('./graph-renderer').then(
    (m) => m.GraphRenderer as React.ComponentType<GraphRendererProps<HasId>>,
  ),
)

// React Flow (and its CSS) only loads with the WBS/PERT modes; jspdf and html-to-image
// load later still, on the first export (diagram-canvas.tsx).
export const WbsRenderer = lazyComponent<WbsRendererProps<HasId>>(() =>
  import('./diagram/wbs-renderer').then(
    (m) => m.WbsRenderer as React.ComponentType<WbsRendererProps<HasId>>,
  ),
)

export const PertRenderer = lazyComponent<PertRendererProps<HasId>>(() =>
  import('./diagram/pert-renderer').then(
    (m) => m.PertRenderer as React.ComponentType<PertRendererProps<HasId>>,
  ),
)

export const ObsRenderer = lazyComponent<ObsRendererProps>(() =>
  import('./diagram/obs-renderer').then((m) => m.ObsRenderer),
)
