import type { GeoPoint, RouteLeg, TripAlert, TravelMode } from '../domain/trip.js'

/**
 * Browser-facing projection of one trip.
 *
 * Shared by the Host projection and the sidebar renderer, and deliberately
 * limited to lossless JSON: no Service, Context, Session, or React value ever
 * appears here.
 */

/** One place as the sidebar renders it. */
export interface PlaceView {
  readonly id: string
  readonly name: string
  readonly address: string
  readonly categories: readonly string[]
  readonly point: GeoPoint
  readonly telephone?: string
  readonly status: 'candidate' | 'planned' | 'excluded' | 'locked'
  readonly providerPlaceId?: string
  readonly fetchedAt: string
  /** Provider photo URL; absent when the deployment switched photos off. */
  readonly photoUrl?: string
}

/** One transport leg between two itinerary items. */
export interface LegView {
  readonly id: string
  readonly fromItemId: string
  readonly toItemId: string
  readonly mode: TravelMode
  readonly distanceMeters: number
  readonly durationSeconds: number
  readonly freshness: RouteLeg['freshness']
  readonly stale: boolean
  readonly steps: readonly LegStepView[]
}

/** One navigation step inside a leg. */
export interface LegStepView {
  readonly instruction: string
  readonly distanceMeters: number
  readonly durationSeconds: number
}

/** One itinerary item as the sidebar renders it. */
export interface ItemView {
  readonly id: string
  readonly placeId: string
  readonly name: string
  readonly category: string
  readonly address: string
  readonly point?: GeoPoint
  readonly startAt?: string
  readonly endAt?: string
  readonly plannedDurationMinutes?: number
  readonly locked: boolean
  readonly notes: readonly string[]
  readonly alertIds: readonly string[]
  /** Provider photo URL, copied from the place; absent when photos are off. */
  readonly photoUrl?: string
}

/** One end of a transit, as the sidebar renders it. */
export interface TransitEndView {
  readonly placeId?: string
  readonly label: string
  /** Present when the end resolves to a library place. */
  readonly point?: GeoPoint
}

/**
 * One day's change of city.
 *
 * Not a stop: the panel renders it as a route row rather than a place card, and
 * a day may consist of nothing else. `polyline` is a provider path
 * (`lng,lat;lng,lat…`) when the Web-service API answered, and absent when the
 * figures came from the day's own title.
 */
export interface TransitView {
  readonly id: string
  readonly from: TransitEndView
  readonly to: TransitEndView
  readonly mode: TravelMode
  readonly distanceMeters?: number
  readonly durationSeconds?: number
  readonly departAt?: string
  readonly arriveAt?: string
  readonly freshness: RouteLeg['freshness']
  readonly stale: boolean
  /** `title` when the figures are only what the day's title claims. */
  readonly source: string
  readonly polyline?: string
  readonly steps: readonly LegStepView[]
}

/** One day with its ordered items and the legs joining them. */
export interface DayView {
  readonly id: string
  readonly date: string
  readonly title: string
  readonly areaLabel?: string
  readonly items: readonly ItemView[]
  readonly legs: readonly LegView[]
  /**
   * Changes of city, in order; a driving day has these and no stops.
   *
   * Optional because the Host and the browser half update on different clocks:
   * a page can reload against a Host that predates the field, and every reader
   * treats its absence as "no transits".
   */
  readonly transits?: readonly TransitView[]
  readonly totalDistanceMeters: number
  readonly totalDurationSeconds: number
  readonly alertIds: readonly string[]
}

/** One trip as the project switcher lists it. */
export interface TripSummaryView {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly startDate: string
  readonly endDate: string
  readonly durationDays: number
  readonly revision: number
  readonly updatedAt: string
  readonly activeScenarioId: string
  readonly destinations: readonly string[]
  /** Deterministic readiness in `0..1`, so the switcher ranks trips without a second call. */
  readonly readiness: number
  /** Alert counts by severity, for the switcher's badge. */
  readonly alerts: { readonly error: number; readonly warning: number; readonly info: number }
}

/**
 * Facts the sidebar needs to draw the map itself.
 *
 * `key` is the AMap Web (JS API) key, which is public by design: AMap serves it
 * to every browser that renders a map. The security key is never sent here.
 */
export interface MapView {
  /** Whether the client should load the map component at all. */
  readonly enabled: boolean
  /** AMap JS API key; present only when `enabled` is true. */
  readonly key?: string
  /** JS API version the client asks its loader for. */
  readonly version: string
  /** Base map style matched to the current theme. */
  readonly style: string
}

/** Why the active trip is the active one. */
export type TripSelectionSource = 'explicit' | 'session' | 'workspace' | 'recent'

/** Header summary of the active trip. */
export interface TripHeadlineView {
  readonly tripId: string
  readonly title: string
  readonly status: string
  readonly revision: number
  readonly startDate: string
  readonly endDate: string
  readonly destinations: readonly string[]
  readonly travelers: readonly string[]
  readonly currency: string
  readonly budgetLimit?: number
  readonly budgetEstimated?: number
  readonly readiness: number
  readonly alerts: { readonly error: number; readonly warning: number; readonly info: number }
  readonly updatedAt: string
}

/** Everything the travel sidebar needs for one render. */
export interface TravelView {
  readonly trips: readonly TripSummaryView[]
  /** The trip the sidebar is showing, absent when the workspace has none. */
  readonly activeTripId?: string
  /** Why that trip is active, so the UI can label an implicit choice. */
  readonly selectionSource?: TripSelectionSource
  /** How to draw the map, or that it is switched off. */
  readonly map: MapView
  /**
   * Whether provider photo URLs may reach the browser at all.
   *
   * When false the client shows no photo surface and never asks the Host to
   * look one up, so `ui.placePhotos: 'off'` costs no provider calls.
   */
  readonly photos: boolean
  /**
   * How a missing photo would be looked up.
   *
   * `direct`: over the Web-service API, which needs no AMap container — the
   * sidebar may look one up by itself. `container`: only the CLI can answer,
   * and starting it opens the AMap desktop window, so the sidebar asks first.
   */
  readonly photoLookup: 'direct' | 'container'
  readonly headline: TripHeadlineView | null
  readonly days: readonly DayView[]
  readonly places: readonly PlaceView[]
  readonly alerts: readonly TripAlert[]
}

/** Runtime facts the sidebar shows about the AMap CLI. */
export interface AmapRuntimeView {
  readonly status: string
  readonly mapReady: boolean
  readonly startedByPlugin: boolean
  readonly configured: boolean
  readonly missing: readonly string[]
}

/** Response shape of `GET <prefix>/state`. */
export interface TravelStateResponse {
  readonly ok: boolean
  readonly view?: TravelView
  readonly amap?: AmapRuntimeView
  readonly error?: string
}

/** Response shape of `POST <prefix>/select`. */
export interface TravelSelectResponse {
  readonly ok: boolean
  /** The trip now in force, or absent when the workspace holds none. */
  readonly activeTripId?: string
  /** Fresh view after the switch, so the caller needs no second round trip. */
  readonly view?: TravelView
  readonly error?: string
  readonly code?: string
}

/** Response shape of `POST <prefix>/patch`. */
export interface TravelPatchResponse {
  readonly ok: boolean
  readonly changed?: boolean
  readonly applied?: readonly string[]
  readonly rejected?: readonly { readonly index: number; readonly kind: string; readonly code: string; readonly reason: string }[]
  readonly violations?: readonly { readonly index: number; readonly message: string }[]
  readonly revision?: number
  readonly view?: TravelView
  readonly error?: string
  readonly code?: string
}
