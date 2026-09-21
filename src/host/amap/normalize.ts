import type {
  GeoPoint,
  PlaceStatus,
  RouteLeg,
  RouteStep,
  SourceStamp,
  TravelMode,
  TripPlace,
} from '../../domain/trip.js'
import type { AmapPoi, AmapRouteData } from './cli.js'
import { AmapCliError } from './cli.js'

/** Caller-supplied identity and provenance for {@link normalizePlace}. */
export interface PlaceNormalizationContext {
  /** Plugin-internal stable place id. */
  readonly id: string
  /** ISO-8601 timestamp of the provider fetch. */
  readonly fetchedAt: string
  /** Optional provider or CLI version stamp. */
  readonly providerVersion?: string
  /** Place status; defaults to `'candidate'`. */
  readonly status?: PlaceStatus
}

/** Caller-supplied identity and provenance for {@link normalizeRouteLeg}. */
export interface RouteNormalizationContext {
  /** Plugin-internal stable route leg id. */
  readonly id: string
  /** Itinerary item id the leg starts from. */
  readonly fromItemId: string
  /** Itinerary item id the leg ends at. */
  readonly toItemId: string
  /** Travel mode used for the query. */
  readonly mode: TravelMode
  /** ISO-8601 timestamp of the provider fetch. */
  readonly fetchedAt: string
  /** Optional provider or CLI version stamp. */
  readonly providerVersion?: string
}

/** AMap provider identifier written into every {@link SourceStamp}. */
const PROVIDER = 'amap-cli'

/** Dataset coordinate system used by 高德 POI and route data. */
const COORDINATE_SYSTEM = 'gcj02'

/** Default status for a newly imported place. */
const DEFAULT_PLACE_STATUS: PlaceStatus = 'candidate'

/**
 * Convert a 高德 POI into a persisted {@link TripPlace}.
 *
 * @param raw POI entry from `amap-gui searchPOI`
 * @param context plugin-internal id, fetch timestamp and optional status
 * @returns the normalized place with a GCJ-02 point and an `amap-cli` source stamp
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when `raw.id` or
 * `raw.name` is empty or `raw.location` is not a pair of finite numbers in
 * `[longitude, latitude]` order
 */
export function normalizePlace(raw: AmapPoi, context: PlaceNormalizationContext): TripPlace {
  const providerPlaceId = readNonEmptyString(raw.id)
  if (providerPlaceId === undefined) {
    throw invalidResponse('amap POI is missing a non-empty id')
  }
  const name = readNonEmptyString(raw.name)
  if (name === undefined) {
    throw invalidResponse('amap POI is missing a non-empty name')
  }
  const point = toGeoPoint(raw.location, 'amap POI location')
  const address = typeof raw.address === 'string' ? raw.address : ''
  const telephone = readNonEmptyString(raw.tel)
  const photoUrl = readNonEmptyString(raw.photoUrl)

  return {
    id: context.id,
    providerPlaceId,
    name,
    address,
    point,
    categories: normalizeCategories(raw.type),
    status: context.status ?? DEFAULT_PLACE_STATUS,
    source: sourceStamp(context.fetchedAt, context.providerVersion),
    ...(telephone !== undefined ? { telephone } : {}),
    ...(photoUrl !== undefined ? { photoUrl } : {}),
  }
}

/**
 * Split a 高德 `type` category path into a clean category list.
 *
 * The provider separates path segments with `;`. Segments are trimmed, empty
 * segments dropped, and duplicates removed while keeping first-seen order and
 * original casing.
 *
 * @param type raw category path such as `"餐饮服务;中餐厅;浙江菜"`
 * @returns deduplicated category list, empty when the provider reported no type
 */
export function normalizeCategories(type: string | undefined): readonly string[] {
  if (typeof type !== 'string') {
    return []
  }
  const seen = new Set<string>()
  const categories: string[] = []
  for (const segment of type.split(';')) {
    const trimmed = segment.trim()
    if (trimmed === '' || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    categories.push(trimmed)
  }
  return categories
}

/**
 * Convert a 高德 route response into a persisted {@link RouteLeg}.
 *
 * Tolls, distance and duration come from the route summary; steps keep their
 * provider order and are clamped by {@link routeSteps}.
 *
 * @param raw route payload from `amap-gui route`
 * @param context plugin-internal ids, travel mode and fetch metadata
 * @returns the normalized leg marked `fresh`
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when `summary`,
 * `summary.distance`, `summary.time` or any step is missing or malformed
 */
export function normalizeRouteLeg(raw: AmapRouteData, context: RouteNormalizationContext): RouteLeg {
  const summary = readRecord(raw.summary, 'amap route summary')
  const distanceMeters = readFiniteNumber(summary['distance'], 'amap route summary.distance')
  const durationSeconds = readFiniteNumber(summary['time'], 'amap route summary.time')
  const tollsYuan = readOptionalFiniteNumber(summary['tolls'])

  return {
    id: context.id,
    fromItemId: context.fromItemId,
    toItemId: context.toItemId,
    mode: context.mode,
    distanceMeters,
    durationSeconds,
    steps: routeSteps(raw),
    freshness: 'fresh',
    source: sourceStamp(context.fetchedAt, context.providerVersion),
    ...(tollsYuan !== undefined ? { tollsYuan } : {}),
  }
}

/**
 * Map route steps to the persisted {@link RouteStep} shape.
 *
 * Negative or zero magnitudes are clamped to `0` so a bad provider value cannot
 * produce a negative distance or duration in the trip project.
 *
 * @param raw route payload from `amap-gui route`
 * @returns steps in provider order, empty when the response has no steps
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when `summary` is
 * missing, `steps` is not an array, or a step is malformed
 */
export function routeSteps(raw: AmapRouteData): readonly RouteStep[] {
  const summary = readRecord(raw.summary, 'amap route summary')
  const rawSteps = summary['steps']
  if (rawSteps === undefined || rawSteps === null) {
    return []
  }
  if (!Array.isArray(rawSteps)) {
    throw invalidResponse('amap route summary.steps must be an array')
  }
  return rawSteps.map((entry, index) => {
    const label = `amap route summary.steps[${index}]`
    const step = readRecord(entry, label)
    const instruction = step['instruction']
    if (typeof instruction !== 'string') {
      throw invalidResponse(`${label}.instruction must be a string`)
    }
    return {
      instruction,
      distanceMeters: clampNonNegative(readFiniteNumber(step['distance'], `${label}.distance`)),
      durationSeconds: clampNonNegative(readFiniteNumber(step['time'], `${label}.time`)),
    }
  })
}

/**
 * Derive a deterministic, filesystem-safe cache id from a 高德 POI id.
 *
 * Alphanumeric, `_` and `-` characters are kept as-is; every other character is
 * escaped as `_u<codePoint hex>`, so two different provider ids can never
 * collapse onto the same cache id.
 *
 * @param providerPlaceId 高德 POI id
 * @returns cache id of the form `amap-<encoded id>`
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when the id is empty
 */
export function placeCacheId(providerPlaceId: string): string {
  const trimmed = providerPlaceId.trim()
  if (trimmed === '') {
    throw invalidResponse('cannot derive a place cache id from an empty provider id')
  }
  let encoded = ''
  for (const character of trimmed) {
    if (isSafeCharacter(character)) {
      encoded += character
      continue
    }
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) {
      continue
    }
    encoded += `_u${codePoint.toString(16)}`
  }
  return `amap-${encoded}`
}

/**
 * Test whether a character is kept verbatim inside a cache id.
 *
 * @param character single character
 * @returns true for `[A-Za-z0-9_-]`
 */
function isSafeCharacter(character: string): boolean {
  return /^[A-Za-z0-9_-]$/.test(character)
}

/**
 * Build a provider source stamp, omitting the version when absent.
 *
 * @param fetchedAt ISO-8601 fetch timestamp
 * @param providerVersion optional provider or CLI version
 * @returns the source stamp
 */
function sourceStamp(fetchedAt: string, providerVersion: string | undefined): SourceStamp {
  if (providerVersion === undefined) {
    return { provider: PROVIDER, fetchedAt }
  }
  return { provider: PROVIDER, fetchedAt, providerVersion }
}

/**
 * Validate and convert a raw `[longitude, latitude]` pair into a GCJ-02 point.
 *
 * @param location raw provider location
 * @param label field name used in the error message
 * @returns the GCJ-02 point, longitude first
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when the pair is malformed
 */
function toGeoPoint(location: unknown, label: string): GeoPoint {
  if (!Array.isArray(location) || location.length !== 2) {
    throw invalidResponse(`${label} must be a two-element [longitude, latitude] array`)
  }
  const [longitude, latitude] = location as readonly unknown[]
  if (!isFiniteNumber(longitude) || !isFiniteNumber(latitude)) {
    throw invalidResponse(`${label} must contain two finite numbers`)
  }
  return { longitude, latitude, coordinateSystem: COORDINATE_SYSTEM }
}

/**
 * Read a required non-empty trimmed string.
 *
 * @param value candidate value
 * @returns the trimmed string, or `undefined` when absent, blank or not a string
 */
function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Assert that a value is a record.
 *
 * @param value candidate value
 * @param label field name used in the error message
 * @returns the value narrowed to a record
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE`
 */
function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidResponse(`${label} is missing or malformed`)
  }
  return value as Record<string, unknown>
}

/**
 * Read a required finite number.
 *
 * @param value candidate value
 * @param label field name used in the error message
 * @returns the numeric value
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when not a finite number
 */
function readFiniteNumber(value: unknown, label: string): number {
  if (!isFiniteNumber(value)) {
    throw invalidResponse(`${label} must be a finite number`)
  }
  return value
}

/**
 * Read an optional finite number, treating `null` and `undefined` as absent.
 *
 * @param value candidate value
 * @returns the numeric value, or `undefined` when absent
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when present but not finite
 */
function readOptionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  return readFiniteNumber(value, 'optional numeric field')
}

/**
 * Test whether a value is a finite number.
 *
 * @param value candidate value
 * @returns true when the value is a finite number
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Clamp a negative magnitude to zero.
 *
 * @param value finite number
 * @returns `value` when positive, otherwise `0`
 */
function clampNonNegative(value: number): number {
  return value > 0 ? value : 0
}

/**
 * Create an `AMAP_INVALID_RESPONSE` error.
 *
 * @param message caller-facing message
 * @returns the constructed error
 */
function invalidResponse(message: string): AmapCliError {
  return new AmapCliError('AMAP_INVALID_RESPONSE', message)
}
