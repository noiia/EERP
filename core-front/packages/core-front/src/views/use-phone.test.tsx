import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, render, renderHook, screen } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it } from 'vitest'
import { setViewportWidth } from '../test/viewport'
import { usePhone } from './use-phone'

describe('usePhone', () => {
  it('is false at 1280px and true at 390px', () => {
    setViewportWidth(1280)
    expect(renderHook(usePhone).result.current).toBe(false)
    setViewportWidth(390)
    expect(renderHook(usePhone).result.current).toBe(true)
  })

  it('updates without remounting when the viewport crosses 600px', () => {
    setViewportWidth(1280)
    let mounts = 0
    function Probe() {
      const once = useRef(false)
      if (!once.current) { once.current = true; mounts += 1 }
      return <span>{usePhone() ? 'phone' : 'desktop'}</span>
    }
    render(<Probe />)
    expect(screen.getByText('desktop')).toBeInTheDocument()
    act(() => setViewportWidth(390))
    expect(screen.getByText('phone')).toBeInTheDocument()
    expect(mounts).toBe(1)
  })

  // Defect (390px live check): without the directive, the shell's server layout,
  // which imports the engine barrel, ran MUI's client-only useMediaQuery factory
  // on the server and every /app page answered HTTP 500.
  it('is marked use client so server components can import the engine', () => {
    expect(readFileSync(join(__dirname, 'use-phone.ts'), 'utf8')).toMatch(/^'use client'\n/)
  })
})
