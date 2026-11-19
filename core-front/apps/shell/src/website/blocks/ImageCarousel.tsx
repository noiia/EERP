'use client'
import { useRef, useState, type PointerEvent } from 'react'
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
 * the carousel keeps its own position. Swipe (touch, pen or mouse drag) moves to the
 * next/previous picture; the picture follows the finger until it is released, with
 * its neighbours (preloaded) sliding in beside it. */
export function ImageCarousel({ images, index, onIndexChange, fill }: { images: CarouselImage[]; index?: number; onIndexChange?: (i: number) => void; fill?: boolean }) {
  const t = useT()
  const [own, setOwn] = useState(0)
  const [drag, setDrag] = useState(0)
  const start = useRef<{ x: number; y: number; id: number } | null>(null)
  const dragged = useRef(false)
  if (images.length === 0) return null
  const at = Math.min(index ?? own, images.length - 1)
  const go = (i: number) => {
    const next = (i + images.length) % images.length
    setOwn(next)
    onIndexChange?.(next)
  }
  const many = images.length > 1
  // A horizontal drag past 50px (or a fifth of the width) turns the page; vertical
  // moves stay the browser's (touch-action: pan-y keeps the page scrollable).
  const onDown = (e: PointerEvent<HTMLElement>) => {
    if (!many || (e.pointerType === 'mouse' && e.button !== 0)) return
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
    dragged.current = false
  }
  const onMove = (e: PointerEvent<HTMLElement>) => {
    const s = start.current
    if (!s || s.id !== e.pointerId) return
    const dx = e.clientX - s.x
    if (!dragged.current && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(e.clientY - s.y)) {
      dragged.current = true
      e.currentTarget.setPointerCapture?.(e.pointerId)
    }
    if (dragged.current) setDrag(dx)
  }
  const onUp = (e: PointerEvent<HTMLElement>) => {
    const s = start.current
    if (!s || s.id !== e.pointerId) return
    start.current = null
    const dx = e.clientX - s.x
    const width = e.currentTarget.clientWidth || 300
    setDrag(0)
    if (dragged.current && Math.abs(dx) > Math.min(50, width / 5)) go(dx < 0 ? at + 1 : at - 1)
  }
  const img = images[at]
  // The current picture plus, when there are several, its neighbours one frame to
  // the left and right. They're real <img>s, so the browser loads them up front,
  // and they move with the finger, so a swipe slides the next picture in rather
  // than a blank frame.
  const slide = (im: CarouselImage, offset: -1 | 0 | 1) => (
    <Box component="img" key={`${offset}:${im.src}`} src={im.src} alt={offset === 0 ? im.alt : ''}
      aria-hidden={offset === 0 ? undefined : true}
      loading="eager" draggable={false}
      sx={{
        ...(fill || offset !== 0
          ? { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: fill ? 'cover' : 'contain' }
          : { width: '100%', maxHeight: 480, objectFit: 'contain' }),
        display: 'block',
        transform: `translateX(calc(${offset * 100}% + ${drag}px))`,
        transition: drag ? 'none' : 'transform .2s',
      }} />
  )
  const current = slide(img, 0)
  const pic = (
    <>
      {many && slide(images[(at - 1 + images.length) % images.length], -1)}
      {img.href ? <Link href={img.href}>{current}</Link> : current}
      {many && slide(images[(at + 1) % images.length], 1)}
    </>
  )
  const arrow = {
    position: 'absolute', top: '50%', transform: 'translateY(-50%)', width: 40, height: 40, fontSize: 24, lineHeight: 1,
    color: '#fff', bgcolor: 'rgba(0,0,0,.35)', backdropFilter: 'blur(4px)', '&:hover': { bgcolor: 'rgba(0,0,0,.55)' },
  } as const
  return (
    <Box
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      onPointerCancel={() => { start.current = null; setDrag(0) }}
      // A drag must not also follow the picture's link.
      onClickCapture={(e) => { if (dragged.current) { e.preventDefault(); e.stopPropagation(); dragged.current = false } }}
      sx={{ position: 'relative', width: '100%', height: fill ? '100%' : undefined, minHeight: fill ? 160 : undefined, borderRadius: 2, overflow: 'hidden', bgcolor: 'action.hover', touchAction: many ? 'pan-y' : undefined, userSelect: 'none' }}>
      {pic}
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
