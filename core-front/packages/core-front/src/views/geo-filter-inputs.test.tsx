import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ZoneRecordInput } from './geo-filter-inputs'
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
