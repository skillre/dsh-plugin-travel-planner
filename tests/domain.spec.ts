import { describe, expect, it } from 'vitest'

import { CURRENT_TRIP_SCHEMA_VERSION } from '../src/domain/trip.js'
import type {
  BudgetSummary,
  ItineraryItem,
  RouteFreshness,
  RouteLeg,
  SourceStamp,
  TravelMode,
  TravelPreferences,
  TravelerProfile,
  TripAlert,
  TripDay,
  TripPlace,
  TripProject,
  TripScenario,
  TripStatus,
  TripTransit,
} from '../src/domain/trip.js'
import { ALERT_CODES, claimsHop, summarizeAlerts, validateTrip } from '../src/domain/validation.js'
import { TripRevisionError, applyTripPatch, describePatchOps } from '../src/domain/patch.js'
import type { TripPatchOp } from '../src/domain/patch.js'
import { renderTripMarkdown } from '../src/domain/markdown.js'

/** Fixed evaluation timestamp used by every test (no clock reads in the code). */
const NOW = '2026-09-15T07:00:00+08:00'

/** Builds an ISO timestamp shifted by whole hours relative to {@link NOW}. */
function hoursFromNow(hours: number): string {
  const base = Date.parse(NOW)
  return new Date(base + hours * 60 * 60 * 1000).toISOString()
}

/** A `YYYY-MM-DD` date shifted by whole days from {@link NOW}. */
function dateIn(days: number): string {
  const base = new Date(Date.parse(NOW) + days * 86_400_000)
  return base.toISOString().slice(0, 10)
}

/** Builds a source stamp. */
function makeSource(fetchedAt: string = NOW): SourceStamp {
  return { provider: 'amap-cli', fetchedAt, providerVersion: '1.0.0' }
}

/** Builds a trip place. */
function makePlace(id: string, overrides: Partial<TripPlace> = {}): TripPlace {
  return {
    id,
    name: `地点 ${id}`,
    address: `地址 ${id}`,
    point: { longitude: 120.15, latitude: 30.28, coordinateSystem: 'gcj02' },
    categories: ['风景名胜'],
    status: 'planned',
    source: makeSource(),
    ...overrides,
  }
}

/** Optional item fields accepted by {@link makeItem}. */
interface ItemExtras {
  readonly startAt?: string
  readonly endAt?: string
  readonly plannedDurationMinutes?: number
  readonly locked?: boolean
  readonly notes?: readonly string[]
}

/** Builds an itinerary item. */
function makeItem(id: string, placeId: string, extras: ItemExtras = {}): ItineraryItem {
  const item: {
    id: string
    placeId: string
    startAt?: string
    endAt?: string
    plannedDurationMinutes?: number
    locked: boolean
    notes: readonly string[]
  } = { id, placeId, locked: extras.locked ?? false, notes: extras.notes ?? [] }
  if (extras.startAt !== undefined) item.startAt = extras.startAt
  if (extras.endAt !== undefined) item.endAt = extras.endAt
  if (extras.plannedDurationMinutes !== undefined) {
    item.plannedDurationMinutes = extras.plannedDurationMinutes
  }
  return item
}

/** Optional leg fields accepted by {@link makeLeg}. */
interface LegExtras {
  readonly mode?: TravelMode
  readonly distanceMeters?: number
  readonly durationSeconds?: number
  readonly freshness?: RouteFreshness
  readonly fetchedAt?: string
}

/** Builds a route leg. */
function makeLeg(id: string, fromItemId: string, toItemId: string, extras: LegExtras = {}): RouteLeg {
  const distance = extras.distanceMeters ?? 1200
  const duration = extras.durationSeconds ?? 960
  return {
    id,
    fromItemId,
    toItemId,
    mode: extras.mode ?? 'walking',
    distanceMeters: distance,
    durationSeconds: duration,
    steps: [{ instruction: '直行', distanceMeters: distance, durationSeconds: duration }],
    freshness: extras.freshness ?? 'fresh',
    source: makeSource(extras.fetchedAt ?? NOW),
  }
}

/** Optional day fields accepted by {@link makeDay}. */
interface DayExtras {
  readonly date?: string
  readonly title?: string
  readonly areaLabel?: string
  readonly items?: readonly ItineraryItem[]
  readonly legs?: readonly RouteLeg[]
  readonly transits?: readonly TripTransit[]
}

/** Builds one transit. */
function makeTransit(id: string, extras: Partial<TripTransit> = {}): TripTransit {
  return {
    id,
    from: { label: '西安' },
    to: { label: '成都' },
    mode: 'driving',
    distanceMeters: 723_000,
    durationSeconds: 12 * 60 * 60,
    steps: [],
    freshness: 'fresh',
    source: { provider: 'amap-cli', fetchedAt: NOW },
    ...extras,
  }
}

/** Builds a trip day. */
function makeDay(id: string, extras: DayExtras = {}): TripDay {
  const day: {
    id: string
    date: string
    title: string
    areaLabel?: string
    items: readonly ItineraryItem[]
    legs: readonly RouteLeg[]
  } = {
    id,
    date: extras.date ?? '2026-10-01',
    title: extras.title ?? id,
    items: extras.items ?? [],
    legs: extras.legs ?? [],
  }
  if (extras.areaLabel !== undefined) day.areaLabel = extras.areaLabel
  if (extras.transits !== undefined) {
    return { ...day, transits: extras.transits } as TripDay
  }
  return day
}

/** Builds a scenario. */
function makeScenario(id: string, days: readonly TripDay[]): TripScenario {
  return { id, title: `方案 ${id}`, basedOnRevision: 1, days }
}

/** Builds travel preferences. */
function makePreferences(overrides: Partial<TravelPreferences> = {}): TravelPreferences {
  return {
    pace: 'balanced',
    interests: ['美食'],
    avoid: [],
    preferredModes: ['walking', 'transit'],
    ...overrides,
  }
}

/** Optional project fields accepted by {@link makeProject}. */
interface ProjectExtras {
  readonly title?: string
  readonly status?: TripStatus
  readonly revision?: number
  readonly places?: readonly TripPlace[]
  readonly scenarios?: readonly TripScenario[]
  readonly activeScenarioId?: string
  readonly budget?: BudgetSummary
  readonly preferences?: TravelPreferences
  readonly travelers?: readonly TravelerProfile[]
  readonly destinations?: readonly string[]
  readonly startDate?: string
  readonly endDate?: string
  readonly updatedAt?: string
}

/** Builds a trip project with a single active scenario by default. */
function makeProject(extras: ProjectExtras = {}): TripProject {
  const places: Record<string, TripPlace> = {}
  for (const place of extras.places ?? []) places[place.id] = place
  return {
    schemaVersion: CURRENT_TRIP_SCHEMA_VERSION,
    id: 'trip-1',
    revision: extras.revision ?? 1,
    title: extras.title ?? '杭州三日游',
    status: extras.status ?? 'drafting',
    timezone: 'Asia/Shanghai',
    startDate: extras.startDate ?? '2026-10-01',
    endDate: extras.endDate ?? '2026-10-03',
    destinations: extras.destinations ?? ['杭州'],
    travelers: extras.travelers ?? [
      { id: 'u1', label: '我', interests: [], accessibilityNeeds: [] },
    ],
    preferences: extras.preferences ?? makePreferences(),
    constraints: [],
    places,
    scenarios: extras.scenarios ?? [makeScenario('main', [makeDay('day1')])],
    activeScenarioId: extras.activeScenarioId ?? 'main',
    budget: extras.budget ?? { currency: 'CNY' },
    alerts: [],
    createdAt: '2026-09-01T00:00:00+08:00',
    updatedAt: extras.updatedAt ?? '2026-09-01T00:00:00+08:00',
  }
}

/** Deep-freezes a value so any mutation attempt throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) deepFreeze(record[key])
    Object.freeze(value)
  }
  return value
}

/** Collects the alert codes of a validation result. */
function codes(project: TripProject, context = { now: NOW }): readonly string[] {
  return validateTrip(project, context).alerts.map((alert) => alert.code)
}

describe('validateTrip', () => {
  it('flags a place id that is missing from the place library', () => {
    const project = makeProject({
      places: [makePlace('p1')],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', { items: [makeItem('i1', 'p1'), makeItem('i2', 'ghost')] }),
        ]),
      ],
    })

    const alert = validateTrip(project, { now: NOW }).alerts.find(
      (entry) => entry.code === ALERT_CODES.placeUnknown,
    )

    expect(alert?.severity).toBe('error')
    expect(alert?.id).toBe('place-unknown:day1:i2')
    expect(alert?.relatedIds).toEqual(['ghost', 'i2'])
    expect(alert?.message).toContain('第 1 天')
    expect(alert?.suggestedActions.length).toBeGreaterThan(0)
  })

  it('flags overlapping items but not touching intervals', () => {
    const project = makeProject({
      places: [makePlace('p1'), makePlace('p2'), makePlace('p3')],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            items: [
              makeItem('i1', 'p1', {
                startAt: '2026-10-01T09:00:00+08:00',
                endAt: '2026-10-01T11:00:00+08:00',
              }),
              makeItem('i2', 'p2', {
                startAt: '2026-10-01T10:30:00+08:00',
                endAt: '2026-10-01T12:00:00+08:00',
              }),
              makeItem('i3', 'p3', {
                startAt: '2026-10-01T12:00:00+08:00',
                endAt: '2026-10-01T13:00:00+08:00',
              }),
            ],
          }),
        ]),
      ],
    })

    const overlaps = validateTrip(project, { now: NOW }).alerts.filter(
      (entry) => entry.code === ALERT_CODES.timeOverlap,
    )

    expect(overlaps).toHaveLength(1)
    expect(overlaps[0]?.id).toBe('time-overlap:day1:i1:i2')
    expect(overlaps[0]?.severity).toBe('error')
    expect(overlaps[0]?.relatedIds).toEqual(['i1', 'i2'])
  })

  it('ignores items that carry only one time bound when comparing overlaps', () => {
    const project = makeProject({
      places: [makePlace('p1'), makePlace('p2')],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            items: [
              makeItem('i1', 'p1', { startAt: '2026-10-01T09:00:00+08:00' }),
              makeItem('i2', 'p2', { startAt: '2026-10-01T09:30:00+08:00' }),
            ],
          }),
        ]),
      ],
    })

    expect(codes(project)).not.toContain(ALERT_CODES.timeOverlap)
  })

  it('flags consecutive items without a matching route leg', () => {
    const project = makeProject({
      places: [makePlace('p1'), makePlace('p2'), makePlace('p3')],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            items: [makeItem('i1', 'p1'), makeItem('i2', 'p2'), makeItem('i3', 'p3')],
            legs: [makeLeg('l1', 'i1', 'i2')],
          }),
        ]),
      ],
    })

    const missing = validateTrip(project, { now: NOW }).alerts.filter(
      (entry) => entry.code === ALERT_CODES.missingRoute,
    )

    expect(missing).toHaveLength(1)
    expect(missing[0]?.id).toBe('missing-route:day1:i2:i3')
    expect(missing[0]?.severity).toBe('warning')
    expect(missing[0]?.relatedIds).toEqual(['i2', 'i3'])
  })

  /** One day with two expired legs, dated `days` from the evaluation moment. */
  function expiredDay(days: number, legCount = 1): TripProject {
    const items = [makeItem('i1', 'p1'), makeItem('i2', 'p2'), makeItem('i3', 'p3')]
    const legs = [
      makeLeg('l1', 'i1', 'i2', { fetchedAt: hoursFromNow(-7) }),
      makeLeg('l2', 'i2', 'i3', { fetchedAt: hoursFromNow(-9) }),
    ]
    return makeProject({
      places: [makePlace('p1'), makePlace('p2'), makePlace('p3')],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            date: dateIn(days),
            items: items.slice(0, legCount + 1),
            legs: legs.slice(0, legCount),
          }),
        ]),
      ],
    })
  }

  it('grades an expired route by how close its day is', () => {
    // Two weeks out: recomputing now would only expire again before departure.
    expect(codes(expiredDay(14))).not.toContain(ALERT_CODES.routeStale)
    // Within the week: worth knowing, not worth acting on yet.
    const soon = validateTrip(expiredDay(4), { now: NOW }).alerts.filter(
      (entry) => entry.code === ALERT_CODES.routeStale,
    )
    expect(soon).toHaveLength(1)
    expect(soon[0]?.severity).toBe('info')
    // Tomorrow, today or already travelling: act on it.
    const imminent = validateTrip(expiredDay(1), { now: NOW }).alerts.filter(
      (entry) => entry.code === ALERT_CODES.routeStale,
    )
    expect(imminent[0]?.severity).toBe('warning')
    expect(imminent[0]?.suggestedActions).toEqual(['重新规划这一天交通', '或忽略本次提醒'])
  })

  it('keeps every expired route a warning in strict mode', () => {
    const strict = validateTrip(expiredDay(14), { now: NOW, routeStaleMode: 'strict' }).alerts.filter(
      (entry) => entry.code === ALERT_CODES.routeStale,
    )

    expect(strict).toHaveLength(1)
    expect(strict[0]?.severity).toBe('warning')
  })

  it('aggregates a day of expired routes into one actionable alert', () => {
    const stale = validateTrip(expiredDay(1, 2), { now: NOW }).alerts.filter(
      (entry) => entry.code === ALERT_CODES.routeStale,
    )

    expect(stale).toHaveLength(1)
    expect(stale[0]?.id).toBe('route-stale:day1')
    expect(stale[0]?.message).toContain('2 段交通')
    expect(stale[0]?.relatedIds).toEqual(['l1', 'i1', 'i2', 'l2', 'i2', 'i3'])
  })

  it('honours a custom staleness threshold and ignores fresh legs', () => {
    const project = expiredDay(1)
    const relaxed = validateTrip(project, { now: NOW, routeStaleAfterMs: 12 * 60 * 60 * 1000 })
    expect(relaxed.alerts.map((entry) => entry.code)).not.toContain(ALERT_CODES.routeStale)

    const freshProject = makeProject({
      places: [makePlace('p1'), makePlace('p2')],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            items: [makeItem('i1', 'p1'), makeItem('i2', 'p2')],
            legs: [makeLeg('l1', 'i1', 'i2', { fetchedAt: hoursFromNow(-1) })],
          }),
        ]),
      ],
    })
    expect(codes(freshProject)).not.toContain(ALERT_CODES.routeStale)
  })

  it('flags a failed route leg as an error', () => {
    const project = makeProject({
      places: [makePlace('p1'), makePlace('p2')],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            items: [makeItem('i1', 'p1'), makeItem('i2', 'p2')],
            legs: [makeLeg('l1', 'i1', 'i2', { freshness: 'failed' })],
          }),
        ]),
      ],
    })

    const failed = validateTrip(project, { now: NOW }).alerts.filter(
      (entry) => entry.code === ALERT_CODES.routeFailed,
    )

    expect(failed).toHaveLength(1)
    expect(failed[0]?.severity).toBe('error')
    expect(failed[0]?.id).toBe('route-failed:day1:l1')
  })

  it('flags a day whose total planned time exceeds 10 hours', () => {
    const heavyItems = Array.from({ length: 5 }, (_unused, index) =>
      makeItem(`i${index}`, 'p1', { plannedDurationMinutes: 130 }),
    )
    const heavy = makeProject({
      places: [makePlace('p1')],
      scenarios: [makeScenario('main', [makeDay('day1', { items: heavyItems })])],
    })

    const alerts = validateTrip(heavy, { now: NOW }).alerts
    const overloaded = alerts.filter((entry) => entry.code === ALERT_CODES.dayOverloaded)
    expect(overloaded).toHaveLength(1)
    expect(overloaded[0]?.id).toBe('day-overloaded:day1')
    expect(overloaded[0]?.relatedIds).toEqual(['day1'])
    expect(overloaded[0]?.message).toContain('10 小时')

    const light = makeProject({
      places: [makePlace('p1')],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', { items: [makeItem('i1', 'p1', { plannedDurationMinutes: 120 })] }),
        ]),
      ],
    })
    expect(codes(light)).not.toContain(ALERT_CODES.dayOverloaded)
  })

  it('flags a relaxed day that exceeds the relaxed pace budget', () => {
    const sixItems = Array.from({ length: 6 }, (_unused, index) =>
      makeItem(`i${index}`, 'p1', { plannedDurationMinutes: 30 }),
    )
    const relaxed = makeProject({
      places: [makePlace('p1')],
      preferences: makePreferences({ pace: 'relaxed' }),
      scenarios: [makeScenario('main', [makeDay('day1', { items: sixItems })])],
    })

    const alerts = validateTrip(relaxed, { now: NOW }).alerts
    expect(alerts.map((entry) => entry.code)).toContain(ALERT_CODES.paceExceeded)
    expect(alerts.find((entry) => entry.code === ALERT_CODES.paceExceeded)?.severity).toBe(
      'warning',
    )

    const balanced = makeProject({
      places: [makePlace('p1')],
      scenarios: [makeScenario('main', [makeDay('day1', { items: sixItems })])],
    })
    expect(codes(balanced)).not.toContain(ALERT_CODES.paceExceeded)

    const longRelaxedDay = makeProject({
      places: [makePlace('p1')],
      preferences: makePreferences({ pace: 'relaxed' }),
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            items: [makeItem('i1', 'p1', { plannedDurationMinutes: 9 * 60 })],
          }),
        ]),
      ],
    })
    expect(codes(longRelaxedDay)).toContain(ALERT_CODES.paceExceeded)
  })

  it('reports an info alert for an empty day', () => {
    const project = makeProject({
      scenarios: [
        makeScenario('main', [makeDay('day1'), makeDay('day2', { items: [makeItem('i1', 'p1')] })]),
      ],
      places: [makePlace('p1')],
    })

    const empty = validateTrip(project, { now: NOW }).alerts.filter(
      (entry) => entry.code === ALERT_CODES.emptyDay,
    )

    expect(empty).toHaveLength(1)
    expect(empty[0]?.severity).toBe('info')
    expect(empty[0]?.id).toBe('empty-day:day1')
    expect(empty[0]?.relatedIds).toEqual(['day1'])
  })

  it('treats a day spent driving as a full day, not an empty one', () => {
    const project = makeProject({
      scenarios: [
        makeScenario('main', [makeDay('day1', { title: '北京 → 西安｜赶路 1,077km', transits: [makeTransit('t1')] })]),
      ],
    })

    const alerts = validateTrip(project, { now: NOW }).alerts

    expect(alerts.some((entry) => entry.code === ALERT_CODES.emptyDay)).toBe(false)
    // The transit is the day's whole content, so nothing is missing either.
    expect(alerts.some((entry) => entry.code === ALERT_CODES.missingTransit)).toBe(false)
  })

  it('marks a day whose title claims a journey that nothing records', () => {
    const project = makeProject({
      scenarios: [
        makeScenario('main', [
          makeDay('day1', { title: '西安 → 成都｜翻秦岭 723km' }),
          // A recorded or planned hop leaves nothing to mark…
          makeDay('day2', { title: '成都 → 丽江｜到站 821km', transits: [makeTransit('t2')] }),
          // …and neither does a leg long enough to be the journey itself.
          makeDay('day3', {
            title: '丽江 → 大理｜175km',
            items: [makeItem('a', 'p1'), makeItem('b', 'p2')],
            legs: [
              {
                id: 'l1',
                fromItemId: 'a',
                toItemId: 'b',
                mode: 'driving',
                distanceMeters: 175_000,
                durationSeconds: 10_800,
                steps: [],
                freshness: 'fresh',
                source: { provider: 'amap-cli', fetchedAt: NOW },
              },
            ],
          }),
        ]),
      ],
      places: [makePlace('p1'), makePlace('p2')],
    })

    const missing = validateTrip(project, { now: NOW }).alerts.filter(
      (entry) => entry.code === ALERT_CODES.missingTransit,
    )

    expect(missing).toHaveLength(1)
    expect(missing[0]?.id).toBe('missing-transit:day1')
    expect(missing[0]?.severity).toBe('info')
  })

  it('counts a long-enough leg as the record even when it is short in distance', () => {
    // The panel's `usableLeg` and the host fill pass use one rule — over a
    // kilometre **or** over ten minutes — and this alert has to say the same
    // thing, or the panel offers to fill a day the domain already accepted.
    const project = makeProject({
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            title: '西安 → 成都｜翻秦岭 723km',
            items: [makeItem('a', 'p1'), makeItem('b', 'p2')],
            legs: [
              {
                id: 'l1',
                fromItemId: 'a',
                toItemId: 'b',
                mode: 'driving',
                distanceMeters: 700,
                durationSeconds: 900,
                steps: [],
                freshness: 'fresh',
                source: { provider: 'amap-cli', fetchedAt: NOW },
              },
            ],
          }),
        ]),
      ],
      places: [makePlace('p1'), makePlace('p2')],
    })

    const missing = validateTrip(project, { now: NOW }).alerts.filter(
      (entry) => entry.code === ALERT_CODES.missingTransit,
    )

    expect(missing).toEqual([])
  })

  it('still marks a day whose only leg is a placeholder', () => {
    const project = makeProject({
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            title: '西安 → 成都｜翻秦岭 723km',
            items: [makeItem('a', 'p1'), makeItem('b', 'p2')],
            legs: [
              {
                id: 'l1',
                fromItemId: 'a',
                toItemId: 'b',
                mode: 'walking',
                // Both thresholds under: what `travel_day_rebuild_legs` writes
                // when two stops resolve to the same point. It must not hide the
                // road the title states.
                distanceMeters: 300,
                durationSeconds: 240,
                steps: [],
                freshness: 'fresh',
                source: { provider: 'amap-cli', fetchedAt: NOW },
              },
            ],
          }),
        ]),
      ],
      places: [makePlace('p1'), makePlace('p2')],
    })

    const missing = validateTrip(project, { now: NOW }).alerts.filter(
      (entry) => entry.code === ALERT_CODES.missingTransit,
    )

    expect(missing).toHaveLength(1)
    expect(missing[0]?.id).toBe('missing-transit:day1')
  })

  it('only reads an arrow as a journey', () => {
    expect(claimsHop('西安 → 成都｜翻秦岭 723km')).toBe(true)
    expect(claimsHop('大理｜洱海完整一天')).toBe(false)
    expect(claimsHop('丽江 - 大理')).toBe(false)
    // A clock range uses the same arrow and is a schedule, not a change of city.
    expect(claimsHop('11:00 → 15:00 婚纱照拍摄')).toBe(false)
    expect(claimsHop('08:30 → 12:00 洱海环湖')).toBe(false)
  })

  it('renders a driving day in the Markdown plan instead of calling it empty', () => {
    const project = makeProject({
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            title: '北京 → 西安｜赶路 1,077km',
            transits: [makeTransit('t1', { distanceMeters: 1_077_000, durationSeconds: 45_480 })],
          }),
        ]),
      ],
    })

    const markdown = renderTripMarkdown(project, {})

    expect(markdown).toContain('西安 → 成都')
    expect(markdown).toContain('1077')
    expect(markdown).not.toContain('当天没有安排')
  })

  it('grades a long drive as a drive, not as an overloaded day', () => {
    const drive = makeProject({
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            title: '北京 → 西安｜赶路 1,077km',
            transits: [makeTransit('t1', { distanceMeters: 1_077_000, durationSeconds: 12.6 * 3600 })],
          }),
        ]),
      ],
    })
    const busy = makeProject({
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            items: Array.from({ length: 6 }, (_, index) =>
              makeItem(`i${String(index)}`, 'p1', { plannedDurationMinutes: 120 }),
            ),
          }),
        ]),
      ],
      places: [makePlace('p1')],
    })

    const driving = validateTrip(drive, { now: NOW }).alerts.find(
      (entry) => entry.code === ALERT_CODES.dayOverloaded,
    )
    const overloaded = validateTrip(busy, { now: NOW }).alerts.find(
      (entry) => entry.code === ALERT_CODES.dayOverloaded,
    )

    expect(driving?.message).toContain('单日驾驶偏长')
    expect(driving?.suggestedActions).toContain('中途加一晚住宿')

    // The same day written as one long leg between two stops — the shape the
    // user's own trip uses — gets the same framing.
    const asLeg = makeProject({
      places: [makePlace('p1'), makePlace('p2')],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            title: '北京 → 西安｜赶路 1,077km',
            items: [makeItem('a', 'p1'), makeItem('b', 'p2')],
            legs: [
              {
                id: 'l1',
                fromItemId: 'a',
                toItemId: 'b',
                mode: 'driving',
                distanceMeters: 1_077_000,
                durationSeconds: Math.round(12.6 * 3600),
                steps: [],
                freshness: 'fresh',
                source: { provider: 'amap-cli', fetchedAt: NOW },
              },
            ],
          }),
        ]),
      ],
    })
    const legDriving = validateTrip(asLeg, { now: NOW }).alerts.find(
      (entry) => entry.code === ALERT_CODES.dayOverloaded,
    )

    expect(legDriving?.message).toContain('单日驾驶偏长')
    expect(legDriving?.message).toContain('1077 km')
    expect(overloaded?.message).toContain('超过 10 小时上限')
    expect(overloaded?.suggestedActions).toContain('减少一个安排')
  })

  it('grades a transit like any other stretch of road', () => {
    const project = makeProject({
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            transits: [
              makeTransit('t1', { freshness: 'failed' }),
              makeTransit('t2', { source: { provider: 'title', fetchedAt: '2026-09-01T00:00:00+08:00' } }),
            ],
          }),
        ]),
      ],
    })

    const codes = validateTrip(project, { now: NOW, routeStaleMode: 'strict' }).alerts.map(
      (entry) => entry.code,
    )

    expect(codes).toContain(ALERT_CODES.routeFailed)
    expect(codes).toContain(ALERT_CODES.routeStale)
  })

  it('flags a budget overrun and a missing estimate', () => {
    const overrun = makeProject({
      budget: { currency: 'CNY', limit: 5000, estimatedTotal: 6200 },
    })
    const overrunAlerts = validateTrip(overrun, { now: NOW }).alerts
    const exceeded = overrunAlerts.find((entry) => entry.code === ALERT_CODES.budgetExceeded)
    expect(exceeded?.severity).toBe('warning')
    expect(exceeded?.message).toContain('6200')

    const unknown = makeProject({ budget: { currency: 'CNY', limit: 5000 } })
    const unknownAlert = validateTrip(unknown, { now: NOW }).alerts.find(
      (entry) => entry.code === ALERT_CODES.budgetUnknown,
    )
    expect(unknownAlert?.severity).toBe('info')

    const missingLimit = makeProject({ budget: { currency: 'CNY', estimatedTotal: 6200 } })
    expect(codes(missingLimit)).not.toContain(ALERT_CODES.budgetExceeded)
    expect(codes(missingLimit)).not.toContain(ALERT_CODES.budgetUnknown)
  })

  it('flags stale place facts using the 24 hour default', () => {
    const project = makeProject({
      places: [
        makePlace('p1', { source: makeSource(hoursFromNow(-30)) }),
        makePlace('p2', { source: makeSource(hoursFromNow(-1)) }),
      ],
    })

    const stale = validateTrip(project, { now: NOW }).alerts.filter(
      (entry) => entry.code === ALERT_CODES.placeFactStale,
    )

    expect(stale).toHaveLength(1)
    expect(stale[0]?.severity).toBe('info')
    expect(stale[0]?.relatedIds).toEqual(['p1'])
    expect(stale[0]?.id).toBe('place-fact-stale:p1')

    const projectWithCustomThreshold = validateTrip(project, {
      now: NOW,
      factStaleAfterMs: 48 * 60 * 60 * 1000,
    })
    expect(projectWithCustomThreshold.alerts.map((entry) => entry.code)).not.toContain(
      ALERT_CODES.placeFactStale,
    )
  })

  it('treats a missing active scenario as a trip without days', () => {
    const project = makeProject({
      places: [makePlace('p1')],
      scenarios: [
        makeScenario('main', [makeDay('day1', { items: [makeItem('i1', 'ghost')] })]),
      ],
      activeScenarioId: 'does-not-exist',
    })

    const result = validateTrip(project, { now: NOW })

    expect(result.alerts).toEqual([])
    expect(result.readiness).toBe(1)
  })

  it('orders alerts by severity, then code, then first related id', () => {
    const project = makeProject({
      places: [makePlace('p1'), makePlace('p2', { source: makeSource(hoursFromNow(-30)) })],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            items: [
              makeItem('i1', 'p1', {
                startAt: '2026-10-01T09:00:00+08:00',
                endAt: '2026-10-01T11:00:00+08:00',
              }),
              makeItem('i2', 'ghost', {
                startAt: '2026-10-01T10:00:00+08:00',
                endAt: '2026-10-01T12:00:00+08:00',
              }),
            ],
          }),
          makeDay('day2'),
        ]),
      ],
    })

    expect(validateTrip(project, { now: NOW }).alerts.map((entry) => entry.code)).toEqual([
      ALERT_CODES.placeUnknown,
      ALERT_CODES.timeOverlap,
      ALERT_CODES.missingRoute,
      ALERT_CODES.emptyDay,
      ALERT_CODES.placeFactStale,
    ])

    const tieBreak = makeProject({
      places: [makePlace('p1')],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            items: [makeItem('iza', 'p1'), makeItem('iaa', 'p1'), makeItem('ibb', 'p1')],
          }),
        ]),
      ],
    })
    const missingRoutes = validateTrip(tieBreak, { now: NOW }).alerts.filter(
      (entry) => entry.code === ALERT_CODES.missingRoute,
    )
    expect(missingRoutes.map((entry) => entry.id)).toEqual([
      'missing-route:day1:iaa:ibb',
      'missing-route:day1:iza:iaa',
    ])
  })

  it('derives readiness from error and warning counts', () => {
    const project = makeProject({
      places: [makePlace('p1')],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', { items: [makeItem('i1', 'p1'), makeItem('i2', 'ghost')] }),
        ]),
      ],
    })

    const result = validateTrip(project, { now: NOW })
    const counts = summarizeAlerts(result.alerts)

    expect(counts).toEqual({ error: 1, warning: 1, info: 0 })
    expect(result.readiness).toBe(0.7)

    const clean = makeProject({ places: [makePlace('p1')] })
    expect(validateTrip(clean, { now: NOW }).readiness).toBe(1)

    const manyErrors = makeProject({
      places: [],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            items: Array.from({ length: 5 }, (_unused, index) =>
              makeItem(`i${index}`, `g${index}`),
            ),
          }),
        ]),
      ],
    })
    expect(validateTrip(manyErrors, { now: NOW }).readiness).toBe(0)
    expect(validateTrip(manyErrors, { now: NOW }).alerts.length).toBeGreaterThan(5)
  })

  it('is deterministic for the same input', () => {
    const project = makeProject({
      places: [makePlace('p1', { source: makeSource(hoursFromNow(-30)) })],
      scenarios: [
        makeScenario('main', [makeDay('day1', { items: [makeItem('i1', 'p1')] })]),
      ],
      budget: { currency: 'CNY', limit: 100, estimatedTotal: 500 },
    })

    const first = validateTrip(project, { now: NOW })
    const second = validateTrip(project, { now: NOW })

    expect(first).toEqual(second)
  })
})

describe('summarizeAlerts', () => {
  it('counts each severity', () => {
    const alert = (severity: TripAlert['severity']): TripAlert => ({
      id: `${severity}-1`,
      severity,
      code: severity.toUpperCase(),
      message: 'm',
      relatedIds: [],
      suggestedActions: [],
    })

    expect(summarizeAlerts([alert('error'), alert('info'), alert('error')])).toEqual({
      error: 2,
      warning: 0,
      info: 1,
    })
    expect(summarizeAlerts([])).toEqual({ error: 0, warning: 0, info: 0 })
  })
})

describe('applyTripPatch', () => {
  const baseProject = makeProject({
    places: [makePlace('p1'), makePlace('p2'), makePlace('p3')],
    scenarios: [
      makeScenario('main', [
        makeDay('day1', {
          items: [
            makeItem('i1', 'p1', { locked: true }),
            makeItem('i2', 'p2'),
            makeItem('i3', 'p3'),
          ],
          legs: [makeLeg('l1', 'i1', 'i2')],
        }),
      ]),
      makeScenario('rainy', [makeDay('r1', { items: [makeItem('ri1', 'p1')] })]),
    ],
  })

  it('applies ops, bumps the revision, and stamps updatedAt', () => {
    const ops: readonly TripPatchOp[] = [
      { kind: 'rename-trip', title: '  杭州两日游  ' },
      { kind: 'set-status', status: 'ready' },
      { kind: 'set-budget', limit: 8000, estimatedTotal: 7200 },
      { kind: 'set-preferences', preferences: { pace: 'relaxed', avoid: ['爬山'] } },
      { kind: 'add-place', place: makePlace('p4', { name: '龙井村' }) },
      { kind: 'set-place-status', placeId: 'p1', status: 'locked' },
    ]

    const outcome = applyTripPatch(baseProject, ops, { now: NOW })

    expect(outcome.changed).toBe(true)
    expect(outcome.rejected).toEqual([])
    expect(outcome.applied).toEqual([
      'rename-trip:杭州两日游',
      'set-status:ready',
      'set-budget:CNY',
      'set-preferences:avoid+pace',
      'add-place:p4',
      'set-place-status:p1:locked',
    ])
    expect(outcome.project.revision).toBe(baseProject.revision + 1)
    expect(outcome.project.updatedAt).toBe(NOW)
    expect(outcome.project.title).toBe('杭州两日游')
    expect(outcome.project.status).toBe('ready')
    expect(outcome.project.budget).toEqual({
      currency: 'CNY',
      limit: 8000,
      estimatedTotal: 7200,
    })
    expect(outcome.project.preferences.pace).toBe('relaxed')
    expect(outcome.project.preferences.avoid).toEqual(['爬山'])
    expect(outcome.project.preferences.interests).toEqual(['美食'])
    expect(outcome.project.places['p4']?.name).toBe('龙井村')
    expect(outcome.project.places['p1']?.status).toBe('locked')
  })

  it('never mutates the input project', () => {
    const project = deepFreeze(
      makeProject({
        places: [makePlace('p1'), makePlace('p2')],
        scenarios: [
          makeScenario('main', [
            makeDay('day1', {
              items: [makeItem('i1', 'p1'), makeItem('i2', 'p2')],
              legs: [makeLeg('l1', 'i1', 'i2')],
            }),
          ]),
        ],
      }),
    )

    const outcome = applyTripPatch(
      project,
      [
        { kind: 'move-item', dayId: 'day1', itemId: 'i2' },
        { kind: 'add-item', dayId: 'day1', item: makeItem('i3', 'p1'), afterItemId: 'i1' },
        { kind: 'remove-item', dayId: 'day1', itemId: 'i1' },
        { kind: 'set-day-title', dayId: 'day1', title: '湖边漫游', areaLabel: '西湖区' },
      ],
      { now: NOW },
    )

    expect(outcome.rejected).toEqual([])
    expect(project.scenarios[0]?.days[0]?.items.map((item) => item.id)).toEqual(['i1', 'i2'])
    expect(outcome.project.scenarios[0]?.days[0]?.items.map((item) => item.id)).toEqual([
      'i3',
      'i2',
    ])
    expect(outcome.project.scenarios[0]?.days[0]?.title).toBe('湖边漫游')
    expect(outcome.project.scenarios[0]?.days[0]?.areaLabel).toBe('西湖区')
    expect(outcome.project.scenarios[0]?.days[0]?.legs).toEqual([])
  })

  it('throws a revision error instead of rejecting when expectedRevision mismatches', () => {
    const ops: readonly TripPatchOp[] = [{ kind: 'set-status', status: 'ready' }]

    try {
      applyTripPatch(baseProject, ops, { now: NOW, expectedRevision: 99 })
      expect.unreachable('applyTripPatch should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(TripRevisionError)
      const revisionError = error as TripRevisionError
      expect(revisionError.code).toBe('REVISION_MISMATCH')
      expect(revisionError.expectedRevision).toBe(99)
      expect(revisionError.actualRevision).toBe(baseProject.revision)
    }

    const matching = applyTripPatch(baseProject, ops, {
      now: NOW,
      expectedRevision: baseProject.revision,
    })
    expect(matching.changed).toBe(true)
  })

  it('records a rejection without stopping later ops', () => {
    const outcome = applyTripPatch(
      baseProject,
      [
        { kind: 'move-item', dayId: 'nope', itemId: 'i2' },
        { kind: 'set-status', status: 'checking' },
      ],
      { now: NOW },
    )

    expect(outcome.applied).toEqual(['set-status:checking'])
    expect(outcome.rejected).toEqual([
      { index: 0, kind: 'move-item', code: 'UNKNOWN_DAY', reason: '第 nope 天不存在' },
    ])
    expect(outcome.project.status).toBe('checking')
    expect(outcome.project.revision).toBe(baseProject.revision + 1)
  })

  it('does not bump the revision when every op is rejected', () => {
    const outcome = applyTripPatch(
      baseProject,
      [
        { kind: 'remove-item', dayId: 'day1', itemId: 'i1' },
        { kind: 'remove-day', dayId: 'day1' },
      ],
      { now: NOW },
    )

    expect(outcome.changed).toBe(false)
    expect(outcome.applied).toEqual([])
    expect(outcome.rejected.map((entry) => entry.code)).toEqual(['ITEM_LOCKED', 'ITEM_LOCKED'])
    expect(outcome.project).toBe(baseProject)
    expect(outcome.project.revision).toBe(baseProject.revision)
    expect(outcome.project.updatedAt).toBe(baseProject.updatedAt)
  })

  it('protects locked items from removal, moves, retiming, and day edits', () => {
    const rejected = applyTripPatch(
      baseProject,
      [
        { kind: 'remove-item', dayId: 'day1', itemId: 'i1' },
        { kind: 'move-item', dayId: 'day1', itemId: 'i1', afterItemId: 'i2' },
        { kind: 'set-item-time', dayId: 'day1', itemId: 'i1', startAt: '2026-10-01T09:00:00+08:00' },
        { kind: 'set-day-title', dayId: 'day1', title: '新标题' },
      ],
      { now: NOW },
    )

    expect(rejected.rejected.map((entry) => entry.code)).toEqual([
      'ITEM_LOCKED',
      'ITEM_LOCKED',
      'ITEM_LOCKED',
      'ITEM_LOCKED',
    ])
    expect(rejected.changed).toBe(false)
  })

  it('allows unlocking a locked item', () => {
    const outcome = applyTripPatch(
      baseProject,
      [{ kind: 'set-item-lock', dayId: 'day1', itemId: 'i1', locked: false }],
      { now: NOW },
    )

    expect(outcome.rejected).toEqual([])
    expect(outcome.applied).toEqual(['set-item-lock:day1:i1:unlocked'])
    expect(outcome.project.scenarios[0]?.days[0]?.items[0]?.locked).toBe(false)

    const unlocked = outcome.project
    const movable = applyTripPatch(
      unlocked,
      [{ kind: 'remove-item', dayId: 'day1', itemId: 'i1' }],
      { now: NOW },
    )
    expect(movable.rejected).toEqual([])
    expect(movable.project.scenarios[0]?.days[0]?.items.map((item) => item.id)).toEqual([
      'i2',
      'i3',
    ])
    expect(movable.project.scenarios[0]?.days[0]?.legs).toEqual([])
  })

  it('rejects duplicate ids', () => {
    const outcome = applyTripPatch(
      baseProject,
      [
        { kind: 'add-place', place: makePlace('p1') },
        { kind: 'add-item', dayId: 'day1', item: makeItem('ri1', 'p1') },
        { kind: 'add-day', day: makeDay('day1') },
      ],
      { now: NOW },
    )

    expect(outcome.rejected.map((entry) => entry.code)).toEqual([
      'DUPLICATE_ID',
      'DUPLICATE_ID',
      'DUPLICATE_ID',
    ])
    expect(outcome.rejected.map((entry) => entry.kind)).toEqual([
      'add-place',
      'add-item',
      'add-day',
    ])
    expect(outcome.changed).toBe(false)
  })

  it('rejects unknown references', () => {
    const outcome = applyTripPatch(
      baseProject,
      [
        { kind: 'add-item', dayId: 'day9', item: makeItem('x1', 'p1') },
        { kind: 'remove-item', dayId: 'day1', itemId: 'zz' },
        { kind: 'move-item', dayId: 'day1', itemId: 'i2', afterItemId: 'zz' },
        { kind: 'set-place-status', placeId: 'zz', status: 'excluded' },
        { kind: 'set-active-scenario', scenarioId: 'zz' },
        { kind: 'remove-day', dayId: 'day9' },
        { kind: 'set-leg', dayId: 'day1', leg: makeLeg('l2', 'i1', 'zz') },
      ],
      { now: NOW },
    )

    expect(outcome.rejected.map((entry) => entry.code)).toEqual([
      'UNKNOWN_DAY',
      'UNKNOWN_ITEM',
      'UNKNOWN_ITEM',
      'UNKNOWN_PLACE',
      'UNKNOWN_SCENARIO',
      'UNKNOWN_DAY',
      'UNKNOWN_ITEM',
    ])
  })

  it('rejects malformed values', () => {
    const outcome = applyTripPatch(
      baseProject,
      [
        { kind: 'set-budget' },
        { kind: 'set-budget', limit: -1 },
        { kind: 'rename-trip', title: '   ' },
        { kind: 'set-preferences', preferences: {} },
        { kind: 'set-item-time', dayId: 'day1', itemId: 'i2' },
        {
          kind: 'set-item-time',
          dayId: 'day1',
          itemId: 'i2',
          startAt: '2026-10-01T12:00:00+08:00',
          endAt: '2026-10-01T11:00:00+08:00',
        },
        { kind: 'remove-leg', dayId: 'day1', legId: 'zz' },
      ],
      { now: NOW },
    )

    expect(outcome.rejected.map((entry) => entry.code)).toEqual([
      'INVALID_VALUE',
      'INVALID_VALUE',
      'INVALID_VALUE',
      'INVALID_VALUE',
      'INVALID_VALUE',
      'INVALID_VALUE',
      'INVALID_VALUE',
    ])
  })

  it('moves items to an anchor or to the end of the day', () => {
    const toFrontOfTail = applyTripPatch(
      baseProject,
      [{ kind: 'move-item', dayId: 'day1', itemId: 'i3', afterItemId: 'i2' }],
      { now: NOW },
    )
    expect(toFrontOfTail.project.scenarios[0]?.days[0]?.items.map((item) => item.id)).toEqual([
      'i1',
      'i2',
      'i3',
    ])

    const toStart = applyTripPatch(
      baseProject,
      [{ kind: 'move-item', dayId: 'day1', itemId: 'i3', afterItemId: 'i2' }],
      { now: NOW },
    )
    const movedToEnd = applyTripPatch(
      toStart.project,
      [{ kind: 'move-item', dayId: 'day1', itemId: 'i2' }],
      { now: NOW },
    )
    expect(movedToEnd.project.scenarios[0]?.days[0]?.items.map((item) => item.id)).toEqual([
      'i1',
      'i3',
      'i2',
    ])
    expect(movedToEnd.applied).toEqual(['move-item:day1:i2'])
  })

  it('applies later ops against the state produced by earlier ops', () => {
    const outcome = applyTripPatch(
      baseProject,
      [
        { kind: 'set-active-scenario', scenarioId: 'rainy' },
        { kind: 'add-day', day: makeDay('r2', { items: [makeItem('ri2', 'p2')] }) },
        { kind: 'set-day-title', dayId: 'r2', title: '雨天室内' },
        { kind: 'add-item', dayId: 'r1', item: makeItem('ri3', 'p3'), afterItemId: 'ri1' },
      ],
      { now: NOW },
    )

    expect(outcome.rejected).toEqual([])
    expect(outcome.project.activeScenarioId).toBe('rainy')
    const rainy = outcome.project.scenarios.find((scenario) => scenario.id === 'rainy')
    expect(rainy?.days.map((day) => day.id)).toEqual(['r1', 'r2'])
    expect(rainy?.days[1]?.title).toBe('雨天室内')
    expect(rainy?.days[0]?.items.map((item) => item.id)).toEqual(['ri1', 'ri3'])
    const main = outcome.project.scenarios.find((scenario) => scenario.id === 'main')
    expect(main?.days[0]?.items.map((item) => item.id)).toEqual(['i1', 'i2', 'i3'])
  })

  it('inserts and replaces route legs inside one day only', () => {
    const inserted = applyTripPatch(
      baseProject,
      [{ kind: 'set-leg', dayId: 'day1', leg: makeLeg('l2', 'i2', 'i3', { mode: 'transit' }) }],
      { now: NOW },
    )
    expect(inserted.rejected).toEqual([])
    expect(inserted.project.scenarios[0]?.days[0]?.legs.map((leg) => leg.id)).toEqual(['l1', 'l2'])

    const replaced = applyTripPatch(
      inserted.project,
      [
        {
          kind: 'set-leg',
          dayId: 'day1',
          leg: makeLeg('l2', 'i2', 'i3', { mode: 'driving', distanceMeters: 4200 }),
        },
      ],
      { now: NOW },
    )
    const legs = replaced.project.scenarios[0]?.days[0]?.legs ?? []
    expect(legs).toHaveLength(2)
    expect(legs[1]?.mode).toBe('driving')
    expect(legs[1]?.distanceMeters).toBe(4200)
  })

  it('records a day\'s transit without needing a stop to hang it on', () => {
    const written = applyTripPatch(
      baseProject,
      [{ kind: 'set-day-transit', dayId: 'day1', transit: makeTransit('t1', { from: { placeId: 'p1', label: '杭州' } }) }],
      { now: NOW },
    )

    expect(written.rejected).toEqual([])
    const day = written.project.scenarios[0]?.days[0]
    expect(day?.transits?.map((transit) => transit.id)).toEqual(['t1'])
    expect(day?.transits?.[0]?.from).toEqual({ placeId: 'p1', label: '杭州' })
    // The stop list is untouched: a transit is not a place to visit.
    expect(day?.items.map((item) => item.id)).toEqual(['i1', 'i2', 'i3'])

    const replaced = applyTripPatch(
      written.project,
      [{ kind: 'set-day-transit', dayId: 'day1', transit: makeTransit('t1', { distanceMeters: 900_000 }) }],
      { now: NOW },
    )
    expect(replaced.project.scenarios[0]?.days[0]?.transits).toHaveLength(1)
    expect(replaced.project.scenarios[0]?.days[0]?.transits?.[0]?.distanceMeters).toBe(900_000)

    const cleared = applyTripPatch(replaced.project, [{ kind: 'remove-day-transit', dayId: 'day1', transitId: 't1' }], {
      now: NOW,
    })
    expect(cleared.project.scenarios[0]?.days[0]?.transits).toBeUndefined()
  })

  it('rejects a transit that names nothing, an unknown place or an unknown day', () => {
    const unknownPlace = applyTripPatch(
      baseProject,
      [{ kind: 'set-day-transit', dayId: 'day1', transit: makeTransit('t1', { to: { placeId: 'ghost', label: '' } }) }],
      { now: NOW },
    )
    const nameless = applyTripPatch(
      baseProject,
      [{ kind: 'set-day-transit', dayId: 'day1', transit: makeTransit('t1', { from: { label: '  ' }, to: { label: '西安' } }) }],
      { now: NOW },
    )
    const unknownDay = applyTripPatch(
      baseProject,
      [{ kind: 'set-day-transit', dayId: 'day9', transit: makeTransit('t1') }],
      { now: NOW },
    )
    const missing = applyTripPatch(
      baseProject,
      [{ kind: 'remove-day-transit', dayId: 'day1', transitId: 't9' }],
      { now: NOW },
    )

    expect(unknownPlace.rejected[0]?.code).toBe('UNKNOWN_PLACE')
    expect(nameless.rejected[0]?.code).toBe('INVALID_VALUE')
    expect(unknownDay.rejected[0]?.code).toBe('UNKNOWN_DAY')
    expect(missing.rejected[0]?.code).toBe('INVALID_VALUE')
  })

  it('keeps a geocoded coordinate on an end that is only a name', () => {
    const point = { longitude: 108.93977, latitude: 34.341574, coordinateSystem: 'gcj02' as const }
    const written = applyTripPatch(
      baseProject,
      [
        {
          kind: 'set-day-transit',
          dayId: 'day1',
          transit: makeTransit('t1', { from: { label: '西安', point }, to: { label: '成都' } }),
        },
      ],
      { now: NOW },
    )

    // 「西安」 stays a name and gains the point its geocode produced: that pair is
    // what lets the map draw a day with no stops on it.
    expect(written.rejected).toEqual([])
    expect(written.project.scenarios[0]?.days[0]?.transits?.[0]?.from).toEqual({ label: '西安', point })

    const outOfRange = applyTripPatch(
      baseProject,
      [
        {
          kind: 'set-day-transit',
          dayId: 'day1',
          transit: makeTransit('t1', {
            from: { label: '西安', point: { ...point, latitude: 120 } },
            to: { label: '成都' },
          }),
        },
      ],
      { now: NOW },
    )
    expect(outOfRange.rejected[0]?.code).toBe('INVALID_VALUE')
  })

  it('writes the version it now carries, and moves a transit with its day', () => {
    const v1 = { ...baseProject, schemaVersion: 1 as const }
    const written = applyTripPatch(
      v1 as unknown as TripProject,
      [{ kind: 'set-day-transit', dayId: 'day1', transit: makeTransit('t1') }],
      { now: NOW },
    )

    // The document now holds a field this build introduced, so it says so; a
    // reader that only knows version 1 would otherwise trust a lie.
    expect(written.project.schemaVersion).toBe(CURRENT_TRIP_SCHEMA_VERSION)

    // A re-date takes the day's road with it: a transit whose clocks stay on the
    // old date contradicts the day it sits under.
    const moved = applyTripPatch(
      makeProject({
        scenarios: [
          makeScenario('main', [
            makeDay('day1', {
              date: '2026-10-01',
              transits: [makeTransit('t1', { departAt: '2026-10-01T06:00:00+08:00', arriveAt: '2026-10-02T04:30:00+08:00' })],
            }),
            makeDay('day2', { date: '2026-10-02' }),
          ]),
        ],
        startDate: '2026-10-01',
        endDate: '2026-10-02',
      }),
      [{ kind: 'set-trip-dates', startDate: '2026-10-10' }],
      { now: NOW },
    )
    const day = moved.project.scenarios[0]?.days[0]
    expect(day?.date).toBe('2026-10-10')
    expect(day?.transits?.[0]?.departAt).toBe('2026-10-10T06:00:00+08:00')
    // A night drive lands the next day, which moves with it.
    expect(day?.transits?.[0]?.arriveAt).toBe('2026-10-11T04:30:00+08:00')
  })

  it('removes a day of the active scenario and reports an empty op list as unchanged', () => {
    const blocked = applyTripPatch(baseProject, [{ kind: 'remove-day', dayId: 'day1' }], {
      now: NOW,
    })
    expect(blocked.rejected.map((entry) => entry.code)).toEqual(['ITEM_LOCKED'])

    const removed = applyTripPatch(
      baseProject,
      [
        { kind: 'set-active-scenario', scenarioId: 'rainy' },
        { kind: 'remove-day', dayId: 'r1' },
      ],
      { now: NOW },
    )
    expect(removed.applied).toEqual(['set-active-scenario:rainy', 'remove-day:r1'])
    expect(
      removed.project.scenarios.find((scenario) => scenario.id === 'rainy')?.days,
    ).toEqual([])
    expect(
      removed.project.scenarios.find((scenario) => scenario.id === 'main')?.days,
    ).toHaveLength(1)

    const untouched = applyTripPatch(baseProject, [], { now: NOW })
    expect(untouched.changed).toBe(false)
    expect(untouched.project).toBe(baseProject)
  })

  it('removes a route leg of the active day', () => {
    const outcome = applyTripPatch(
      baseProject,
      [{ kind: 'remove-leg', dayId: 'day1', legId: 'l1' }],
      { now: NOW },
    )

    expect(outcome.rejected).toEqual([])
    expect(outcome.applied).toEqual(['remove-leg:day1:l1'])
    expect(outcome.project.scenarios[0]?.days[0]?.legs).toEqual([])
    expect(outcome.project.scenarios[0]?.days[0]?.items).toHaveLength(3)
  })

  it('returns a frozen input project untouched when only rejected ops are submitted', () => {
    const project = deepFreeze(
      makeProject({
        places: [makePlace('p1')],
        scenarios: [makeScenario('main', [makeDay('day1', { items: [makeItem('i1', 'p1')] })])],
      }),
    )

    const outcome = applyTripPatch(project, [{ kind: 'remove-day', dayId: 'day1' }], {
      now: NOW,
    })

    expect(outcome.changed).toBe(true)
    expect(outcome.project.scenarios[0]?.days).toEqual([])
    expect(project.scenarios[0]?.days).toHaveLength(1)
  })
})

describe('describePatchOps', () => {
  it('describes every op in order using user-facing Chinese', () => {
    const ops: readonly TripPatchOp[] = [
      { kind: 'rename-trip', title: '杭州两日游' },
      { kind: 'set-status', status: 'ready' },
      { kind: 'move-item', dayId: 'day1', itemId: 'i3', afterItemId: 'i1' },
      { kind: 'set-item-lock', dayId: 'day1', itemId: 'i3', locked: true },
      { kind: 'remove-day', dayId: 'day2' },
    ]

    const described = describePatchOps(ops)

    expect(described).toHaveLength(ops.length)
    expect(described[0]).toContain('杭州两日游')
    expect(described[1]).toContain('就绪')
    expect(described[2]).toContain('i1 之后')
    expect(described[3]).toContain('锁定')
    expect(described[4]).toContain('day2')
  })
})

describe('renderTripMarkdown', () => {
  const project = makeProject({
    title: '杭州两日游',
    destinations: ['杭州'],
    startDate: '2026-10-01',
    endDate: '2026-10-02',
    travelers: [
      { id: 'u1', label: '我', interests: [], accessibilityNeeds: [] },
      { id: 'u2', label: '小王', interests: [], accessibilityNeeds: [] },
    ],
    budget: { currency: 'CNY', limit: 5000, estimatedTotal: 4200, confirmedTotal: 1500 },
    places: [
      makePlace('p1', { name: '西湖', categories: ['风景名胜', '公园'] }),
      makePlace('p2', { name: '楼外楼', categories: ['餐厅'] }),
      makePlace('p3', { name: '灵隐寺', categories: ['寺庙'] }),
    ],
    scenarios: [
      makeScenario('main', [
        makeDay('day1', {
          date: '2026-10-01',
          title: '西湖漫步',
          areaLabel: '西湖区',
          items: [
            makeItem('i1', 'p1', {
              startAt: '2026-10-01T09:00:00+08:00',
              endAt: '2026-10-01T11:00:00+08:00',
              plannedDurationMinutes: 120,
            }),
            makeItem('i2', 'p2', {
              startAt: '2026-10-01T11:30:00+08:00',
              endAt: '2026-10-01T12:30:00+08:00',
              plannedDurationMinutes: 60,
              locked: true,
            }),
          ],
          legs: [makeLeg('l1', 'i1', 'i2', { distanceMeters: 1200, durationSeconds: 960 })],
        }),
        makeDay('day2', {
          date: '2026-10-02',
          title: '灵隐问禅',
          items: [
            makeItem('i3', 'p3', {
              startAt: '2026-10-02T09:30:00+08:00',
              endAt: '2026-10-02T11:00:00+08:00',
              plannedDurationMinutes: 90,
            }),
            makeItem('i4', 'ghost'),
          ],
        }),
      ]),
    ],
  })

  it('renders title, meta block, both days, budget, and footer', () => {
    const markdown = renderTripMarkdown(project, { generatedAt: NOW })

    expect(markdown.startsWith('# 杭州两日游\n')).toBe(true)
    expect(markdown).toContain('- 日期范围：2026-10-01 至 2026-10-02')
    expect(markdown).toContain('- 同行人：我、小王')
    expect(markdown).toContain('- 目的地：杭州')
    expect(markdown).toContain('- 当前方案：方案 main')
    expect(markdown).toContain('- 状态：草稿中（drafting）')
    expect(markdown).toContain('- 预算：CNY 5000（估算 4200，已确认 1500）')

    expect(markdown).toContain('## Day 1 · 西湖漫步')
    expect(markdown).toContain('## Day 2 · 灵隐问禅')
    expect(markdown).toContain('_区域：西湖区_')
    expect(markdown).toContain('**09:00–11:00** · 西湖 · 风景名胜、公园 · 停留 120 分钟')
    expect(markdown).toContain('**11:30–12:30** · 楼外楼 · 餐厅 · 停留 60 分钟 · 已锁定')
    expect(markdown).toContain('  - 交通：步行 1.2 km · 16 min')
    expect(markdown).toContain('**09:30–11:00** · 灵隐寺 · 寺庙 · 停留 90 分钟')
    expect(markdown).toContain('(未知地点 ghost)')

    expect(markdown).toContain('## 预算')
    expect(markdown).toContain('- 预算上限：5000')
    expect(markdown).toContain('- 估算总额：4200')
    expect(markdown).toContain('- 已确认支出：1500')
    expect(markdown).toContain('- 预算结余：800')

    expect(markdown).toContain(`生成时间：${NOW}`)
    expect(markdown).toContain('修订 r1')
    expect(markdown).toContain('高德（AMap）')
    expect(markdown.endsWith('\n')).toBe(true)
  })

  it('omits the reminder section without alerts and renders one with alerts', () => {
    const withoutAlerts = renderTripMarkdown(project)
    expect(withoutAlerts).not.toContain('## 提醒')
    expect(withoutAlerts).not.toContain('生成时间：')

    const alerts: readonly TripAlert[] = [
      {
        id: 'time-overlap:day1:i1:i2',
        severity: 'error',
        code: 'TIME_OVERLAP',
        message: '第 1 天的「西湖」与「楼外楼」时间重叠。',
        relatedIds: ['i1', 'i2'],
        suggestedActions: ['调整其中一个的开始时间'],
      },
      {
        id: 'budget-unknown',
        severity: 'info',
        code: 'BUDGET_UNKNOWN',
        message: '已设置预算上限，但还没有估算总额。',
        relatedIds: [],
        suggestedActions: [],
      },
    ]

    const withAlerts = renderTripMarkdown(project, { alerts })

    expect(withAlerts).toContain('## 提醒')
    expect(withAlerts).toContain('- ❌ 错误：第 1 天的「西湖」与「楼外楼」时间重叠。（相关：i1, i2）')
    expect(withAlerts).toContain('- ℹ️ 提示：已设置预算上限，但还没有估算总额。')
  })

  it('marks missing and failed transport legs', () => {
    const markdown = renderTripMarkdown(project)
    expect(markdown).toContain('  - 交通：待规划')

    const failedLegProject = makeProject({
      places: [makePlace('p1'), makePlace('p2')],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            items: [makeItem('i1', 'p1'), makeItem('i2', 'p2')],
            legs: [makeLeg('l1', 'i1', 'i2', { freshness: 'failed' })],
          }),
        ]),
      ],
    })
    expect(renderTripMarkdown(failedLegProject)).toContain('  - 交通：规划失败，需要重新规划')
  })

  it('renders an empty day and an unknown scenario without crashing', () => {
    const orphanProject = makeProject({
      scenarios: [makeScenario('main', [makeDay('day1')])],
      activeScenarioId: 'missing',
    })

    const markdown = renderTripMarkdown(orphanProject)

    expect(markdown).toContain('- 当前方案：未选择方案')
    expect(markdown).not.toContain('## Day 1')
  })

  it('is deterministic and never mutates its input', () => {
    const frozen = deepFreeze(project)

    const first = renderTripMarkdown(frozen, { generatedAt: NOW })
    const second = renderTripMarkdown(frozen, { generatedAt: NOW })

    expect(first).toBe(second)
    expect(frozen.scenarios[0]?.days[0]?.items).toHaveLength(2)
  })
})

describe('set-trip-dates', () => {
  /** A three-day project whose items carry dated timestamps. */
  const dated = makeProject({
    places: [makePlace('p1'), makePlace('p2')],
    startDate: '2026-10-16',
    endDate: '2026-10-18',
    scenarios: [
      makeScenario('main', [
        makeDay('d1', {
          date: '2026-10-16',
          items: [makeItem('i1', 'p1', { startAt: '2026-10-16T09:00', endAt: '2026-10-16T11:00' })],
        }),
        makeDay('d2', {
          date: '2026-10-17',
          items: [
            makeItem('i2', 'p2', { startAt: '2026-10-17T08:30', endAt: '2026-10-17T10:00', locked: true }),
            makeItem('i3', 'p1', { startAt: '2026-10-17T10:30', endAt: '2026-10-17T12:00' }),
          ],
        }),
        makeDay('d3', { date: '2026-10-18' }),
      ]),
    ],
  })

  it('moves the whole plan to a new range and keeps each time of day', () => {
    const outcome = applyTripPatch(dated, [{ kind: 'set-trip-dates', startDate: '2026-09-25' }], { now: NOW })

    expect(outcome.changed).toBe(true)
    expect(outcome.rejected).toEqual([])
    expect(outcome.project.startDate).toBe('2026-09-25')
    expect(outcome.project.endDate).toBe('2026-09-27')
    const days = outcome.project.scenarios[0]?.days ?? []
    expect(days.map((day) => day.date)).toEqual(['2026-09-25', '2026-09-26', '2026-09-27'])
    const [first, second] = days
    expect(first?.items[0]?.startAt).toBe('2026-09-25T09:00')
    expect(first?.items[0]?.endAt).toBe('2026-09-25T11:00')
    expect(second?.items[0]?.startAt).toBe('2026-09-26T08:30')
    expect(second?.items[1]?.endAt).toBe('2026-09-26T12:00')
  })

  it('shifts locked items with their day instead of refusing the operation', () => {
    const outcome = applyTripPatch(dated, [{ kind: 'set-trip-dates', startDate: '2026-09-25' }], { now: NOW })

    const locked = outcome.project.scenarios[0]?.days[1]?.items.find((item) => item.id === 'i2')
    expect(locked?.locked).toBe(true)
    expect(locked?.startAt).toBe('2026-09-26T08:30')
  })

  it('rejects a range that disagrees with the number of days', () => {
    const outcome = applyTripPatch(
      dated,
      [{ kind: 'set-trip-dates', startDate: '2026-09-25', endDate: '2026-10-05' }],
      { now: NOW },
    )

    expect(outcome.changed).toBe(false)
    expect(outcome.rejected[0]?.code).toBe('INVALID_VALUE')
    expect(outcome.rejected[0]?.reason).toContain('2026-09-25 ~ 2026-09-27')
  })

  it('changes only the trip header when redateDays is false', () => {
    const outcome = applyTripPatch(
      dated,
      [{ kind: 'set-trip-dates', startDate: '2026-11-01', endDate: '2026-11-03', redateDays: false }],
      { now: NOW },
    )

    expect(outcome.project.startDate).toBe('2026-11-01')
    expect(outcome.project.endDate).toBe('2026-11-03')
    expect(outcome.project.scenarios[0]?.days.map((day) => day.date)).toEqual([
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ])
  })

  it('rejects impossible and backwards dates', () => {
    const impossible = applyTripPatch(dated, [{ kind: 'set-trip-dates', startDate: '2026-02-31' }], { now: NOW })
    expect(impossible.rejected[0]?.code).toBe('INVALID_VALUE')
    expect(impossible.rejected[0]?.reason).toContain('2026-02-31')

    const backwards = applyTripPatch(
      dated,
      [{ kind: 'set-trip-dates', startDate: '2026-09-25', endDate: '2026-09-20' }],
      { now: NOW },
    )
    expect(backwards.rejected[0]?.code).toBe('INVALID_VALUE')
    expect(backwards.rejected[0]?.reason).toContain('不能早于')
  })

  it('derives the end date from the day count when the range is omitted', () => {
    const singleDay = makeProject({ startDate: '2026-10-01', endDate: '2026-10-01' })
    const outcome = applyTripPatch(singleDay, [{ kind: 'set-trip-dates', startDate: '2026-12-24' }], { now: NOW })

    expect(outcome.project.startDate).toBe('2026-12-24')
    expect(outcome.project.endDate).toBe('2026-12-24')
  })

  it('does not mutate its input', () => {
    const frozen = deepFreeze(dated)
    applyTripPatch(frozen, [{ kind: 'set-trip-dates', startDate: '2026-09-25' }], { now: NOW })

    expect(frozen.startDate).toBe('2026-10-16')
    expect(frozen.scenarios[0]?.days[0]?.date).toBe('2026-10-16')
  })

  it('describes the operation in Chinese', () => {
    expect(describePatchOps([{ kind: 'set-trip-dates', startDate: '2026-09-25' }])).toEqual([
      '把行程日期改为 2026-09-25（各天按顺序顺延）',
    ])
    expect(describePatchOps([{ kind: 'set-trip-dates', startDate: '2026-09-25', endDate: '2026-09-27', redateDays: false }])).toEqual([
      '把行程日期改为 2026-09-25 ~ 2026-09-27（各天日期不变）',
    ])
  })
})
