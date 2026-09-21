/** Current persisted Trip Project schema version. */
/**
 * 2 added `TripDay.transits`.
 *
 * A version-1 file still loads: a day without the field simply has no transits,
 * and the panel falls back to the day title the way it always did.
 */
export const CURRENT_TRIP_SCHEMA_VERSION = 2

export type TripId = string
export type ScenarioId = string
export type DayId = string
export type PlaceId = string
export type ItineraryItemId = string
export type RouteLegId = string
export type AlertId = string

export type TripStatus =
  | 'idea'
  | 'drafting'
  | 'checking'
  | 'needs-attention'
  | 'ready'
  | 'traveling'
  | 'archived'

export type TravelMode = 'walking' | 'transit' | 'riding' | 'driving'
export type PlaceStatus = 'candidate' | 'planned' | 'excluded' | 'locked'
export type AlertSeverity = 'error' | 'warning' | 'info'
export type RouteFreshness = 'fresh' | 'stale' | 'failed'

export interface GeoPoint {
  readonly longitude: number
  readonly latitude: number
  readonly coordinateSystem: 'gcj02'
}

export interface SourceStamp {
  readonly provider: 'amap-cli' | 'manual'
  readonly fetchedAt: string
  readonly providerVersion?: string
}

export interface TravelerProfile {
  readonly id: string
  readonly label: string
  readonly interests: readonly string[]
  readonly accessibilityNeeds: readonly string[]
}

export interface TravelPreferences {
  readonly pace: 'relaxed' | 'balanced' | 'intensive'
  readonly interests: readonly string[]
  readonly avoid: readonly string[]
  readonly preferredModes: readonly TravelMode[]
  readonly maximumWalkingMinutesPerLeg?: number
}

export interface TripConstraint {
  readonly id: string
  readonly kind: 'must-visit' | 'avoid' | 'fixed-time' | 'budget' | 'note'
  readonly description: string
  readonly locked: boolean
}

export interface TripPlace {
  readonly id: PlaceId
  readonly providerPlaceId?: string
  readonly name: string
  readonly address: string
  readonly point: GeoPoint
  readonly telephone?: string
  /**
   * Provider photo URL (AMap's own CDN), when the POI publishes one.
   *
   * Stored because it makes the itinerary legible at a glance. It is a
   * third-party address, so a deployment that does not want browsers fetching
   * from it keeps it out of the view with `ui.placePhotos: 'off'`.
   */
  readonly photoUrl?: string
  readonly categories: readonly string[]
  readonly status: PlaceStatus
  readonly source: SourceStamp
}

export interface ItineraryItem {
  readonly id: ItineraryItemId
  readonly placeId: PlaceId
  readonly startAt?: string
  readonly endAt?: string
  readonly plannedDurationMinutes?: number
  readonly locked: boolean
  readonly notes: readonly string[]
}

export interface RouteStep {
  readonly instruction: string
  readonly distanceMeters: number
  readonly durationSeconds: number
}

export interface RouteLeg {
  readonly id: RouteLegId
  readonly fromItemId: ItineraryItemId
  readonly toItemId: ItineraryItemId
  readonly mode: TravelMode
  readonly distanceMeters: number
  readonly durationSeconds: number
  readonly tollsYuan?: number
  readonly steps: readonly RouteStep[]
  readonly freshness: RouteFreshness
  readonly source: SourceStamp
}

/**
 * One end of a transit: a place when the library has one, a name always.
 *
 * A transit is how the trip changes city, and the place it leaves or reaches is
 * not necessarily somewhere the traveller stops. Referencing the place gives the
 * map a coordinate; the label keeps the row readable when there is none.
 */
export interface TransitEnd {
  readonly placeId?: PlaceId
  readonly label: string
}

/**
 * A day's change of city: the move itself, not a stop.
 *
 * A driving trip has days that are nothing but road — 1,077 km from Beijing to
 * Xi'an — and before this existed the only way to put one on a day was to invent
 * a stop for it. A transit therefore belongs to the day but not to its stops: it
 * counts towards distance and driving time, never towards the stop count, the
 * dwell time or a stop card's visit semantics.
 */
export interface TripTransit {
  readonly id: string
  readonly from: TransitEnd
  readonly to: TransitEnd
  readonly mode: TravelMode
  readonly distanceMeters?: number
  readonly durationSeconds?: number
  /** Clock the day starts moving, when it is known. */
  readonly departAt?: string
  /** Clock the day arrives; a night drive may land on the following date. */
  readonly arriveAt?: string
  readonly tollsYuan?: number
  readonly steps: readonly RouteStep[]
  readonly freshness: RouteFreshness
  /** `title` when the figures came from the day's own title and nothing else. */
  readonly source: SourceStamp | { readonly provider: 'title'; readonly fetchedAt: string }
  /** Provider path as `lng,lat;lng,lat…`, so the map can draw the real road. */
  readonly polyline?: string
}

export interface TripDay {
  readonly id: DayId
  readonly date: string
  readonly title: string
  readonly areaLabel?: string
  readonly items: readonly ItineraryItem[]
  readonly legs: readonly RouteLeg[]
  /** Changes of city, in order; a day spent driving has transits and no stops. */
  readonly transits?: readonly TripTransit[]
}

export interface TripScenario {
  readonly id: ScenarioId
  readonly title: string
  readonly basedOnRevision: number
  readonly days: readonly TripDay[]
}

export interface BudgetSummary {
  readonly currency: string
  readonly limit?: number
  readonly estimatedTotal?: number
  readonly confirmedTotal?: number
}

export interface TripAlert {
  readonly id: AlertId
  readonly severity: AlertSeverity
  readonly code: string
  readonly message: string
  readonly relatedIds: readonly string[]
  readonly suggestedActions: readonly string[]
}

export interface TripProject {
  readonly schemaVersion: typeof CURRENT_TRIP_SCHEMA_VERSION
  readonly id: TripId
  readonly revision: number
  readonly title: string
  readonly status: TripStatus
  readonly timezone: string
  readonly startDate: string
  readonly endDate: string
  readonly destinations: readonly string[]
  readonly travelers: readonly TravelerProfile[]
  readonly preferences: TravelPreferences
  readonly constraints: readonly TripConstraint[]
  readonly places: Readonly<Record<PlaceId, TripPlace>>
  readonly scenarios: readonly TripScenario[]
  readonly activeScenarioId: ScenarioId
  readonly budget: BudgetSummary
  readonly alerts: readonly TripAlert[]
  readonly createdAt: string
  readonly updatedAt: string
}
