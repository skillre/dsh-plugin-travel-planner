/**
 * Deterministic re-timing of one day.
 *
 * When the user reorders a day by hand, the clock has to follow: a stop keeps
 * the time it takes, and travel between two stops costs what that pair costs.
 * This module recomputes the day's timeline from those two facts alone — no
 * model, no network, no clock reads — so a drop lands on a correct schedule
 * immediately.
 *
 * Locked items are the anchors. Whatever the new order is, a locked item keeps
 * the times the user pinned, and the items after it are fitted to that anchor
 * rather than pushing it aside.
 *
 * The module is pure: it never mutates its input and returns a new day.
 */

import type { GeoPoint, ItineraryItem, RouteLeg, TravelMode, TripDay, TripPlace } from './trip.js'

/** What a stop costs when nothing else is known. */
const DEFAULT_DWELL_MINUTES = 45

/** Minutes per kilometre used when a leg has no measured duration. */
const MINUTES_PER_KM: Readonly<Record<TravelMode, number>> = {
  walking: 13,
  transit: 3.5,
  riding: 5,
  driving: 2.5,
}

/** Straight-line distance is multiplied by this to approximate a real route. */
const DETOUR_FACTOR = 1.35

/** Requested change to one day. */
export interface ReflowInput {
  /** Day to re-time. */
  readonly day: TripDay
  /** Places the day's items refer to; used for the travel estimate. */
  readonly places: Readonly<Record<string, TripPlace>>
  /** New item order; must be a permutation of the day's item ids. */
  readonly order?: readonly string[]
  /** Travel mode used for estimated legs. */
  readonly mode?: TravelMode
  /** Stop length used when an item carries neither a duration nor times. */
  readonly defaultDwellMinutes?: number
}

/** One item's before/after timing. */
export interface ReflowChange {
  readonly itemId: string
  readonly previousStartAt: string | undefined
  readonly startAt: string | undefined
  readonly endAt: string | undefined
}

/** What a re-timing produced. */
export interface ReflowResult {
  /** The re-ordered, re-timed day. */
  readonly day: TripDay
  /** Items whose position changed. */
  readonly movedCount: number
  /** Items whose start time changed. */
  readonly retimed: readonly ReflowChange[]
  /** Leg ids that kept their numbers but now serve a new pairing. */
  readonly staleLegIds: readonly string[]
  /** Consecutive pairs with no measured leg, whose travel time is an estimate. */
  readonly estimatedPairs: readonly string[]
  /** True when the request changed nothing. */
  readonly unchanged: boolean
}

/** Raised when the requested order is not a permutation of the day's items. */
export class ReflowOrderError extends Error {
  /** Machine-readable failure code. */
  readonly code = 'INVALID_ORDER'

  /**
   * @param message - caller-facing explanation.
   */
  constructor(message: string) {
    super(message)
    this.name = 'ReflowOrderError'
  }
}

/**
 * Re-order and re-time one day.
 *
 * @param input - day, places, optional new order and estimation settings.
 * @returns the new day plus what changed.
 * @throws {ReflowOrderError} when `order` is not a permutation of the day's items.
 */
export function reflowDay(input: ReflowInput): ReflowResult {
  const { day } = input
  if (day.items.length === 0) {
    return { day, movedCount: 0, retimed: [], staleLegIds: [], estimatedPairs: [], unchanged: true }
  }

  const items = applyOrder(day.items, input.order)
  const movedCount = items.reduce((count, item, index) => (day.items[index]?.id === item.id ? count : count + 1), 0)
  // A stored duration is trusted only when it is a usable positive number; a
  // hand-edited or migrated document can carry a nonsensical one.
  const dwellMinutes = (item: ItineraryItem): number => {
    const planned = item.plannedDurationMinutes
    if (planned !== undefined && Number.isFinite(planned) && planned > 0) return planned
    return minutesBetween(item.startAt, item.endAt) ?? input.defaultDwellMinutes ?? DEFAULT_DWELL_MINUTES
  }

  /** Indices whose clock the user pinned. */
  const anchors = new Map<number, { readonly start: number; readonly end: number }>()
  items.forEach((item, index) => {
    if (!item.locked) return
    const start = parseClock(item.startAt)
    const end = parseClock(item.endAt)
    if (start !== undefined && end !== undefined) anchors.set(index, { start, end })
  })

  // The day starts where it always started, not where the dragged item used to
  // sit: moving a later stop to the front must not push the whole day later.
  const dayStart = parseClock(day.items[0]?.startAt) ?? earliestClock(day.items)
  const canRetime = anchors.size > 0 || dayStart !== undefined

  const retimed: ReflowChange[] = []
  const estimatedPairs: string[] = []
  const retimedItems: ItineraryItem[] = []
  let cursor = dayStart

  for (const [index, item] of items.entries()) {
    const anchor = anchors.get(index)
    let start: number | undefined
    let end: number | undefined

    if (anchor !== undefined) {
      start = anchor.start
      end = anchor.end
      cursor = anchor.end
    } else if (canRetime && cursor !== undefined) {
      const previous = items[index - 1]
      if (previous !== undefined) {
        const travel = estimateTravel(input, previous, item)
        if (travel.estimated) estimatedPairs.push(`${previous.id}→${item.id}`)
        cursor += travel.minutes
      }
      start = cursor
      end = start + dwellMinutes(item)
      cursor = end
    }

    if (start !== undefined && end !== undefined) {
      const startAt = writeClock(item.startAt, start, day.items[0]?.startAt)
      const endAt = writeClock(item.endAt, end, day.items[0]?.startAt)
      if (startAt !== item.startAt) retimed.push({ itemId: item.id, previousStartAt: item.startAt, startAt, endAt })
      retimedItems.push({ ...item, ...startAt === undefined ? {} : { startAt }, ...endAt === undefined ? {} : { endAt } })
      continue
    }
    retimedItems.push(item)
  }

  // Only a real move invalidates the stored adjacencies; re-timing a day in
  // place must leave its legs exactly as the CLI returned them.
  const { legs, staleLegIds } = movedCount > 0 ? rebuildLegs(day, items) : { legs: day.legs, staleLegIds: [] }
  const unchanged = movedCount === 0 && retimed.length === 0
  return {
    day: unchanged ? day : { ...day, items: retimedItems, legs },
    movedCount,
    retimed,
    staleLegIds,
    estimatedPairs,
    unchanged,
  }
}

/**
 * The earliest clock a day's items carry.
 *
 * @param items - items to scan.
 * @returns minutes from midnight, or undefined when none carry a usable time.
 */
function earliestClock(items: readonly ItineraryItem[]): number | undefined {
  let earliest: number | undefined
  for (const item of items) {
    const clock = parseClock(item.startAt)
    if (clock === undefined) continue
    earliest = earliest === undefined ? clock : Math.min(earliest, clock)
  }
  return earliest
}

/**
 * Apply a requested order.
 *
 * @param items - current items.
 * @param order - requested ids, or undefined to keep the current order.
 * @returns items in the requested order.
 * @throws {ReflowOrderError} when the request is not a permutation.
 */
function applyOrder(items: readonly ItineraryItem[], order: readonly string[] | undefined): readonly ItineraryItem[] {
  if (order === undefined) return items
  if (order.length !== items.length) {
    throw new ReflowOrderError(`新顺序包含 ${String(order.length)} 项，这一天有 ${String(items.length)} 项。`)
  }
  const byId = new Map(items.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const ordered: ItineraryItem[] = []
  for (const id of order) {
    const item = byId.get(id)
    if (item === undefined) throw new ReflowOrderError(`新顺序里的 ${id} 不属于这一天。`)
    if (seen.has(id)) throw new ReflowOrderError(`新顺序里的 ${id} 出现了两次。`)
    seen.add(id)
    ordered.push(item)
  }
  return ordered
}

/**
 * Re-derive the day's legs for the new order.
 *
 * A pair that already had a measurement keeps its numbers but is flagged
 * `stale`, because it now serves a different position in the day. A pair with no
 * measurement gets no leg at all: inventing one would hide a `MISSING_ROUTE`
 * that the user should see and the Agent should resolve with real routing.
 *
 * @param day - the day as it was.
 * @param ordered - items in their new order.
 * @returns the rebuilt legs and the ids that were flagged stale.
 */
function rebuildLegs(
  day: TripDay,
  ordered: readonly ItineraryItem[],
): { readonly legs: readonly RouteLeg[]; readonly staleLegIds: readonly string[] } {
  const byPair = new Map<string, RouteLeg>()
  for (const leg of day.legs) byPair.set(`${leg.fromItemId}→${leg.toItemId}`, leg)

  const legs: RouteLeg[] = []
  const staleLegIds: string[] = []
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const from = ordered[index]
    const to = ordered[index + 1]
    if (from === undefined || to === undefined) continue
    const source = byPair.get(`${from.id}→${to.id}`) ?? byPair.get(`${to.id}→${from.id}`)
    if (source === undefined) continue
    legs.push({ ...source, fromItemId: from.id, toItemId: to.id, freshness: 'stale' })
    if (source.freshness !== 'stale') staleLegIds.push(source.id)
  }
  return { legs, staleLegIds }
}

/**
 * Travel minutes between two consecutive stops.
 *
 * @param input - the day, its places and the fallback mode.
 * @param from - the stop being left.
 * @param to - the stop being reached.
 * @returns minutes and whether they were estimated rather than measured.
 */
function estimateTravel(input: ReflowInput, from: ItineraryItem, to: ItineraryItem): { readonly minutes: number; readonly estimated: boolean } {
  const measured =
    input.day.legs.find((leg) => leg.fromItemId === from.id && leg.toItemId === to.id) ??
    input.day.legs.find((leg) => leg.fromItemId === to.id && leg.toItemId === from.id)
  if (measured !== undefined) return { minutes: Math.max(1, Math.round(measured.durationSeconds / 60)), estimated: false }

  const fromPoint = input.places[from.placeId]?.point
  const toPoint = input.places[to.placeId]?.point
  if (fromPoint === undefined || toPoint === undefined) {
    return { minutes: input.defaultDwellMinutes ?? DEFAULT_DWELL_MINUTES, estimated: true }
  }
  const km = haversineKm(fromPoint, toPoint) * DETOUR_FACTOR
  return { minutes: Math.max(1, Math.round(km * MINUTES_PER_KM[input.mode ?? 'transit'])), estimated: true }
}

/**
 * Great-circle distance between two points.
 *
 * @param from - origin.
 * @param to - destination.
 * @returns kilometres.
 */
function haversineKm(from: GeoPoint, to: GeoPoint): number {
  const radiusKm = 6371
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180
  const dLat = toRad(to.latitude - from.latitude)
  const dLon = toRad(to.longitude - from.longitude)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.latitude)) * Math.cos(toRad(to.latitude)) * Math.sin(dLon / 2) ** 2
  return 2 * radiusKm * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * Read the clock part of a timestamp as minutes from midnight.
 *
 * @param value - `YYYY-MM-DDTHH:MM` with an optional seconds/offset tail.
 * @returns minutes from midnight, or undefined when the value is unusable.
 */
function parseClock(value: string | undefined): number | undefined {
  if (value === undefined || value.length < 16) return undefined
  const hours = Number(value.slice(11, 13))
  const minutes = Number(value.slice(14, 16))
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return undefined
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/**
 * Write a clock back into a timestamp, keeping its original shape.
 *
 * The date and any seconds or offset tail are copied from the item's own
 * timestamp when it has one, so a project storing
 * `2026-10-01T09:00:00+08:00` keeps exactly that form.
 *
 * @param original - the item's own timestamp, preferred as the shape.
 * @param minutes - minutes from midnight to write.
 * @param fallback - timestamp to borrow the date and tail from.
 * @returns the rewritten timestamp, or undefined when no shape is available.
 */
function writeClock(original: string | undefined, minutes: number, fallback: string | undefined): string | undefined {
  const shape = original ?? fallback
  if (shape === undefined || shape.length < 16) return undefined
  const day = shape.slice(0, 10)
  const tail = shape.slice(16)
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  const dayShift = Math.floor(hours / 24)
  const clockHours = ((hours % 24) + 24) % 24
  const date = dayShift === 0 ? day : shiftDate(day, dayShift)
  return `${date}T${String(clockHours).padStart(2, '0')}:${String(mins).padStart(2, '0')}${tail}`
}

/**
 * Shift a `YYYY-MM-DD` date by whole days.
 *
 * @param date - date to shift.
 * @param days - whole days, positive or negative.
 * @returns the shifted date, or the input when it is not a calendar date.
 */
function shiftDate(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(parsed)) return date
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Minutes between two timestamps, allowing for a date change.
 *
 * @param startAt - earlier timestamp.
 * @param endAt - later timestamp.
 * @returns whole minutes, or undefined when either side is unusable.
 */
function minutesBetween(startAt: string | undefined, endAt: string | undefined): number | undefined {
  const start = parseClock(startAt)
  const end = parseClock(endAt)
  if (start === undefined || end === undefined) return undefined
  const startDate = startAt?.slice(0, 10)
  const endDate = endAt?.slice(0, 10)
  const dayShift =
    startDate === undefined || endDate === undefined
      ? 0
      : Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000)
  const minutes = end - start + dayShift * 1440
  return minutes > 0 ? minutes : undefined
}
