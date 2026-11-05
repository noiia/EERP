import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GeoCenterInput, ZoneRecordInput } from './geo-filter-inputs'
import { RelationOpsProvider, type RelationOps } from './relation-ops'

describe('ZoneRecordInput', () => {
  it('clears loaded records and re-queries when the zone entity changes', async () => {
    const list = vi.fn(async (entity: string) => [{ id: `${entity}-1`, name: `${entity} rec` }])
    const ops = { list, get: vi.fn(), create: vi.fn(), remove: vi.fn() } as unknown as RelationOps
    const onChange = vi.fn()
    render(
      <RelationOpsProvider ops={ops}>
        <ZoneRecordInput
          zones={[
            { entity: 'a', field: 'za', label: 'Zone A' },
            { entity: 'b', field: 'zb', label: 'Zone B' },
          ]}
          value=""
          onChange={onChange}
        />
      </RelationOpsProvider>,
    )
    const input = screen.getByRole('combobox', { name: 'Zone A' })
    fireEvent.change(input, { target: { value: 'x' } })
    await waitFor(() => expect(list).toHaveBeenCalledWith('a', expect.anything()))
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Zone of' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Zone B' }))
    const inputB = await screen.findByRole('combobox', { name: 'Zone B' })
    fireEvent.change(inputB, { target: { value: 'y' } })
    await waitFor(() => expect(list).toHaveBeenCalledWith('b', expect.anything()))
    fireEvent.click(await screen.findByText('b rec'))
    expect(onChange).toHaveBeenLastCalledWith('b:b-1:zb')
    expect(screen.queryByText('a rec')).not.toBeInTheDocument()
  })
})

describe('ZoneRecordInput with one zone', () => {
  it('offers no zone picker, labels the field with the record id when it has no name, and survives a failed search', async () => {
    const list = vi.fn(async (_e: string, o: { search: { name: string } }) => {
      if (o.search.name === 'q') throw new Error('down')
      return [{ id: 'z1' }]
    })
    const ops = { list } as unknown as RelationOps
    const onChange = vi.fn()
    render(
      <RelationOpsProvider ops={ops}>
        <ZoneRecordInput zones={[{ entity: 'a', field: 'za', label: 'Zone A' }]} value="" onChange={onChange} />
      </RelationOpsProvider>,
    )
    expect(screen.queryByRole('combobox', { name: 'Zone of' })).toBeNull()
    const input = screen.getByRole('combobox', { name: 'Zone A' })
    fireEvent.change(input, { target: { value: 'z' } })
    fireEvent.click(await screen.findByText('z1'))
    expect(onChange).toHaveBeenCalledWith('a:z1:za')
    fireEvent.change(input, { target: { value: 'q' } })
    await waitFor(() => expect(list).toHaveBeenCalledWith('a', expect.objectContaining({ search: { name: 'q' } })))
  })

  it('without any zone, never searches', () => {
    const list = vi.fn()
    render(
      <RelationOpsProvider ops={{ list } as unknown as RelationOps}>
        <ZoneRecordInput zones={[]} value="" onChange={vi.fn()} />
      </RelationOpsProvider>,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Zone' }), { target: { value: 'x' } })
    expect(list).not.toHaveBeenCalled()
  })
})

describe('GeoCenterInput', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('takes the center from an address suggestion, keeping the radius', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [{ label: '1 Main St, Paris', lon: 2.35, lat: 48.85 }] }))))
    const onChange = vi.fn()
    render(<GeoCenterInput value="1,2,5000" onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Near an address' }), { target: { value: '1 Main' } })
    fireEvent.click(await screen.findByText('1 Main St, Paris', {}, { timeout: 3000 }))
    expect(onChange).toHaveBeenCalledWith('2.35,48.85,5000')
  })

  it('takes the center from the browser position', () => {
    const getCurrentPosition = vi.fn((ok: (p: { coords: { longitude: number; latitude: number } }) => void) => ok({ coords: { longitude: 3, latitude: 4 } }))
    vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition } })
    const onChange = vi.fn()
    render(<GeoCenterInput value="" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }))
    expect(onChange).toHaveBeenCalledWith('3,4')
  })

  it('edits the radius in km (stored as meters); empty drops it; no center clears the filter', () => {
    const onChange = vi.fn()
    const { rerender } = render(<GeoCenterInput value="1,2,5000" onChange={onChange} />)
    const km = screen.getByLabelText('Within (km, optional)') as HTMLInputElement
    expect(km.value).toBe('5')
    fireEvent.change(km, { target: { value: '2.5' } })
    expect(onChange).toHaveBeenLastCalledWith('1,2,2500')
    fireEvent.change(km, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith('1,2')
    rerender(<GeoCenterInput value="" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Within (km, optional)'), { target: { value: '3' } })
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('without a radius (covers), the center alone', () => {
    const getCurrentPosition = vi.fn((ok: (p: { coords: { longitude: number; latitude: number } }) => void) => ok({ coords: { longitude: 3, latitude: 4 } }))
    vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition } })
    const onChange = vi.fn()
    render(<GeoCenterInput value="1,2,900" radius={false} onChange={onChange} />)
    expect(screen.queryByLabelText('Within (km, optional)')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Use my location' }))
    expect(onChange).toHaveBeenCalledWith('3,4')
  })
})
