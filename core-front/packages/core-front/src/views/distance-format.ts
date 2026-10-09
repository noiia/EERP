import type { UnitSystem } from './unit-store'

const METERS_PER_MILE = 1609.344
const FEET_PER_METER = 3.28084

/** "742 m" / "12.4 km", or "164 ft" / "7.7 mi"; "—" when there is no distance. */
export function formatDistance(
  meters: number | null | undefined,
  system: UnitSystem,
  locale: string | null,
): string {
  if (meters == null || !Number.isFinite(meters)) return '—'
  const fmt = (n: number, digits: number) =>
    new Intl.NumberFormat(locale ?? undefined, { maximumFractionDigits: digits }).format(n)
  if (system === 'imperial') {
    const miles = meters / METERS_PER_MILE
    return miles < 0.1 ? `${fmt(meters * FEET_PER_METER, 0)} ft` : `${fmt(miles, 1)} mi`
  }
  return meters < 1000 ? `${fmt(meters, 0)} m` : `${fmt(meters / 1000, 1)} km`
}
