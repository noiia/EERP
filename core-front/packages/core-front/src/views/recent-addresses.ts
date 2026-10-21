import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// The addresses a user last completed in a geo/point widget (a "Search an
// address" pick or the Create dialog), kept on this device so the next record
// can reuse them without retyping or a new search. Per-device convenience,
// like the theme: never sent to the server.

/** One address as the point widget's dialog edits it, plus where it is when
 * known (null = not geocoded, picking it geocodes the label again). */
export interface RecentAddress {
  label: string
  street: string
  zip_code: string
  city: string
  state: string
  country: string
  lat: number | null
  lon: number | null
}

/** How many addresses are kept; remembering one more drops the oldest. */
export const RECENT_ADDRESS_LIMIT = 5

const sameAddress = (a: RecentAddress, b: RecentAddress) =>
  a.label.trim().toLowerCase() === b.label.trim().toLowerCase()

export interface RecentAddressState {
  /** Newest first, at most RECENT_ADDRESS_LIMIT. */
  addresses: RecentAddress[]
  /** Put `address` first, replacing an earlier copy of the same label. */
  remember: (address: RecentAddress) => void
}

export const useRecentAddressStore = create<RecentAddressState>()(
  persist(
    (set) => ({
      addresses: [],
      remember: (address) => {
        if (!address.label.trim()) return
        set((s) => ({
          addresses: [address, ...s.addresses.filter((a) => !sameAddress(a, address))].slice(
            0,
            RECENT_ADDRESS_LIMIT,
          ),
        }))
      },
    }),
    { name: 'eerp-recent-addresses', version: 1 },
  ),
)
