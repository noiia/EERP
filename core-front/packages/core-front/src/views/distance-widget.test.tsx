import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useI18nStore } from '../i18n/i18n-store'
import { DistanceWidget } from './distance-widget'
import { useUnitStore } from './unit-store'

const field = {
  name: 'distance_to_event',
  type: 'distance' as const,
  widgetOptions: {
    from: { entity: 'contact', id: 'contact_id', field: 'geo_location' },
    to: { entity: 'event', id: 'event_id', field: 'geo_location' },
  },
}

// Pin the locale: with the source language (null) Intl follows the machine's.
beforeEach(() => useI18nStore.getState().setLocale('en'))
afterEach(() => vi.unstubAllGlobals())

describe('DistanceWidget', () => {
  it('asks the BFF for the two references and shows km', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ meters: 12400 })))
    vi.stubGlobal('fetch', fetchMock)
    useUnitStore.getState().setSystem('metric')
    render(
      <DistanceWidget
        field={field}
        value={null}
        onChange={vi.fn()}
        entity="event_booking"
        recordId="b1"
        draft={{ contact_id: 'c1', event_id: 'e1' }}
      />,
    )
    expect(await screen.findByText('12.4 km')).toBeTruthy()
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `/api/geo/distance?from=${encodeURIComponent('contact:c1:geo_location')}&to=${encodeURIComponent('event:e1:geo_location')}`,
    )
  })

  it('shows miles for an imperial workspace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ meters: 12400 }))),
    )
    useUnitStore.getState().setSystem('imperial')
    render(
      <DistanceWidget
        field={field}
        value={null}
        onChange={vi.fn()}
        draft={{ contact_id: 'c1', event_id: 'e1' }}
      />,
    )
    expect(await screen.findByText('7.7 mi')).toBeTruthy()
  })

  it('shows — without a reference and never calls Go (Review Focus 2)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(
      <DistanceWidget
        field={field}
        value={null}
        onChange={vi.fn()}
        draft={{ contact_id: null, event_id: 'e1' }}
      />,
    )
    expect(screen.getByText('—')).toBeTruthy()
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled())
  })

  it('shows — when Go answers null (unlocated)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ meters: null }))),
    )
    render(
      <DistanceWidget
        field={field}
        value={null}
        onChange={vi.fn()}
        draft={{ contact_id: 'c1', event_id: 'e1' }}
      />,
    )
    await waitFor(() => expect(screen.getByText('—')).toBeTruthy())
  })
})
