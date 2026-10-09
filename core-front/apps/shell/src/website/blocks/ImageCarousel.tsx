'use client'
import { useState } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'

export interface CarouselImage { src: string; alt: string; href?: string }

/** One picture at a time with prev/next arrows and dots over it; no controls for a
 * single one. `fill`: covers the whole block (the image carousel block), else the
 * picture is shown whole, up to 480px high (the record detail). `index` given =
 * controlled (the record detail drives it from the selected related record), else
 * the carousel keeps its own position.
 * ponytail: no swipe gesture; arrows/dots work on touch too. */
export function ImageCarousel({ images, index, onIndexChange, fill }: { images: CarouselImage[]; index?: number; onIndexChange?: (i: number) => void; fill?: boolean }) {
  const t = useT()
  const [own, setOwn] = useState(0)
  if (images.length === 0) return null
  const at = Math.min(index ?? own, images.length - 1)
  const go = (i: number) => {
    const next = (i + images.length) % images.length
    setOwn(next)
    onIndexChange?.(next)
  }
  const img = images[at]
  const pic = (
    <Box component="img" key={img.src} src={img.src} alt={img.alt}
      sx={fill
        ? { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }
        : { width: '100%', maxHeight: 480, objectFit: 'contain', display: 'block' }} />
  )
  const arrow = {
    position: 'absolute', top: '50%', transform: 'translateY(-50%)', width: 40, height: 40, fontSize: 24, lineHeight: 1,
    color: '#fff', bgcolor: 'rgba(0,0,0,.35)', backdropFilter: 'blur(4px)', '&:hover': { bgcolor: 'rgba(0,0,0,.55)' },
  } as const
  const many = images.length > 1
  return (
    <Box sx={{ position: 'relative', width: '100%', height: fill ? '100%' : undefined, minHeight: fill ? 160 : undefined, borderRadius: 2, overflow: 'hidden', bgcolor: 'action.hover' }}>
      {img.href ? <Link href={img.href}>{pic}</Link> : pic}
      {(img.alt || many) && (
        <Box sx={{
          position: 'absolute', left: 0, right: 0, bottom: 0, px: 2, pt: 4, pb: 1.5, pointerEvents: 'none',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
          background: 'linear-gradient(180deg, transparent, rgba(0,0,0,.55))', color: '#fff',
        }}>
          {img.alt && <Typography variant="subtitle1" sx={{ fontWeight: 600, textAlign: 'center' }}>{img.alt}</Typography>}
          {many && (
            <Box sx={{ display: 'flex', gap: 0.75, pointerEvents: 'auto' }}>
              {images.map((im, i) => (
                <Box key={im.src} component="button" type="button" aria-label={`${i + 1} / ${images.length}`} aria-current={i === at} onClick={() => go(i)}
                  sx={{ width: i === at ? 22 : 8, height: 8, p: 0, border: 0, borderRadius: 999, cursor: 'pointer', transition: 'width .2s', bgcolor: i === at ? '#fff' : 'rgba(255,255,255,.5)' }} />
              ))}
            </Box>
          )}
        </Box>
      )}
      {many && <>
        <IconButton aria-label={t('Previous picture')} onClick={() => go(at - 1)} sx={{ ...arrow, left: 12 }}>‹</IconButton>
        <IconButton aria-label={t('Next picture')} onClick={() => go(at + 1)} sx={{ ...arrow, right: 12 }}>›</IconButton>
      </>}
    </Box>
  )
}
