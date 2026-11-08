/**
 * Deterministic validation over the active scenario of a Trip Project.
 *
 * The module is pure: it never reads the clock (the caller passes `now`), never
 * touches the filesystem or the network, and never mutates its input. Every
 * alert carries a deterministic id, so the same project and context always
 * produce the same alert list and readiness score.
 */

import type {
  AlertSeverity,
  ItineraryItem,
  RouteFreshness,
  RouteLeg,
  TripAlert,
  TripDay,
  TripProject,
} from './trip.js'

/** Alert codes keyed by a readable name. */
const CODES = {
  placeUnknown: 'PLACE_UNKNOWN',
  timeOverlap: 'TIME_OVERLAP',
  missingRoute: 'MISSING_ROUTE',
  missingTransit: 'MISSING_TRANSIT',
  routeStale: 'ROUTE_STALE',
  routeFailed: 'ROUTE_FAILED',
  dayOverloaded: 'DAY_OVERLOADED',
  paceExceeded: 'PACE_EXCEEDED',
  emptyDay: 'EMPTY_DAY',
  budgetExceeded: 'BUDGET_EXCEEDED',
  budgetUnknown: 'BUDGET_UNKNOWN',
  placeFactStale: 'PLACE_FACT_STALE',
} as const

/**
 * Stable alert code constants keyed by a readable name.
 *
 * Consumers compare against `ALERT_CODES.timeOverlap` and friends instead of
 * hard-coding the string literals.
 */
export const ALERT_CODES: Readonly<Record<string, string>> = CODES

/** Default age after which a route leg counts as stale (6 hours). */
const DEFAULT_ROUTE_STALE_AFTER_MS = 6 * 60 * 60 * 1000

/** Default age after which a place fact counts as stale (24 hours). */
const DEFAULT_FACT_STALE_AFTER_MS = 24 * 60 * 60 * 1000

/** Total time budget of one day before it counts as overloaded (10 hours). */
const DAY_OVERLOAD_SECONDS = 10 * 60 * 60

/**
 * Thresholds at which a leg records a real move: over a kilometre, or over ten
 * minutes.
 *
 * One rule, three implementations: the panel's `usableLeg` (src/client/index.ts),
 * the host fill pass's `recordsMove` (src/host/transit-fill.ts) and the one just
 * below. They must stay synonyms. All three answer the same question — does this
 * day already record its road? — and a disagreement shows up as a fill button
 * offered for a day the domain already accepted, or a 「跨城交通未记录」 alert with
 * nothing the user can do about it.
 */
const MIN_TRANSIT_METERS = 1_000
const MIN_TRANSIT_SECONDS = 600

/** Whether one leg records a real move rather than a two-stop placeholder. */
function recordsMove(leg: RouteLeg): boolean {
  return leg.distanceMeters >= MIN_TRANSIT_METERS || leg.durationSeconds >= MIN_TRANSIT_SECONDS
}

/** From this distance on, a day's time is the road's and not the itinerary's. */
const DRIVE_FRAMING_METERS = 100_000

/**
 * Share of a day's moving time that has to be transit before the day reads as a
 * driving day rather than an over-booked one.
 */
const TRANSIT_DOMINATED_SHARE = 0.8

/** Maximum number of items a relaxed day may hold. */
const RELAXED_PACE_MAX_ITEMS = 5

/** Maximum total seconds a relaxed day may hold (8 hours). */
const RELAXED_PACE_MAX_SECONDS = 8 * 60 * 60

/** Sort rank per alert severity; a lower rank sorts first. */
const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
}

/**
 * Evaluation inputs for {@link validateTrip}.
 */
export interface ValidationContext {
  /** Evaluation timestamp in ISO 8601 form. */
  readonly now: string
  /** Route data older than this many milliseconds is flagged; defaults to 6 hours. */
  readonly routeStaleAfterMs?: number
  /** Place facts older than this many milliseconds are flagged; defaults to 24 hours. */
  readonly factStaleAfterMs?: number
  /**
   * How `ROUTE_STALE` weighs against the trip's own dates.
   *
   * - `adaptive` (default): an expired route only matters when the day it
   *   serves is near. Recomputing a route months out would only expire again, so
   *   far-away days produce no alert, days within a week produce an `info` note,
   *   and days within a day (or already under way) produce a `warning`.
   * - `strict`: every expired route is a `warning`, whatever the date.
   */
  readonly routeStaleMode?: RouteStaleMode
}

/** How strictly route staleness is graded. */
export type RouteStaleMode = 'adaptive' | 'strict'

/** A day is "far" beyond this many days until departure. */
const ROUTE_STALE_FAR_DAYS = 7

/** A day is "imminent" at or below this many days until departure. */
const ROUTE_STALE_IMMINENT_DAYS = 1

/**
 * Outcome of one validation pass.
 */
export interface ValidationResult {
  /** Alerts ordered by severity, then code, then first related id. */
  readonly alerts: readonly TripAlert[]
  /** Readiness score between 0 and 1, rounded to two decimals. */
  readonly readiness: number
}

/**
 * Validates a trip project against the rules of the product design.
 *
 * @param project - Trip project to inspect; never mutated by this function.
 * @param context - Evaluation timestamp plus optional staleness thresholds.
 * @returns The deterministically ordered alert list and the readiness score.
 */
export function validateTrip(project: TripProject, context: ValidationContext): ValidationResult {
  const alerts: TripAlert[] = []
  const days = resolveActiveDays(project)
  const nowMs = parseTimestamp(context.now)
  const routeStaleAfterMs = context.routeStaleAfterMs ?? DEFAULT_ROUTE_STALE_AFTER_MS
  const factStaleAfterMs = context.factStaleAfterMs ?? DEFAULT_FACT_STALE_AFTER_MS
  const routeStaleMode = context.routeStaleMode ?? 'adaptive'

  days.forEach((day, dayIndex) => {
    collectDayAlerts(project, day, dayIndex, nowMs, routeStaleAfterMs, routeStaleMode, alerts)
  })
  collectPlaceAlerts(project, nowMs, factStaleAfterMs, alerts)
  collectBudgetAlerts(project, alerts)

  const sorted = [...alerts].sort(compareAlerts)
  const counts = summarizeAlerts(sorted)
  return {
    alerts: sorted,
    readiness: computeReadiness(counts.error, counts.warning),
  }
}

/**
 * Counts alerts per severity.
 *
 * @param alerts - Alerts to count.
 * @returns The number of error, warning, and info alerts.
 */
export function summarizeAlerts(
  alerts: readonly TripAlert[],
): { readonly error: number; readonly warning: number; readonly info: number } {
  let error = 0
  let warning = 0
  let info = 0
  for (const alert of alerts) {
    if (alert.severity === 'error') error += 1
    else if (alert.severity === 'warning') warning += 1
    else info += 1
  }
  return { error, warning, info }
}

/**
 * Resolves the days of the active scenario.
 *
 * @param project - Trip project to read.
 * @returns The active scenario days, or an empty list when no scenario matches.
 */
function resolveActiveDays(project: TripProject): readonly TripDay[] {
  const scenario = project.scenarios.find((entry) => entry.id === project.activeScenarioId)
  return scenario === undefined ? [] : scenario.days
}

/**
 * Collects every day-level alert of one day.
 *
 * @param project - Trip project that owns the day.
 * @param day - Day under inspection.
 * @param dayIndex - Zero-based position of the day inside the active scenario.
 * @param nowMs - Parsed evaluation timestamp, or undefined when unparsable.
 * @param routeStaleAfterMs - Route staleness threshold in milliseconds.
 * @param routeStaleMode - How strictly route staleness is graded.
 * @param sink - Mutable alert accumulator owned by the caller.
 * @returns Nothing; alerts are appended to `sink`.
 */
function collectDayAlerts(
  project: TripProject,
  day: TripDay,
  dayIndex: number,
  nowMs: number | undefined,
  routeStaleAfterMs: number,
  routeStaleMode: RouteStaleMode,
  sink: TripAlert[],
): void {
  const dayOrder = dayIndex + 1
  const items = day.items
  const transits = day.transits ?? []

  // A day spent driving is a full day, not an empty one: it carries its own
  // transit instead of a stop invented to hold it.
  if (items.length === 0 && transits.length === 0) {
    sink.push({
      id: `empty-day:${day.id}`,
      severity: 'info',
      code: CODES.emptyDay,
      message: `第 ${dayOrder} 天（${day.title}）还没有任何安排。`,
      relatedIds: [day.id],
      suggestedActions: ['加入一到两个想去的地点', '把这一天的路记为转场', '删除这一天'],
    })
  }

  items.forEach((item, itemIndex) => {
    if (project.places[item.placeId] === undefined) {
      sink.push({
        id: `place-unknown:${day.id}:${item.id}`,
        severity: 'error',
        code: CODES.placeUnknown,
        message: `第 ${dayOrder} 天的第 ${itemIndex + 1} 项引用了不存在的地点 ${item.placeId}。`,
        relatedIds: [item.placeId, item.id],
        suggestedActions: ['补全该地点的坐标', '移除该安排'],
      })
    }
  })

  collectOverlapAlerts(day, dayOrder, project, sink)
  collectMissingRouteAlerts(day, dayOrder, project, sink)
  collectMissingTransitAlerts(day, dayOrder, nowMs, routeStaleMode, sink)
  collectRouteAlerts(day, dayOrder, project, nowMs, routeStaleAfterMs, routeStaleMode, sink)
  collectLoadAlerts(project, day, dayOrder, sink)
}

/**
 * Whether a day title claims a change of city, e.g. `西安 → 成都｜翻秦岭 723km`.
 *
 * Detection only: the panel's own parser also reads the distance out of the
 * title, and that one lives in the browser half. This is the question the
 * validation layer has to answer — is a transit missing here? — and nothing
 * more, so the two stay independently testable.
 *
 * @param title - Day title.
 * @returns true when the title names a journey.
 */
export function claimsHop(title: string): boolean {
  // A clock range uses the same arrow: 「11:00 → 15:00 拍摄」 is a schedule, not a
  // change of city, and calling it one would nag about a journey that is not
  // there — while the panel, whose parser agrees, offers nothing to fix.
  if (/\d{1,2}:\d{2}\s*(?:→|->|—>)\s*\d{1,2}:\d{2}/.test(title)) return false
  return /^\s*[^→]+?\s*(?:→|->|—>)\s*\S/.test(title)
}

/**
 * Collects `MISSING_TRANSIT` for a day whose title claims a hop that neither a
 * transit nor a usable leg accounts for.
 *
 * This is the state the panel renders as 「跨城交通未记录」: the plan says the trip
 * changes city, and nothing records how. Marking it in the domain makes it
 * machine-readable for the Agent as well as visible in the panel.
 *
 * @param day - Day under inspection.
 * @param dayOrder - One-based day number used in user-facing text.
 * @param nowMs - Parsed evaluation timestamp, or undefined when unparsable.
 * @param routeStaleMode - How strictly route staleness is graded.
 * @param sink - Mutable alert accumulator owned by the caller.
 * @returns Nothing; alerts are appended to `sink`.
 */
function collectMissingTransitAlerts(
  day: TripDay,
  dayOrder: number,
  nowMs: number | undefined,
  routeStaleMode: RouteStaleMode,
  sink: TripAlert[],
): void {
  if (!claimsHop(day.title)) return
  if ((day.transits ?? []).length > 0) return
  // A real leg between the day's own stops already records the move; a
  // placeholder does not. The panel offers its fill button and the host fill
  // pass decides the same way — see `recordsMove` above.
  if (day.legs.some(recordsMove)) return

  sink.push({
    id: `missing-transit:${day.id}`,
    severity: 'info',
    code: CODES.missingTransit,
    message: `第 ${dayOrder} 天的行程写着「${day.title}」，但这一天没有记录这段路。`,
    relatedIds: [day.id],
    suggestedActions: ['把标题里的这段路记为转场', '用 travel_route_plan 规划后写入'],
  })
}

/**
 * Collects `TIME_OVERLAP` alerts for one day.
 *
 * Only items that have both `startAt` and `endAt` participate; intervals are
 * compared as half-open ranges `[startAt, endAt)`.
 *
 * @param day - Day under inspection.
 * @param dayOrder - One-based day number used in user-facing text.
 * @param project - Trip project used to resolve place names.
 * @param sink - Mutable alert accumulator owned by the caller.
 * @returns Nothing; alerts are appended to `sink`.
 */
function collectOverlapAlerts(
  day: TripDay,
  dayOrder: number,
  project: TripProject,
  sink: TripAlert[],
): void {
  const timed: { readonly item: ItineraryItem; readonly startMs: number; readonly endMs: number }[] = []
  for (const item of day.items) {
    if (item.startAt === undefined || item.endAt === undefined) continue
    const startMs = parseTimestamp(item.startAt)
    const endMs = parseTimestamp(item.endAt)
    if (startMs === undefined || endMs === undefined) continue
    timed.push({ item, startMs, endMs })
  }

  for (let left = 0; left < timed.length; left += 1) {
    const first = timed[left]
    if (first === undefined) continue
    for (let right = left + 1; right < timed.length; right += 1) {
      const second = timed[right]
      if (second === undefined) continue
      if (first.startMs < second.endMs && second.startMs < first.endMs) {
        sink.push({
          id: `time-overlap:${day.id}:${first.item.id}:${second.item.id}`,
          severity: 'error',
          code: CODES.timeOverlap,
          message: `第 ${dayOrder} 天的「${placeName(project, first.item.placeId)}」与「${placeName(project, second.item.placeId)}」时间重叠。`,
          relatedIds: [first.item.id, second.item.id],
          suggestedActions: ['调整其中一个的开始时间', '把其中一项移到其它天'],
        })
      }
    }
  }
}

/**
 * Collects `MISSING_ROUTE` alerts for consecutive items of one day.
 *
 * @param day - Day under inspection.
 * @param dayOrder - One-based day number used in user-facing text.
 * @param project - Trip project used to resolve place names.
 * @param sink - Mutable alert accumulator owned by the caller.
 * @returns Nothing; alerts are appended to `sink`.
 */
function collectMissingRouteAlerts(
  day: TripDay,
  dayOrder: number,
  project: TripProject,
  sink: TripAlert[],
): void {
  for (let index = 0; index + 1 < day.items.length; index += 1) {
    const current = day.items[index]
    const next = day.items[index + 1]
    if (current === undefined || next === undefined) continue
    const hasLeg = day.legs.some(
      (leg) => leg.fromItemId === current.id && leg.toItemId === next.id,
    )
    if (hasLeg) continue
    sink.push({
      id: `missing-route:${day.id}:${current.id}:${next.id}`,
      severity: 'warning',
      code: CODES.missingRoute,
      message: `第 ${dayOrder} 天「${placeName(project, current.placeId)}」到「${placeName(project, next.placeId)}」之间缺少交通段。`,
      relatedIds: [current.id, next.id],
      suggestedActions: ['规划这段交通', '确认两个地点是否相邻'],
    })
  }
}

/** One recorded journey of a day, reduced to what the alerts need. */
interface RouteFact {
  readonly id: string
  /** A phrase starting with 从…到…, for the message. */
  readonly endpoints: string
  readonly relatedIds: readonly string[]
  readonly fetchedAt: string
  readonly freshness: RouteFreshness
  readonly distanceMeters: number
}

/**
 * Collects `ROUTE_FAILED` and `ROUTE_STALE` alerts for everything a day moves by.
 *
 * Legs and transits are graded together: a day is only as fresh as its stalest
 * stretch of road, and one alert per day keeps a two-week plan readable.
 *
 * @param day - Day under inspection.
 * @param dayOrder - One-based day number used in user-facing text.
 * @param project - Trip project used to resolve place names.
 * @param nowMs - Parsed evaluation timestamp, or undefined when unparsable.
 * @param routeStaleAfterMs - Route staleness threshold in milliseconds.
 * @param routeStaleMode - How strictly route staleness is graded.
 * @param sink - Mutable alert accumulator owned by the caller.
 * @returns Nothing; alerts are appended to `sink`.
 */
function collectRouteAlerts(
  day: TripDay,
  dayOrder: number,
  project: TripProject,
  nowMs: number | undefined,
  routeStaleAfterMs: number,
  routeStaleMode: RouteStaleMode,
  sink: TripAlert[],
): void {
  const facts: RouteFact[] = [
    ...day.legs.map((leg) => ({
      id: leg.id,
      endpoints: routeEndpoints(day, project, leg),
      relatedIds: [leg.id, leg.fromItemId, leg.toItemId],
      fetchedAt: leg.source.fetchedAt,
      freshness: leg.freshness,
      distanceMeters: leg.distanceMeters,
    })),
    ...(day.transits ?? []).map((transit) => ({
      id: transit.id,
      endpoints: `、从${transit.from.label}到${transit.to.label}的转场`,
      relatedIds: [transit.id, day.id],
      fetchedAt: transit.source.fetchedAt,
      freshness: transit.freshness,
      distanceMeters: transit.distanceMeters ?? 0,
    })),
  ]

  const expired: RouteFact[] = []
  for (const fact of facts) {
    if (fact.freshness === 'failed') {
      sink.push({
        id: `route-failed:${day.id}:${fact.id}`,
        severity: 'error',
        code: CODES.routeFailed,
        message: `第 ${dayOrder} 天${fact.endpoints}的路线规划失败。`,
        relatedIds: [...fact.relatedIds],
        suggestedActions: ['重新规划这段交通', '改用其它交通方式'],
      })
    }
    if (nowMs !== undefined && isOlderThan(nowMs, fact.fetchedAt, routeStaleAfterMs)) {
      expired.push(fact)
    }
  }

  // One alert per day, not per stretch: an untouched plan otherwise accumulates
  // one warning per road, drowning the alerts that need a decision.
  const severity = gradeRouteStaleness(day, nowMs, routeStaleMode)
  if (expired.length === 0 || severity === undefined) return
  const hours = formatHours(routeStaleAfterMs / 1000)
  const first = expired[0] as RouteFact
  sink.push({
    id: `route-stale:${day.id}`,
    severity,
    code: CODES.routeStale,
    message:
      expired.length === 1
        ? `第 ${dayOrder} 天${first.endpoints}的路线数据已超过 ${hours} 小时未更新。`
        : `第 ${dayOrder} 天有 ${expired.length} 段交通超过 ${hours} 小时未更新。`,
    relatedIds: expired.flatMap((fact) => [...fact.relatedIds]),
    suggestedActions: ['重新规划这一天交通', '或忽略本次提醒'],
  })
}

/**
 * Grades an expired route by how close the day it serves is.
 *
 * @param day - Day whose routes expired.
 * @param nowMs - Parsed evaluation timestamp, or undefined when unparsable.
 * @param mode - Grading mode; `strict` always warns.
 * @returns The severity to emit, or undefined when the day is far enough away
 * that an alert would be noise.
 */
function gradeRouteStaleness(
  day: TripDay,
  nowMs: number | undefined,
  mode: RouteStaleMode,
): AlertSeverity | undefined {
  if (mode === 'strict') return 'warning'
  const daysUntil = daysUntilDay(day.date, nowMs)
  if (daysUntil === undefined) return 'warning'
  if (daysUntil > ROUTE_STALE_FAR_DAYS) return undefined
  return daysUntil <= ROUTE_STALE_IMMINENT_DAYS ? 'warning' : 'info'
}

/**
 * Whole days between the evaluation moment and a `YYYY-MM-DD` day.
 *
 * Both sides are compared as UTC calendar days, so the answer never depends on
 * the machine's timezone; a few hours of skew around midnight is irrelevant at
 * a seven-day threshold.
 *
 * @param date - Day date in `YYYY-MM-DD` form.
 * @param nowMs - Parsed evaluation timestamp, or undefined when unparsable.
 * @returns Days until the day (negative once it has passed), or undefined when
 * either side is unparsable.
 */
function daysUntilDay(date: string, nowMs: number | undefined): number | undefined {
  if (nowMs === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined
  const target = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(target)) return undefined
  const now = new Date(nowMs)
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Math.round((target - today) / 86_400_000)
}

/**
 * Collects `DAY_OVERLOADED` and `PACE_EXCEEDED` alerts for one day.
 *
 * @param project - Trip project that owns the day.
 * @param day - Day under inspection.
 * @param dayOrder - One-based day number used in user-facing text.
 * @param sink - Mutable alert accumulator owned by the caller.
 * @returns Nothing; alerts are appended to `sink`.
 */
function collectLoadAlerts(
  project: TripProject,
  day: TripDay,
  dayOrder: number,
  sink: TripAlert[],
): void {
  const totalSeconds = dayTotalSeconds(day)
  const transits = day.transits ?? []
  // Every stretch of road the day has, whether it was written as a transit or as
  // a leg between two stops: a 1,077 km drive is the same day either way, and the
  // advice for an over-booked sightseeing day would be wrong for both.
  const stretches = [
    ...day.legs.map((leg) => ({ seconds: leg.durationSeconds, meters: leg.distanceMeters })),
    ...transits.map((transit) => ({ seconds: transit.durationSeconds ?? 0, meters: transit.distanceMeters ?? 0 })),
  ]
  const movingSeconds = stretches.reduce((sum, stretch) => sum + stretch.seconds, 0)
  const longest = stretches.reduce<{ readonly seconds: number; readonly meters: number } | undefined>(
    (best, stretch) => (best === undefined || stretch.seconds > best.seconds ? stretch : best),
    undefined,
  )
  const driving =
    longest !== undefined &&
    longest.seconds > 0 &&
    movingSeconds > 0 &&
    longest.seconds >= movingSeconds * TRANSIT_DOMINATED_SHARE &&
    longest.meters >= DRIVE_FRAMING_METERS

  // Legs and dwell already come from `dayTotalSeconds`; the transits are the part
  // a day spent driving never had a place to record before.
  const transitSeconds = transits.reduce((sum, transit) => sum + (transit.durationSeconds ?? 0), 0)
  const busySeconds = totalSeconds + transitSeconds
  if (busySeconds > DAY_OVERLOAD_SECONDS) {
    sink.push(
      driving
        ? {
            id: `day-overloaded:${day.id}`,
            severity: 'warning',
            code: CODES.dayOverloaded,
            message: `第 ${dayOrder} 天在路上约 ${formatHours(longest.seconds)} 小时${
              longest.meters > 0 ? `（${String(Math.round(longest.meters / 1000))} km）` : ''
            }，单日驾驶偏长。`,
            relatedIds: [day.id, ...transits.map((transit) => transit.id)],
            suggestedActions: ['中途加一晚住宿', '两个人换着开'],
          }
        : {
            id: `day-overloaded:${day.id}`,
            severity: 'warning',
            code: CODES.dayOverloaded,
            message: `第 ${dayOrder} 天总耗时约 ${formatHours(totalSeconds)} 小时，超过 10 小时上限。`,
            relatedIds: [day.id],
            suggestedActions: ['减少一个安排', '改用更快的交通方式'],
          },
    )
  }

  if (project.preferences.pace !== 'relaxed') return
  if (day.items.length <= RELAXED_PACE_MAX_ITEMS && totalSeconds <= RELAXED_PACE_MAX_SECONDS) {
    return
  }
  sink.push({
    id: `pace-exceeded:${day.id}`,
    severity: 'warning',
    code: CODES.paceExceeded,
    message: `轻松节奏下第 ${dayOrder} 天安排了 ${day.items.length} 项、约 ${formatHours(totalSeconds)} 小时，强度偏高。`,
    relatedIds: [day.id],
    suggestedActions: ['减少一个安排', '把部分地点移到其它天'],
  })
}

/**
 * Collects `PLACE_FACT_STALE` alerts for every place of the project.
 *
 * @param project - Trip project whose places are inspected.
 * @param nowMs - Parsed evaluation timestamp, or undefined when unparsable.
 * @param factStaleAfterMs - Place fact staleness threshold in milliseconds.
 * @param sink - Mutable alert accumulator owned by the caller.
 * @returns Nothing; alerts are appended to `sink`.
 */
function collectPlaceAlerts(
  project: TripProject,
  nowMs: number | undefined,
  factStaleAfterMs: number,
  sink: TripAlert[],
): void {
  if (nowMs === undefined) return
  for (const place of Object.values(project.places)) {
    if (!isOlderThan(nowMs, place.source.fetchedAt, factStaleAfterMs)) continue
    sink.push({
      id: `place-fact-stale:${place.id}`,
      severity: 'info',
      code: CODES.placeFactStale,
      message: `地点「${place.name}」的资料已超过 ${formatHours(factStaleAfterMs / 1000)} 小时未更新。`,
      relatedIds: [place.id],
      suggestedActions: ['重新查询该地点的资料'],
    })
  }
}

/**
 * Collects `BUDGET_EXCEEDED` and `BUDGET_UNKNOWN` alerts.
 *
 * @param project - Trip project whose budget is inspected.
 * @param sink - Mutable alert accumulator owned by the caller.
 * @returns Nothing; alerts are appended to `sink`.
 */
function collectBudgetAlerts(project: TripProject, sink: TripAlert[]): void {
  const { limit, estimatedTotal, currency } = project.budget
  if (limit === undefined) return

  if (estimatedTotal === undefined) {
    sink.push({
      id: 'budget-unknown',
      severity: 'info',
      code: CODES.budgetUnknown,
      message: '已设置预算上限，但还没有估算总额。',
      relatedIds: [],
      suggestedActions: ['生成一份预算估算'],
    })
    return
  }

  if (estimatedTotal > limit) {
    sink.push({
      id: 'budget-exceeded',
      severity: 'warning',
      code: CODES.budgetExceeded,
      message: `估算总额 ${estimatedTotal} ${currency} 超出预算上限 ${limit} ${currency}。`,
      relatedIds: [],
      suggestedActions: ['压缩或替换部分安排', '上调预算上限'],
    })
  }
}

/**
 * Orders two alerts by severity, code, then first related id, then id.
 *
 * @param left - Left alert.
 * @param right - Right alert.
 * @returns A negative number when `left` sorts first, a positive number when it sorts last.
 */
function compareAlerts(left: TripAlert, right: TripAlert): number {
  const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
  if (bySeverity !== 0) return bySeverity
  if (left.code !== right.code) return left.code < right.code ? -1 : 1
  const leftKey = left.relatedIds[0] ?? ''
  const rightKey = right.relatedIds[0] ?? ''
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

/**
 * Computes the readiness score of a validation pass.
 *
 * @param errorCount - Number of error alerts.
 * @param warningCount - Number of warning alerts.
 * @returns Readiness between 0 and 1, rounded to two decimals.
 */
function computeReadiness(errorCount: number, warningCount: number): number {
  const score = Math.max(0, 1 - 0.25 * errorCount - 0.05 * warningCount)
  return Math.round(score * 100) / 100
}

/**
 * Sums the planned time of one day: leg travel plus item dwell time.
 *
 * @param day - Day to measure.
 * @returns Total seconds planned for the day.
 */
function dayTotalSeconds(day: TripDay): number {
  let total = 0
  for (const leg of day.legs) total += leg.durationSeconds
  for (const item of day.items) total += (item.plannedDurationMinutes ?? 0) * 60
  return total
}

/**
 * Parses an ISO timestamp.
 *
 * @param value - Timestamp text to parse.
 * @returns Milliseconds since the epoch, or undefined when unparsable.
 */
function parseTimestamp(value: string): number | undefined {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? milliseconds : undefined
}

/**
 * Reports whether a source stamp is older than a threshold.
 *
 * An unparsable stamp is treated as stale, because unknown provenance cannot be
 * trusted for planning.
 *
 * @param nowMs - Parsed evaluation timestamp.
 * @param fetchedAt - Source stamp timestamp to compare.
 * @param thresholdMs - Maximum accepted age in milliseconds.
 * @returns True when the stamp is strictly older than the threshold.
 */
function isOlderThan(nowMs: number, fetchedAt: string, thresholdMs: number): boolean {
  const fetchedMs = parseTimestamp(fetchedAt)
  if (fetchedMs === undefined) return true
  return nowMs - fetchedMs > thresholdMs
}

/**
 * Formats a duration in seconds as hours with at most one decimal.
 *
 * @param seconds - Duration in seconds.
 * @returns Hour text such as `6` or `12.5`.
 */
function formatHours(seconds: number): string {
  const hours = Math.round((seconds / 3600) * 10) / 10
  return `${hours}`
}

/**
 * Resolves the display name of a place id.
 *
 * @param project - Trip project that owns the place library.
 * @param placeId - Place id to resolve.
 * @returns The place name, or a `未知地点(…)` marker when the place is unknown.
 */
function placeName(project: TripProject, placeId: string): string {
  const place = project.places[placeId]
  return place === undefined ? `未知地点(${placeId})` : place.name
}

/**
 * Describes the endpoints of a route leg in user-facing text.
 *
 * @param day - Day that owns the leg.
 * @param project - Trip project that owns the place library.
 * @param leg - Route leg to describe.
 * @returns Text such as `「西湖」到「灵隐寺」`.
 */
function routeEndpoints(day: TripDay, project: TripProject, leg: RouteLeg): string {
  const from = day.items.find((item) => item.id === leg.fromItemId)
  const to = day.items.find((item) => item.id === leg.toItemId)
  const fromName = from === undefined ? leg.fromItemId : placeName(project, from.placeId)
  const toName = to === undefined ? leg.toItemId : placeName(project, to.placeId)
  return `「${fromName}」到「${toName}」`
}
