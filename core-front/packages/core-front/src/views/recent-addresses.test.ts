import { beforeEach, describe, expect, it } from 'vitest'
import { RECENT_ADDRESS_LIMIT, useRecentAddressStore, type RecentAddress } from './recent-addresses'

const address = (label: string): RecentAddress => ({
  label,
  street: label,
  zip_code: '',
  city: '',
  state: '',
  country: '',
  lat: null,
  lon: null,
})
const labels = () => useRecentAddressStore.getState().addresses.map((a) => a.label)

beforeEach(() => useRecentAddressStore.setState({ addresses: [] }))

describe('useRecentAddressStore', () => {
  it('keeps the newest first', () => {
    useRecentAddressStore.getState().remember(address('A'))
    useRecentAddressStore.getState().remember(address('B'))
    expect(labels()).toEqual(['B', 'A'])
  })

  it(`keeps ${RECENT_ADDRESS_LIMIT} addresses, dropping the oldest`, () => {
    for (const l of ['A', 'B', 'C', 'D', 'E', 'F']) useRecentAddressStore.getState().remember(address(l))
    expect(labels()).toEqual(['F', 'E', 'D', 'C', 'B'])
  })

  it('moves an address remembered again to the top instead of duplicating it', () => {
    for (const l of ['A', 'B', 'C']) useRecentAddressStore.getState().remember(address(l))
    useRecentAddressStore.getState().remember({ ...address(' a '), lat: 1, lon: 2 })
    expect(labels()).toEqual([' a ', 'C', 'B'])
    expect(useRecentAddressStore.getState().addresses[0]).toMatchObject({ lat: 1, lon: 2 })
  })

  it('ignores an address with no label', () => {
    useRecentAddressStore.getState().remember(address('  '))
    expect(labels()).toEqual([])
  })
})
