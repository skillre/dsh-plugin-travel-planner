/** Stable identifier helpers shared by the trip store and the model tools. */

const MAX_SLUG_LENGTH = 40

/**
 * Deterministic 32-bit FNV-1a hash rendered as eight hexadecimal characters.
 * @param input - text to hash.
 * @returns the hash in lowercase hexadecimal.
 */
export function shortHash(input: string): string {
  let hash = 0x81_1c_9d_c5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Convert free text into a filesystem- and URL-safe slug.
 * @param input - source text, possibly non-ASCII.
 * @returns lowercase slug; falls back to `trip` when nothing survives.
 */
export function slugify(input: string): string {
  const lowered = input.trim().toLowerCase()
  const replaced = lowered.replaceAll(/[^\p{Letter}\p{Number}]+/gu, '-')
  const trimmed = replaced.replaceAll(/^-+|-+$/g, '')
  const sliced = trimmed.slice(0, MAX_SLUG_LENGTH).replaceAll(/-+$/g, '')
  return sliced === '' ? 'trip' : sliced
}

/**
 * Derive a stable, collision-resistant trip id.
 * @param title - trip title used for the readable part.
 * @param startDate - ISO date used to disambiguate repeated titles.
 * @returns the trip id.
 */
export function tripIdFor(title: string, startDate: string): string {
  return `${slugify(title)}-${shortHash(`${title}\u0000${startDate}`).slice(0, 6)}`
}

/**
 * Derive a stable identifier for one itinerary item.
 * @param dayId - owning day id.
 * @param placeId - place the item visits.
 * @param sequence - zero-based position within the day.
 * @returns the item id.
 */
export function itemIdFor(dayId: string, placeId: string, sequence: number): string {
  return `${dayId}-i${sequence}-${shortHash(`${dayId}\u0000${placeId}\u0000${sequence}`).slice(0, 4)}`
}

/**
 * Format a date offset from a start date.
 * @param startDate - ISO `YYYY-MM-DD` start date.
 * @param offsetDays - whole days to add.
 * @returns the ISO date, or the input when it cannot be parsed.
 */
export function addDays(startDate: string, offsetDays: number): string {
  const parsed = new Date(`${startDate}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return startDate
  parsed.setUTCDate(parsed.getUTCDate() + offsetDays)
  return parsed.toISOString().slice(0, 10)
}
