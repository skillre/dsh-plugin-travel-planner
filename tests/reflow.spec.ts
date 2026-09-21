import { describe, expect, it } from 'vitest'
import { ReflowOrderError, reflowDay } from '../src/domain/reflow.js'
import type { GeoPoint, ItineraryItem, RouteLeg, TripDay, TripPlace } from '../src/domain/trip.js'

/** A place at a fixed point. */
function place(id: string, longitude: number, latitude: number): TripPlace {
  return {
    id,
    name: id,
    address: '',
    point: { longitude, latitude, coordinateSystem: 'gcj02' },
    categories: [],
    status: 'planned',
    source: { provider: 'manual', fetchedAt: '2026-09-15T00:00:00.000Z' },
  }
}

/** One stop with a start, an end and a dwell measured from them. */
function item(id: string, placeId: string, startAt: string, endAt: string, locked = false): ItineraryItem {
  return { id, placeId, startAt, endAt, plannedDurationMinutes: minutes(startAt, endAt), locked, notes: [] }
}

/** Minutes between two `YYYY-MM-DDTHH:MM` timestamps, across midnight too. */
function minutes(startAt: string, endAt: string): number {
  const start = Date.parse(`${startAt}:00Z`)
  const end = Date.parse(`${endAt}:00Z`)
  return Math.round((end - start) / 60_000)
}

/** A measured leg. */
function leg(id: string, fromItemId: string, toItemId: string, minutes: number, freshness: RouteLeg['freshness'] = 'fresh'): RouteLeg {
  return {
    id,
    fromItemId,
    toItemId,
    mode: 'walking',
    distanceMeters: minutes * 80,
    durationSeconds: minutes * 60,
    steps: [],
    freshness,
    source: { provider: 'amap-cli', fetchedAt: '2026-09-15T00:00:00.000Z' },
  }
}

const PLACES: Readonly<Record<string, TripPlace>> = {
  pa: place('pa', 116.4, 39.9),
  pb: place('pb', 116.41, 39.91),
  pc: place('pc', 116.42, 39.92),
}

/** A three-stop day: A 09:00–10:00, B 10:30–11:30, C 12:00–13:00. */
function makeDay(extras: {
  readonly items?: readonly ItineraryItem[]
  readonly legs?: readonly RouteLeg[]
} = {}): TripDay {
  return {
    id: 'd1',
    date: '2026-10-01',
    title: '第一天',
    items: extras.items ?? [
      item('a', 'pa', '2026-10-01T09:00', '2026-10-01T10:00'),
      item('b', 'pb', '2026-10-01T10:30', '2026-10-01T11:30'),
      item('c', 'pc', '2026-10-01T12:00', '2026-10-01T13:00'),
    ],
    legs: extras.legs ?? [leg('l1', 'a', 'b', 30), leg('l2', 'b', 'c', 30)],
  }
}

describe('reflowDay', () => {
  it('keeps a day in place when the order does not change', () => {
    const day = makeDay()

    const result = reflowDay({ day, places: PLACES, order: ['a', 'b', 'c'] })

    expect(result.unchanged).toBe(true)
    expect(result.retimed).toEqual([])
    expect(result.day).toBe(day)
  })

  it('re-times the day from the first clock, the dwell times and the measured travel', () => {
    const day = makeDay({
      legs: [leg('l1', 'a', 'b', 30), leg('lb', 'b', 'a', 20), leg('l2', 'b', 'c', 30), leg('la', 'a', 'c', 40)],
    })

    const result = reflowDay({ day, places: PLACES, order: ['b', 'a', 'c'] })

    // b 09:00–10:00 → +20 → a 10:20–11:20 → +40 → c 12:00–13:00
    expect(result.day.items.map((entry) => entry.id)).toEqual(['b', 'a', 'c'])
    expect(result.day.items.map((entry) => entry.startAt)).toEqual([
      '2026-10-01T09:00',
      '2026-10-01T10:20',
      '2026-10-01T12:00',
    ])
    expect(result.day.items.map((entry) => entry.endAt)).toEqual([
      '2026-10-01T10:00',
      '2026-10-01T11:20',
      '2026-10-01T13:00',
    ])
    // b and a swapped places; c never moved.
    expect(result.movedCount).toBe(2)
    // b and a both moved on the clock; c lands on its original time again.
    expect(result.retimed.map((change) => change.itemId)).toEqual(['b', 'a'])
  })

  it('pins a locked stop and re-anchors the rest of the day to it', () => {
    const day = makeDay({
      items: [
        item('a', 'pa', '2026-10-01T09:00', '2026-10-01T10:00'),
        item('b', 'pb', '2026-10-01T10:30', '2026-10-01T11:30'),
        item('c', 'pc', '2026-10-01T12:00', '2026-10-01T13:00', true),
      ],
      legs: [leg('l1', 'a', 'b', 30), leg('lb', 'b', 'a', 20), leg('la', 'a', 'c', 40), leg('l2', 'b', 'c', 30)],
    })

    const result = reflowDay({ day, places: PLACES, order: ['b', 'a', 'c'] })

    const locked = result.day.items.find((entry) => entry.id === 'c')
    expect(locked?.startAt).toBe('2026-10-01T12:00')
    expect(locked?.endAt).toBe('2026-10-01T13:00')
    // The stops before it still fit inside the gap they were given.
    expect(result.day.items[1]?.endAt).toBe('2026-10-01T11:20')
  })

  it('keeps each stop length and the timestamp shape it was stored with', () => {
    const day: TripDay = {
      ...makeDay(),
      items: [
        { id: 'a', placeId: 'pa', startAt: '2026-10-01T09:00:00+08:00', endAt: '2026-10-01T10:00:00+08:00', plannedDurationMinutes: 60, locked: false, notes: [] },
        { id: 'b', placeId: 'pb', startAt: '2026-10-01T10:30:00+08:00', endAt: '2026-10-01T11:30:00+08:00', plannedDurationMinutes: 60, locked: false, notes: [] },
      ],
      legs: [leg('lb', 'b', 'a', 30)],
    }

    const result = reflowDay({ day, places: PLACES, order: ['b', 'a'] })

    expect(result.day.items.map((entry) => entry.startAt)).toEqual([
      '2026-10-01T09:00:00+08:00',
      '2026-10-01T10:30:00+08:00',
    ])
  })

  it('flags a re-used leg as stale and leaves an unmeasured pair without one', () => {
    const day = makeDay({ legs: [leg('l1', 'a', 'b', 30), leg('l2', 'b', 'c', 30)] })

    const result = reflowDay({ day, places: PLACES, order: ['b', 'a', 'c'] })

    // b→a exists only in reverse, so it is reused and flagged; a→c was never
    // measured, so no leg is invented for it.
    expect(result.day.legs.map((entry) => entry.id)).toEqual(['l1'])
    expect(result.day.legs[0]?.fromItemId).toBe('b')
    expect(result.day.legs[0]?.toItemId).toBe('a')
    expect(result.day.legs[0]?.freshness).toBe('stale')
    expect(result.staleLegIds).toEqual(['l1'])
    expect(result.estimatedPairs).toEqual(['a→c'])
  })

  it('estimates the travel time from the coordinates when no leg was measured', () => {
    const day = makeDay({ legs: [] })

    const result = reflowDay({ day, places: PLACES, order: ['c', 'b', 'a'], mode: 'walking' })

    // ~1.5 km apart per step at ~13 min/km, so the gaps are tens of minutes
    // rather than the 30 they were stored with.
    const second = result.day.items[1]
    expect(second?.startAt?.startsWith('2026-10-01T1')).toBe(true)
    expect(result.estimatedPairs).toHaveLength(2)
    expect(result.day.legs).toEqual([])
  })

  it('rejects an order that is not a permutation of the day', () => {
    const day = makeDay()

    expect(() => reflowDay({ day, places: PLACES, order: ['a', 'b'] })).toThrow(ReflowOrderError)
    expect(() => reflowDay({ day, places: PLACES, order: ['a', 'b', 'ghost'] })).toThrow(/ghost/)
    expect(() => reflowDay({ day, places: PLACES, order: ['a', 'a', 'c'] })).toThrow(/两次/)
  })

  it('leaves the clock alone when the day has no time to anchor on', () => {
    const day = makeDay({
      items: [
        { id: 'a', placeId: 'pa', locked: false, notes: [] },
        { id: 'b', placeId: 'pb', locked: false, notes: [] },
      ],
      legs: [],
    })

    const result = reflowDay({ day, places: PLACES, order: ['b', 'a'] })

    expect(result.day.items.map((entry) => entry.id)).toEqual(['b', 'a'])
    expect(result.day.items.every((entry) => entry.startAt === undefined)).toBe(true)
    expect(result.retimed).toEqual([])
  })

  it('never mutates the day it was given', () => {
    const day = makeDay()
    const before = JSON.stringify(day)

    reflowDay({ day, places: PLACES, order: ['c', 'b', 'a'] })

    expect(JSON.stringify(day)).toBe(before)
  })

  it('is idempotent: re-timing an already re-timed day changes nothing', () => {
    const day = makeDay({ legs: [leg('lb', 'b', 'a', 20), leg('la', 'a', 'c', 40)] })

    const once = reflowDay({ day, places: PLACES, order: ['b', 'a', 'c'] })
    const twice = reflowDay({ day: once.day, places: PLACES, order: ['b', 'a', 'c'] })

    expect(twice.unchanged).toBe(true)
    expect(twice.retimed).toEqual([])
  })

  it('keeps the day date when the schedule runs past midnight', () => {
    const day = makeDay({
      items: [
        item('a', 'pa', '2026-10-01T22:00', '2026-10-01T23:00'),
        item('b', 'pb', '2026-10-01T23:30', '2026-10-02T00:30'),
      ],
      legs: [leg('lb', 'b', 'a', 30)],
    })

    const result = reflowDay({ day, places: PLACES, order: ['b', 'a'] })

    expect(result.day.items[0]?.startAt).toBe('2026-10-01T22:00')
    expect(result.day.items[1]?.startAt).toBe('2026-10-01T23:30')
  })
})
