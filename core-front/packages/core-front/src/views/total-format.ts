/**
 * The one display rule for a list total. Go counts exactly up to 10 000
 * matching rows and estimates beyond (`total_estimated`, ADR-032); an
 * estimate is shown with "≈" so it never reads as an exact count.
 */
export function formatTotal(total: number, estimated?: boolean): string {
  return estimated ? `≈ ${total}` : String(total)
}
