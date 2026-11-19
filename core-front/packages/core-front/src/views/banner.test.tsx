import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import { darken, lighten } from '@mui/material/styles'
import { Banner, BannerScope, BannerSlot, bannerColors, infoBannerColor, ViewBanner } from './banner'
import { ErrorAlert } from './error-alert'

const light = createTheme({ palette: { mode: 'light', primary: { main: '#1d4ed8' } } })
const dark = createTheme({ palette: { mode: 'dark', primary: { main: '#1d4ed8' } } })

describe('bannerColors', () => {
  it('info is the primary color, lightened in light mode and darkened in dark mode', () => {
    expect(infoBannerColor(light)).toBe(lighten('#1d4ed8', 0.85))
    expect(infoBannerColor(dark)).toBe(darken('#1d4ed8', 0.6))
    expect(bannerColors(light, 'info').bg).toBe(infoBannerColor(light))
    expect(bannerColors(dark, 'info').bg).toBe(infoBannerColor(dark))
  })

  it('warning is the theme orange, error the theme red, each with readable text', () => {
    expect(bannerColors(light, 'warning')).toEqual({
      bg: light.palette.warning.main,
      fg: light.palette.getContrastText(light.palette.warning.main),
    })
    expect(bannerColors(light, 'error').bg).toBe(light.palette.error.main)
  })

  it('an explicit color wins over the status', () => {
    expect(bannerColors(light, 'error', '#00ff00')).toEqual({ bg: '#00ff00', fg: light.palette.getContrastText('#00ff00') })
  })
})

describe('Banner', () => {
  it('renders title, text and action; errors are alerts, info is a status', () => {
    const { rerender } = render(
      <Banner status="error" title="Oops" action={<button>Copy</button>}>
        Something failed
      </Banner>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('OopsSomething failed')
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    rerender(<Banner>Saved.</Banner>)
    expect(screen.getByRole('status')).toHaveAttribute('data-status', 'info')
  })

  it('a close button when onClose is given', () => {
    const onClose = vi.fn()
    render(<Banner onClose={onClose}>Hi</Banner>)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('uses the theme it is rendered in', () => {
    render(
      <ThemeProvider theme={dark}>
        <Banner>Dark</Banner>
      </ThemeProvider>,
    )
    expect(screen.getByRole('status')).toHaveStyle({ backgroundColor: darken('#1d4ed8', 0.6) })
  })
})

describe('banner scopes', () => {
  it('a ViewBanner shows in its scope slot, above the content it was raised in', () => {
    render(
      <BannerScope>
        <BannerSlot />
        <section data-testid="content">
          <ViewBanner status="warning">Deep warning</ViewBanner>
        </section>
      </BannerScope>,
    )
    const banner = screen.getByRole('alert')
    expect(banner.closest('[data-banner-slot]')).not.toBeNull()
    expect(screen.getByTestId('content')).not.toContainElement(banner)
  })

  it('ErrorAlert goes to the slot too', () => {
    render(
      <BannerScope>
        <BannerSlot />
        <div data-testid="content">
          <ErrorAlert error={{ code: 'CONFLICT', message: 'Taken', requestId: 'r1' }} />
        </div>
      </BannerScope>,
    )
    expect(screen.getByRole('alert').closest('[data-banner-slot]')).not.toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('Taken')
  })

  it('the nearest scope wins (a dialog keeps its own banners)', () => {
    render(
      <BannerScope>
        <div data-testid="outer">
          <BannerSlot />
        </div>
        <BannerScope>
          <div data-testid="inner">
            <BannerSlot />
          </div>
          <ViewBanner status="error">Inner error</ViewBanner>
        </BannerScope>
      </BannerScope>,
    )
    expect(screen.getByTestId('inner')).toContainElement(screen.getByRole('alert'))
    expect(screen.getByTestId('outer')).not.toContainElement(screen.getByRole('alert'))
  })

  it('without a scope it renders in place', () => {
    render(
      <div data-testid="here">
        <ViewBanner>Plain</ViewBanner>
      </div>,
    )
    expect(screen.getByTestId('here')).toContainElement(screen.getByRole('status'))
  })

  it('open=false shows nothing', () => {
    render(
      <BannerScope>
        <BannerSlot />
        <ViewBanner open={false}>Hidden</ViewBanner>
      </BannerScope>,
    )
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument()
  })
})
