'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  useRef,
  type ComponentProps,
  type FocusEvent,
  type MouseEvent,
  type TouchEvent,
} from 'react'

type IntentLinkProps = Omit<ComponentProps<typeof Link>, 'prefetch' | 'href'> & { href: string }

/**
 * A `next/link` that prefetches only when the user shows intent — the pointer
 * enters it, it gets keyboard focus, or a finger touches it — never just for
 * being on screen. Next 16 prefetches every visible link with two requests (the
 * route tree, then the segment data), and each one re-runs the ERP layout's
 * backend reads: the landing menu alone fired 15–18 of them, Settings 24, for
 * pages the user mostly never opens. A hover still starts the fetch about
 * 100–300 ms before the click lands. Use it for every ERP link
 * (`component={IntentLink}` on MUI); `ref` passes through to the anchor.
 */
export function IntentLink({
  href,
  onMouseEnter,
  onFocus,
  onTouchStart,
  ...rest
}: IntentLinkProps) {
  const router = useRouter()
  const prefetched = useRef(false)
  const prefetch = () => {
    if (prefetched.current) return
    prefetched.current = true
    router.prefetch(href)
  }
  return (
    <Link
      {...rest}
      href={href}
      prefetch={false}
      onMouseEnter={(e: MouseEvent<HTMLAnchorElement>) => {
        prefetch()
        onMouseEnter?.(e)
      }}
      onFocus={(e: FocusEvent<HTMLAnchorElement>) => {
        prefetch()
        onFocus?.(e)
      }}
      onTouchStart={(e: TouchEvent<HTMLAnchorElement>) => {
        prefetch()
        onTouchStart?.(e)
      }}
    />
  )
}
