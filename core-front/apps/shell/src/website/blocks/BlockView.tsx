import type { Block, HeroConfig, ImageConfig, PublicDataSource, RecordDetailConfig, RecordListConfig, TextConfig } from '../types'
import { HeroBlock } from './HeroBlock'
import { ImageBlock } from './ImageBlock'
import { PendingBlock } from './PendingBlock'
import { RecordDetailBlock } from './RecordDetailBlock'
import { RecordListBlock } from './RecordListBlock'
import { TextBlock } from './TextBlock'

// Async children are awaited as plain functions so the result renders in vitest too (RTL cannot render async elements).
/** Async server component: renders one block from published data. Shared by the public site and the editor preview. */
export async function BlockView({ block, source, params }: { block: Block; source: PublicDataSource; params: { id?: string } }) {
  const c = block.config
  switch (block.type) {
    case 'text': return <TextBlock config={c as unknown as TextConfig} />
    case 'image': return <ImageBlock config={c as unknown as ImageConfig} />
    case 'hero': return <HeroBlock config={c as unknown as HeroConfig} />
    case 'record_list': return RecordListBlock({ config: c as unknown as RecordListConfig, source })
    case 'record_detail': return RecordDetailBlock({ config: c as unknown as RecordDetailConfig, source, id: params.id })
    default: return <PendingBlock />
  }
}
