import type { Block, BookingConfig, RecordCarouselConfig, HeroConfig, ImageCarouselConfig, ImageConfig, PublicDataSource, RecordDetailConfig, RecordListConfig, TextConfig } from '../types'
import { AppointmentBookingBlock } from './AppointmentBookingBlock'
import { EventBookingBlock } from './EventBookingBlock'
import { HeroBlock } from './HeroBlock'
import { ImageBlock } from './ImageBlock'
import { ImageCarouselBlock } from './ImageCarouselBlock'
import { RecordCarouselBlock } from './RecordCarouselBlock'
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
    case 'record_list': return RecordListBlock({ config: c as unknown as RecordListConfig, source, h: block.h })
    case 'record_detail': {
      const cfg = c as unknown as RecordDetailConfig
      return RecordDetailBlock({ config: cfg, source, id: cfg.record || params.id })
    }
    case 'record_carousel': return RecordCarouselBlock({ config: c as unknown as RecordCarouselConfig, source })
    case 'image_carousel': return ImageCarouselBlock({ config: c as unknown as ImageCarouselConfig, source })
    case 'event_booking': return EventBookingBlock({ config: c as unknown as BookingConfig, source })
    case 'appointment_booking': return AppointmentBookingBlock({ config: c as unknown as BookingConfig, source })
    default: return null
  }
}
