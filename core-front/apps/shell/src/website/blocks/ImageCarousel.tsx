'use client'
import { useState } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'

export interface CarouselImage { src: string; alt: string; href?: string }

/** One picture at a time with prev/next arrows and dots; no controls for a single one.
 * `index` given = controlled (the record detail drives it from the selected related
 * record), else the carousel keeps its own position.
 * ponytail: no swipe gesture; arrows/dots work on touch too. */
export function ImageCarousel({ images, index, onIndexChange }: { images: CarouselImage[]; index?: number; onIndexChange?: (i: number) => void }) {
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
  const pic = <Box component="img" src={img.src} alt={img.alt} sx={{ width: '100%', maxHeight: 480, objectFit: 'contain', display: 'block' }} />
  const arrow = { position: 'absolute', top: '50%', transform: 'translateY(-50%)', bgcolor: 'background.paper', opacity: 0.85, '&:hover': { bgcolor: 'background.paper' } } as const
  return (
    <Stack spacing={1} sx={{ alignItems: 'center' }}>
      <Box sx={{ position: 'relative', width: '100%' }}>
        {img.href ? <Link href={img.href}>{pic}</Link> : pic}
        {images.length > 1 && <>
          <IconButton aria-label={t('Previous picture')} onClick={() => go(at - 1)} sx={{ ...arrow, left: 8 }}>‹</IconButton>
          <IconButton aria-label={t('Next picture')} onClick={() => go(at + 1)} sx={{ ...arrow, right: 8 }}>›</IconButton>
        </>}
      </Box>
      {images.length > 1 && (
        <Stack direction="row" spacing={0.5}>
          {images.map((im, i) => (
            <Box key={im.src} component="button" type="button" aria-label={`${i + 1} / ${images.length}`} aria-current={i === at} onClick={() => go(i)}
              sx={{ width: 10, height: 10, p: 0, border: 0, borderRadius: '50%', cursor: 'pointer', bgcolor: i === at ? 'primary.main' : 'action.disabled' }} />
          ))}
        </Stack>
      )}
      {img.alt && <Typography variant="caption" color="text.secondary">{img.alt}</Typography>}
    </Stack>
  )
}
