import type { AlertSeverity, GeoPoint, TripAlert, TripProject } from '../domain/trip.js'
import type {
  AmapRuntimeView,
  DayView,
  ItemView,
  LegView,
  PlaceView,
  TransitEndView,
  TransitView,
  TravelView,
  TripHeadlineView,
  TripSelectionSource,
} from '../shared/view.js'
import type { TripSummary } from './trip-store.js'

export type {
  AmapRuntimeView,
  DayView,
  ItemView,
  LegStepView,
  LegView,
  PlaceView,
  TransitEndView,
  TransitView,
  TravelView,
  TripHeadlineView,
  TripSummaryView,
} from '../shared/view.js'

/** Alert counts by severity. */
type AlertCounts = { readonly error: number; readonly warning: number; readonly info: number }

/**
 * One trip with the numbers the switcher shows.
 *
 * Declared structurally rather than imported from the service so this
 * projection module keeps no import edge back into the service that calls it.
 */
export interface SwitcherTripStats {
  readonly summary: TripSummary
  readonly readiness: number
  readonly alerts: AlertCounts
}

/**
 * Build the sidebar projection of one trip.
 * @param project - trip to project.
 * @param alerts - alerts produced by deterministic validation.
 * @param stats - every trip in the store with its validation numbers, for the switcher.
 * @param context - readiness, map facts, and why this trip is the active one.
 * @returns the JSON view.
 */
export function buildTravelView(
  project: TripProject,
  alerts: readonly TripAlert[],
  stats: readonly SwitcherTripStats[],
  context: {
    readonly readiness: number
    readonly map: TravelView['map']
    readonly selection: { readonly tripId: string; readonly source: TripSelectionSource }
    /** Whether provider photo URLs may leave the Host. */
    readonly includePhotos?: boolean
    /** Whether a photo lookup can be answered without the CLI container. */
    readonly photoLookup?: 'direct' | 'container'
  },
): TravelView {
  const active = project.scenarios.find((scenario) => scenario.id === project.activeScenarioId)
  const alertsByRelated = new Map<string, string[]>()
  for (const alert of alerts) {
    for (const relatedId of alert.relatedIds) {
      const bucket = alertsByRelated.get(relatedId)
      if (bucket === undefined) alertsByRelated.set(relatedId, [alert.id])
      else bucket.push(alert.id)
    }
  }
  const counts = countAlerts(alerts)
  const headline: TripHeadlineView = {
    tripId: project.id,
    title: project.title,
    status: project.status,
    revision: project.revision,
    startDate: project.startDate,
    endDate: project.endDate,
    destinations: project.destinations,
    travelers: project.travelers.map((traveler) => traveler.label),
    currency: project.budget.currency,
    ...project.budget.limit === undefined ? {} : { budgetLimit: project.budget.limit },
    ...project.budget.estimatedTotal === undefined ? {} : { budgetEstimated: project.budget.estimatedTotal },
    readiness: context.readiness,
    alerts: counts,
    updatedAt: project.updatedAt,
  }
  return {
    trips: stats.map((stat) => ({
      id: stat.summary.id,
      title: stat.summary.title,
      status: stat.summary.status,
      startDate: stat.summary.startDate,
      endDate: stat.summary.endDate,
      durationDays: stat.summary.durationDays,
      revision: stat.summary.revision,
      updatedAt: stat.summary.updatedAt,
      activeScenarioId: stat.summary.activeScenarioId,
      destinations: stat.summary.destinations,
      readiness: stat.readiness,
      alerts: stat.alerts,
    })),
    activeTripId: context.selection.tripId,
    selectionSource: context.selection.source,
    map: context.map,
    photos: context.includePhotos === true,
    photoLookup: context.photoLookup ?? 'container',
    headline,
    days: (active?.days ?? []).map((day) => buildDayView(day, project, alertsByRelated, alerts, context.includePhotos === true)),
    places: Object.values(project.places).map((place) => buildPlaceView(place, context.includePhotos === true)),
    alerts,
  }
}

/**
 * Project one end of a transit.
 *
 * The label always exists; the coordinate only when the end points at a place
 * the library knows, which is what lets an endpoint be a city name and nothing
 * else.
 *
 * @param project - trip project owning the place library.
 * @param end - stored transit end.
 * @returns the browser-facing end.
 */
function transitEnd(project: TripProject, end: { readonly placeId?: string; readonly label: string }): TransitEndView {
  const place = end.placeId === undefined ? undefined : project.places[end.placeId]
  return {
    ...end.placeId === undefined ? {} : { placeId: end.placeId },
    label: place?.name ?? end.label,
    ...place === undefined ? {} : { point: place.point },
  }
}

/** Project one day. */
function buildDayView(
  day: NonNullable<TripProject['scenarios'][number]>['days'][number],
  project: TripProject,
  alertsByRelated: Map<string, string[]>,
  alerts: readonly TripAlert[],
  includePhotos: boolean,
): DayView {
  const items: ItemView[] = day.items.map((item) => {
    const place = project.places[item.placeId]
    const alertIds = collectAlertIds(alertsByRelated, [item.id, item.placeId])
    return {
      id: item.id,
      placeId: item.placeId,
      name: place?.name ?? `未知地点（${item.placeId}）`,
      category: place?.categories[0] ?? '未分类',
      address: place?.address ?? '',
      ...place === undefined ? {} : { point: place.point },
      ...item.startAt === undefined ? {} : { startAt: item.startAt },
      ...item.endAt === undefined ? {} : { endAt: item.endAt },
      ...item.plannedDurationMinutes === undefined ? {} : { plannedDurationMinutes: item.plannedDurationMinutes },
      locked: item.locked,
      notes: item.notes,
      alertIds,
      ...includePhotos && place?.photoUrl !== undefined ? { photoUrl: place.photoUrl } : {},
    }
  })
  const transits: TransitView[] = (day.transits ?? []).map((transit) => ({
    id: transit.id,
    from: transitEnd(project, transit.from),
    to: transitEnd(project, transit.to),
    mode: transit.mode,
    ...transit.distanceMeters === undefined ? {} : { distanceMeters: transit.distanceMeters },
    ...transit.durationSeconds === undefined ? {} : { durationSeconds: transit.durationSeconds },
    ...transit.departAt === undefined ? {} : { departAt: transit.departAt },
    ...transit.arriveAt === undefined ? {} : { arriveAt: transit.arriveAt },
    freshness: transit.freshness,
    stale: alerts.some((alert) => alert.code === 'ROUTE_STALE' && alert.relatedIds.includes(transit.id)),
    source: transit.source.provider,
    ...transit.polyline === undefined ? {} : { polyline: transit.polyline },
    steps: transit.steps.map((step) => ({
      instruction: step.instruction,
      distanceMeters: step.distanceMeters,
      durationSeconds: step.durationSeconds,
    })),
  }))
  const legs: LegView[] = day.legs.map((leg) => ({
    id: leg.id,
    fromItemId: leg.fromItemId,
    toItemId: leg.toItemId,
    mode: leg.mode,
    distanceMeters: leg.distanceMeters,
    durationSeconds: leg.durationSeconds,
    freshness: leg.freshness,
    stale: alerts.some((alert) => alert.code === 'ROUTE_STALE' && alert.relatedIds.includes(leg.id)),
    steps: leg.steps.map((step) => ({
      instruction: step.instruction,
      distanceMeters: step.distanceMeters,
      durationSeconds: step.durationSeconds,
    })),
  }))
  return {
    id: day.id,
    date: day.date,
    title: day.title,
    transits,
    ...day.areaLabel === undefined ? {} : { areaLabel: day.areaLabel },
    items,
    legs,
    totalDistanceMeters: legs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
    totalDurationSeconds: legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
    alertIds: collectAlertIds(alertsByRelated, [day.id, ...day.items.map((item) => item.id)]),
  }
}

/**
 * Project one place.
 *
 * @param place - stored place.
 * @param includePhotos - whether the provider photo URL may leave the Host.
 * @returns the place as the sidebar renders it.
 */
function buildPlaceView(place: TripProject['places'][string], includePhotos: boolean): PlaceView {
  const point: GeoPoint = place.point
  return {
    id: place.id,
    name: place.name,
    address: place.address,
    categories: place.categories,
    point,
    ...place.telephone === undefined ? {} : { telephone: place.telephone },
    status: place.status,
    ...place.providerPlaceId === undefined ? {} : { providerPlaceId: place.providerPlaceId },
    fetchedAt: place.source.fetchedAt,
    ...includePhotos && place.photoUrl !== undefined ? { photoUrl: place.photoUrl } : {},
  }
}

/** Merge alert ids for a set of related ids without duplicates. */
function collectAlertIds(index: Map<string, string[]>, relatedIds: readonly string[]): readonly string[] {
  const merged: string[] = []
  for (const relatedId of relatedIds) {
    for (const alertId of index.get(relatedId) ?? []) {
      if (!merged.includes(alertId)) merged.push(alertId)
    }
  }
  return merged
}

/**
 * Count alerts by severity.
 * @param alerts - alerts to count.
 * @returns the per-severity counts.
 */
export function countAlerts(alerts: readonly TripAlert[]): { readonly error: number; readonly warning: number; readonly info: number } {
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
 * Severity label used by tool summaries.
 * @param severity - severity value.
 * @returns the Chinese label.
 */
export function severityLabel(severity: AlertSeverity): string {
  if (severity === 'error') return '阻塞'
  if (severity === 'warning') return '警告'
  return '提示'
}

/** Build the AMap runtime view shown by the sidebar. */
export function amapRuntimeView(
  snapshot: { readonly status: string; readonly mapReady: boolean; readonly startedByPlugin: boolean } | undefined,
  configuration: { readonly configured: boolean; readonly missing: readonly string[] },
): AmapRuntimeView {
  return {
    status: snapshot?.status ?? 'unavailable',
    mapReady: snapshot?.mapReady ?? false,
    startedByPlugin: snapshot?.startedByPlugin ?? false,
    configured: configuration.configured,
    missing: configuration.missing,
  }
}
