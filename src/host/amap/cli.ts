import type { GeoPoint, TravelMode } from '../../domain/trip.js'

/**
 * Stable error codes produced by the AMap CLI (`amap-gui`) integration.
 *
 * The codes are part of the plugin's public error model: callers map them to
 * user-facing next actions instead of parsing CLI text.
 */
export type AmapErrorCode =
  | 'AMAP_CLI_NOT_FOUND'
  | 'AMAP_CREDENTIAL_MISSING'
  | 'AMAP_START_FAILED'
  | 'AMAP_NOT_READY'
  /** The container is down and this call is not allowed to start it. */
  | 'AMAP_NOT_RUNNING'
  | 'AMAP_COMMAND_TIMEOUT'
  | 'AMAP_COMMAND_ABORTED'
  | 'AMAP_COMMAND_FAILED'
  | 'AMAP_INVALID_RESPONSE'
  | 'AMAP_NO_RESULT'
  | 'AMAP_UNSUPPORTED_ROUTE'

/**
 * Error type carrying a stable {@link AmapErrorCode}.
 *
 * `detail` only ever holds non-secret diagnostic text such as the CLI's own
 * `error` string; it must never contain credentials or environment dumps.
 */
export class AmapCliError extends Error {
  /** Stable machine-readable error code. */
  readonly code: AmapErrorCode
  /** Optional non-secret diagnostic detail. */
  readonly detail?: string

  /**
   * Create an AMap CLI error.
   *
   * @param code stable error code
   * @param message caller-facing message describing the failure
   * @param detail optional non-secret diagnostic detail
   */
  constructor(code: AmapErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'AmapCliError'
    this.code = code
    if (detail !== undefined) {
      this.detail = detail
    }
  }

  /**
   * Narrow an unknown thrown value to {@link AmapCliError}.
   *
   * @param value value to test
   * @returns true when `value` is an {@link AmapCliError}
   */
  static isAmapCliError(value: unknown): value is AmapCliError {
    return value instanceof AmapCliError
  }
}

/** Input for a `searchPOI` invocation. */
export interface SearchPoiInput {
  /** Free-text search keyword; trimmed, must not be empty. */
  readonly keyword: string
  /** City name or adcode used to scope the search. */
  readonly city?: string
  /** GCJ-02 center point for a nearby search; never a place name. */
  readonly center?: GeoPoint
  /** Nearby search radius in meters, 1..50000. */
  readonly radiusMeters?: number
  /** Page size, 1..25. */
  readonly pageSize?: number
  /** 1-based page index. */
  readonly pageIndex?: number
}

/** Input for a `route` invocation. */
export interface RouteInput {
  /** Origin as a place name or `lng,lat` coordinate string. */
  readonly from: string
  /** Destination as a place name or `lng,lat` coordinate string. */
  readonly to: string
  /** Travel mode; `transit` additionally requires {@link RouteInput.city}. */
  readonly mode: TravelMode
  /** Optional display name for the origin, emitted right after `--from`. */
  readonly fromName?: string
  /** Optional display name for the destination, emitted right after `--to`. */
  readonly toName?: string
  /** Driving waypoints in visit order (max 16, driving only). */
  readonly waypoints?: readonly string[]
  /** City name or adcode; required for `transit` and used to disambiguate names. */
  readonly city?: string
  /** Driving route policy. */
  readonly policy?: 'fastest' | 'least_fee' | 'shortest' | 'no_highway' | 'avoid_jam'
  /** Transit route strategy. */
  readonly strategy?: 'fastest' | 'least_cost' | 'least_walk' | 'most_comfort' | 'no_subway'
}

/** Raw POI entry as returned by `amap-gui searchPOI`. */
export interface AmapPoi {
  /** 高德 POI id. */
  readonly id: string
  /** POI name. */
  readonly name: string
  /** Formatted address; may be an empty string. */
  readonly address: string
  /** GCJ-02 coordinates in `[longitude, latitude]` order. */
  readonly location: readonly [number, number]
  /** Phone number when the POI publishes one. */
  readonly tel?: string
  /** 高德 category path, `;` separated. */
  readonly type?: string
  /** Provider photo URL, when the POI publishes one. */
  readonly photoUrl?: string
  /** Straight-line distance from the search center, in meters. */
  readonly distanceMeters?: number
}

/** Normalized `searchPOI` payload. */
export interface AmapSearchData {
  /** Echoed search keyword. */
  readonly keyword: string
  /** City the search was scoped to, when requested. */
  readonly city?: string
  /** GCJ-02 search center as `[longitude, latitude]`, when requested. */
  readonly center?: readonly [number, number]
  /** Requested radius in meters, when requested. */
  readonly radius?: number
  /** Total number of matching POIs known to the provider. */
  readonly total: number
  /** Page size used by the provider. */
  readonly pageSize: number
  /** 1-based page index used by the provider. */
  readonly pageIndex: number
  /** POIs on this page. */
  readonly pois: readonly AmapPoi[]
}

/** One navigation step of a route. */
export interface AmapRouteStepData {
  /** Human-readable instruction text. */
  readonly instruction: string
  /** Step distance in meters. */
  readonly distance: number
  /** Step duration in seconds. */
  readonly time: number
}

/** Route endpoint as returned by the CLI. */
export interface AmapRouteEndpoint {
  /** Resolved endpoint name. */
  readonly name: string
  /** GCJ-02 coordinates in `[longitude, latitude]` order. */
  readonly position: readonly [number, number]
}

/** Normalized `route` payload. */
export interface AmapRouteData {
  /** Route type echoed by the CLI (`driving` | `walking` | `riding` | `transit`). */
  readonly type: string
  /** Resolved origin. */
  readonly from: AmapRouteEndpoint
  /** Resolved destination. */
  readonly to: AmapRouteEndpoint
  /** Route summary. */
  readonly summary: {
    /** Total distance in meters. */
    readonly distance: number
    /** Total duration in seconds. */
    readonly time: number
    /** Total tolls in yuan, when the provider reports them. */
    readonly tolls?: number
    /** Ordered navigation steps. */
    readonly steps: readonly AmapRouteStepData[]
  }
}

/** Normalized `status` payload. */
export interface AmapStatusData {
  /** Container lifecycle state. */
  readonly status: 'running' | 'not_running' | 'stopped'
  /** Map container port while running. */
  readonly port?: number
  /** Whether the AMap JSAPI instance finished loading. */
  readonly mapReady?: boolean
  /** Container uptime in seconds while running. */
  readonly uptime?: number
}

/** Maximum number of driving waypoints accepted by the CLI. */
const MAX_DRIVING_WAYPOINTS = 16

/** Minimum accepted `searchPOI` radius in meters. */
const MIN_SEARCH_RADIUS_METERS = 1

/** Maximum accepted `searchPOI` radius in meters. */
const MAX_SEARCH_RADIUS_METERS = 50000

/** Minimum accepted `searchPOI` page size. */
const MIN_PAGE_SIZE = 1

/** Maximum accepted `searchPOI` page size. */
const MAX_PAGE_SIZE = 25

/** Strict decimal pattern; rejects `NaN`, `Infinity`, `0x10` and empty strings. */
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5

/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193

/** Decimal places used by {@link formatPoint}. */
const COORDINATE_PRECISION = 6

/**
 * Format a GCJ-02 point as the CLI's `经度,纬度` string with 6 decimals.
 *
 * @param point point to format
 * @returns `"<longitude>,<latitude>"` with longitude first
 */
export function formatPoint(point: GeoPoint): string {
  return `${point.longitude.toFixed(COORDINATE_PRECISION)},${point.latitude.toFixed(COORDINATE_PRECISION)}`
}

/**
 * Parse a CLI coordinate string into a GCJ-02 point.
 *
 * Accepts exactly two decimal numbers in `经度,纬度` order and enforces the
 * valid longitude/latitude ranges.
 *
 * @param input coordinate string such as `"116.397428,39.909230"`
 * @returns parsed GCJ-02 point
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when the input is not
 * a well-formed, in-range coordinate pair
 */
export function parsePoint(input: string): GeoPoint {
  const parts = input.split(',')
  const rawLongitude = parts[0]
  const rawLatitude = parts[1]
  if (parts.length !== 2 || rawLongitude === undefined || rawLatitude === undefined) {
    throw invalidResponse('coordinate must contain exactly two comma-separated numbers', input)
  }
  const longitude = parseCoordinateNumber(rawLongitude, 'longitude')
  const latitude = parseCoordinateNumber(rawLatitude, 'latitude')
  if (longitude < -180 || longitude > 180) {
    throw invalidResponse('longitude must be within -180..180', input)
  }
  if (latitude < -90 || latitude > 90) {
    throw invalidResponse('latitude must be within -90..90', input)
  }
  return { longitude, latitude, coordinateSystem: 'gcj02' }
}

/**
 * Build the argv for `amap-gui searchPOI` (excluding the executable).
 *
 * The returned array is already split into single arguments in a fixed
 * deterministic order: `searchPOI --keyword <k> [--city <c>] [--center
 * lng,lat] [--radius <m>] [--pageSize <n>] [--pageIndex <n>]`.
 *
 * @param input validated search input
 * @returns argv array whose first entry is the `searchPOI` command
 * @throws AmapCliError with code `AMAP_COMMAND_FAILED` when the keyword is
 * empty or a numeric option is outside its accepted range
 */
export function searchPoiArgs(input: SearchPoiInput): readonly string[] {
  const keyword = input.keyword.trim()
  if (keyword === '') {
    throw commandFailed('searchPOI requires a non-empty keyword')
  }
  if (input.radiusMeters !== undefined) {
    if (!Number.isInteger(input.radiusMeters) ||
      input.radiusMeters < MIN_SEARCH_RADIUS_METERS ||
      input.radiusMeters > MAX_SEARCH_RADIUS_METERS) {
      throw commandFailed(
        `searchPOI radiusMeters must be an integer between ${MIN_SEARCH_RADIUS_METERS} and ${MAX_SEARCH_RADIUS_METERS}`,
      )
    }
  }
  if (input.pageSize !== undefined) {
    if (!Number.isInteger(input.pageSize) || input.pageSize < MIN_PAGE_SIZE || input.pageSize > MAX_PAGE_SIZE) {
      throw commandFailed(`searchPOI pageSize must be an integer between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}`)
    }
  }
  if (input.pageIndex !== undefined) {
    if (!Number.isInteger(input.pageIndex) || input.pageIndex < 1) {
      throw commandFailed('searchPOI pageIndex must be an integer greater than or equal to 1')
    }
  }

  const args: string[] = ['searchPOI', '--keyword', keyword]
  const city = input.city?.trim()
  if (city !== undefined && city !== '') {
    args.push('--city', city)
  }
  if (input.center !== undefined) {
    args.push('--center', formatPoint(input.center))
  }
  if (input.radiusMeters !== undefined) {
    args.push('--radius', String(input.radiusMeters))
  }
  if (input.pageSize !== undefined) {
    args.push('--pageSize', String(input.pageSize))
  }
  if (input.pageIndex !== undefined) {
    args.push('--pageIndex', String(input.pageIndex))
  }
  return args
}

/**
 * Build the argv for `amap-gui route` (excluding the executable).
 *
 * Emits `--from-name`/`--to-name` immediately after their endpoint and the
 * fixed order `route --from <f> [--from-name <n>] --to <t> [--to-name <n>]
 * --type <mode> [--waypoints p1,p2] [--policy <p>] [--strategy <s>]
 * [--city <c>]`.
 *
 * @param input validated route input
 * @returns argv array whose first entry is the `route` command
 * @throws AmapCliError with code `AMAP_COMMAND_FAILED` when `from`/`to` are empty
 * @throws AmapCliError with code `AMAP_UNSUPPORTED_ROUTE` for transit without a
 * city, waypoints outside `driving`, more than 16 waypoints, or a policy or
 * strategy that does not match the requested mode
 */
export function routeArgs(input: RouteInput): readonly string[] {
  const from = input.from.trim()
  const to = input.to.trim()
  if (from === '' || to === '') {
    throw commandFailed('route requires non-empty --from and --to')
  }
  const mode = input.mode
  if (!isTravelMode(mode)) {
    throw unsupportedRoute(`route does not support mode "${String(mode)}"`)
  }
  const city = input.city?.trim() ?? ''
  if (mode === 'transit' && city === '') {
    throw unsupportedRoute('transit routing requires --city')
  }
  const waypoints = normalizeWaypoints(input.waypoints)
  if (waypoints.length > 0 && mode !== 'driving') {
    throw unsupportedRoute('--waypoints is only supported for driving routes')
  }
  if (waypoints.length > MAX_DRIVING_WAYPOINTS) {
    throw unsupportedRoute(`driving routes accept at most ${MAX_DRIVING_WAYPOINTS} waypoints`)
  }
  if (input.policy !== undefined && mode !== 'driving') {
    throw unsupportedRoute('--policy is only supported for driving routes')
  }
  if (input.strategy !== undefined && mode !== 'transit') {
    throw unsupportedRoute('--strategy is only supported for transit routes')
  }

  const args: string[] = ['route', '--from', from]
  const fromName = input.fromName?.trim()
  if (fromName !== undefined && fromName !== '') {
    args.push('--from-name', fromName)
  }
  args.push('--to', to)
  const toName = input.toName?.trim()
  if (toName !== undefined && toName !== '') {
    args.push('--to-name', toName)
  }
  args.push('--type', mode)
  if (waypoints.length > 0) {
    args.push('--waypoints', waypoints.join(','))
  }
  if (input.policy !== undefined) {
    args.push('--policy', input.policy)
  }
  if (input.strategy !== undefined) {
    args.push('--strategy', input.strategy)
  }
  if (city !== '') {
    args.push('--city', city)
  }
  return args
}

/** Frozen argv for `amap-gui status` (excluding the executable). */
export const STATUS_ARGS: readonly string[] = ['status']

/** Frozen argv for `amap-gui start` (excluding the executable). */
export const START_ARGS: readonly string[] = ['start']

/** Frozen argv for `amap-gui stop` (excluding the executable). */
export const STOP_ARGS: readonly string[] = ['stop']

/**
 * Merge a command payload's live `state` block over its top-level fields.
 *
 * `amap-gui` reports the parameters a command actually ran with inside a
 * nested `state` object, while computed results (`pois`, `summary`) stay at
 * the top level of `data`. Older builds echoed those parameters at the top
 * level instead. Merging `state` over the payload with `state` winning accepts
 * both layouts through one validation path, so a CLI in either shape parses.
 *
 * A payload without a `state` object is returned unchanged.
 *
 * @param record raw `data` payload of one command
 * @returns a shallow copy with `state`'s entries merged in, or the input when
 * it carries no `state` object
 */
export function unwrapCliState(record: Record<string, unknown>): Record<string, unknown> {
  const state = record['state']
  if (!isRecord(state)) {
    return record
  }
  return { ...record, ...state }
}

/**
 * Unwrap the `{success, data, error}` envelope printed by `amap-gui`.
 *
 * @param stdout complete stdout of one CLI invocation
 * @returns the raw `data` payload, still unvalidated beyond being present
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when stdout is not a
 * JSON object, `success` is not `true`, or `data` is missing
 * @throws AmapCliError with code `AMAP_COMMAND_FAILED` when the CLI reports
 * `success: false`
 */
export function parseCliEnvelope<T>(stdout: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(stdout))
  } catch {
    throw invalidResponse('amap-gui stdout was not valid JSON')
  }
  if (!isRecord(parsed)) {
    throw invalidResponse('amap-gui stdout was not a JSON object')
  }
  if (parsed['success'] !== true) {
    const error = parsed['error']
    const detail = typeof error === 'string' && error !== '' ? error : undefined
    throw new AmapCliError('AMAP_COMMAND_FAILED', 'amap-gui reported success: false', detail)
  }
  const data = parsed['data']
  if (data === undefined || data === null) {
    throw invalidResponse('amap-gui response is missing data')
  }
  return data as T
}

/**
 * Parse and validate a `searchPOI` response.
 *
 * The echoed request parameters are read through {@link unwrapCliState}, so
 * both the `data.state` layout and the legacy top-level layout parse.
 *
 * @param stdout complete stdout of `amap-gui searchPOI`
 * @returns normalized search payload
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when required fields
 * are missing or malformed
 */
export function parseSearchPoi(stdout: string): AmapSearchData {
  const record = unwrapCliState(requireRecord(parseCliEnvelope<unknown>(stdout), 'searchPOI data'))
  const keyword = requireString(record['keyword'], 'searchPOI data.keyword')
  const total = requireNumber(record['resultCount'] ?? record['total'], 'searchPOI data.resultCount')
  const pageSize = requireNumber(record['pageSize'], 'searchPOI data.pageSize')
  const pageIndex = requireNumber(record['pageIndex'], 'searchPOI data.pageIndex')
  const rawPois = record['pois']
  if (!Array.isArray(rawPois)) {
    throw invalidResponse('searchPOI data.pois must be an array')
  }
  const pois = rawPois.map((entry, index) => parsePoi(entry, index))
  const city = optionalNonEmptyString(record['city'])
  const center = optionalCoordinatePair(record['center'], 'searchPOI data.center')
  const radius = optionalNumber(record['radius'])
  return {
    keyword,
    total,
    pageSize,
    pageIndex,
    pois,
    ...(city !== undefined ? { city } : {}),
    ...(center !== undefined ? { center } : {}),
    ...(radius !== undefined ? { radius } : {}),
  }
}

/**
 * Parse and validate a `route` response.
 *
 * The echoed request parameters are read through {@link unwrapCliState}; the
 * computed `summary` stays at the top level of `data` in every known layout.
 *
 * @param stdout complete stdout of `amap-gui route`
 * @returns normalized route payload
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when `from`, `to` or
 * `summary` are missing or malformed
 */
export function parseRoute(stdout: string): AmapRouteData {
  const outer = requireRecord(parseCliEnvelope<unknown>(stdout), 'route data')
  const record = unwrapCliState(outer)
  const type = requireString(record['type'], 'route data.type')
  const from = parseEndpoint(record['from'], 'route data.from')
  const to = parseEndpoint(record['to'], 'route data.to')
  const rawSummary = outer['summary']
  if (rawSummary === undefined || rawSummary === null) {
    throw invalidResponse('route data.summary is missing')
  }
  const summary = requireRecord(rawSummary, 'route data.summary')
  const distance = requireNumber(summary['distance'], 'route data.summary.distance')
  const time = requireNumber(summary['time'], 'route data.summary.time')
  const tolls = optionalNumber(summary['tolls'])
  const rawSteps = summary['steps']
  const steps: AmapRouteStepData[] = []
  if (rawSteps !== undefined && rawSteps !== null) {
    if (!Array.isArray(rawSteps)) {
      throw invalidResponse('route data.summary.steps must be an array')
    }
    for (const [index, entry] of rawSteps.entries()) {
      const label = `route data.summary.steps[${index}]`
      const step = requireRecord(entry, label)
      steps.push({
        instruction: requireString(step['instruction'], `${label}.instruction`),
        distance: requireNumber(step['distance'], `${label}.distance`),
        time: requireNumber(step['time'], `${label}.time`),
      })
    }
  }
  return {
    type,
    from,
    to,
    summary: {
      distance,
      time,
      steps,
      ...(tolls !== undefined ? { tolls } : {}),
    },
  }
}

/**
 * Parse and validate a `status` response.
 *
 * @param stdout complete stdout of `amap-gui status`
 * @returns normalized status payload
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when `status` is not
 * one of `running`, `not_running` or `stopped`, or an optional field has an
 * unexpected type
 */
export function parseStatus(stdout: string): AmapStatusData {
  const record = requireRecord(parseCliEnvelope<unknown>(stdout), 'status data')
  const status = record['status']
  if (status !== 'running' && status !== 'not_running' && status !== 'stopped') {
    throw invalidResponse(`status data.status must be running, not_running or stopped (received ${describe(status)})`)
  }
  const port = optionalNumber(record['port'])
  const uptime = optionalNumber(record['uptime'])
  const rawMapReady = record['mapReady']
  let mapReady: boolean | undefined
  if (rawMapReady !== undefined && rawMapReady !== null) {
    if (typeof rawMapReady !== 'boolean') {
      throw invalidResponse('status data.mapReady must be a boolean')
    }
    mapReady = rawMapReady
  }
  return {
    status,
    ...(port !== undefined ? { port } : {}),
    ...(mapReady !== undefined ? { mapReady } : {}),
    ...(uptime !== undefined ? { uptime } : {}),
  }
}

/**
 * Derive a stable cache key for a POI search.
 *
 * The key lowercases and trims every textual field and covers every input that
 * changes the result, so property order in the input object never matters.
 *
 * @param input search input, validated or not
 * @returns cache key of the form `poi:<8 hex digits>`
 */
export function poiCacheKey(input: SearchPoiInput): string {
  const parts = [
    'poi',
    `keyword=${input.keyword.trim().toLowerCase()}`,
    `city=${(input.city ?? '').trim().toLowerCase()}`,
    `center=${input.center === undefined ? '' : formatPoint(input.center)}`,
    `radius=${input.radiusMeters === undefined ? '' : String(input.radiusMeters)}`,
    `pageSize=${input.pageSize === undefined ? '' : String(input.pageSize)}`,
    `pageIndex=${input.pageIndex === undefined ? '' : String(input.pageIndex)}`,
  ]
  return `poi:${fnv1a32Hex(parts.join('|'))}`
}

/**
 * Derive a stable cache key for a route query.
 *
 * The key lowercases and trims every textual field and covers every input that
 * changes the result, including mode, city, policy/strategy, waypoints and the
 * order of endpoints, so property order in the input object never matters.
 *
 * @param input route input, validated or not
 * @returns cache key of the form `route:<8 hex digits>`
 */
export function routeCacheKey(input: RouteInput): string {
  const waypoints = normalizeWaypoints(input.waypoints).map((waypoint) => waypoint.toLowerCase())
  const parts = [
    'route',
    `from=${input.from.trim().toLowerCase()}`,
    `fromName=${(input.fromName ?? '').trim().toLowerCase()}`,
    `to=${input.to.trim().toLowerCase()}`,
    `toName=${(input.toName ?? '').trim().toLowerCase()}`,
    `mode=${input.mode}`,
    `city=${(input.city ?? '').trim().toLowerCase()}`,
    `waypoints=${waypoints.join('>')}`,
    `policy=${input.policy ?? ''}`,
    `strategy=${input.strategy ?? ''}`,
  ]
  return `route:${fnv1a32Hex(parts.join('|'))}`
}

/**
 * Trim waypoint entries and drop empty ones.
 *
 * @param waypoints raw waypoint list
 * @returns trimmed waypoints in the original order
 */
function normalizeWaypoints(waypoints: readonly string[] | undefined): readonly string[] {
  if (waypoints === undefined) {
    return []
  }
  return waypoints.map((waypoint) => waypoint.trim()).filter((waypoint) => waypoint !== '')
}

/**
 * Test a value against the supported travel modes.
 *
 * @param value candidate mode
 * @returns true for a supported {@link TravelMode}
 */
function isTravelMode(value: unknown): value is TravelMode {
  return value === 'walking' || value === 'transit' || value === 'riding' || value === 'driving'
}

/**
 * Parse a coordinate component with a strict decimal grammar.
 *
 * @param raw raw component text
 * @param label field name used in the error message
 * @returns finite parsed number
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` on malformed input
 */
function parseCoordinateNumber(raw: string, label: string): number {
  const trimmed = raw.trim()
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw invalidResponse(`${label} must be a decimal number`, raw)
  }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) {
    throw invalidResponse(`${label} must be a finite number`, raw)
  }
  return value
}

/**
 * Strip a UTF-8 BOM so JSON parsing works on Windows-style CLI output.
 *
 * @param stdout raw stdout
 * @returns stdout without a leading BOM
 */
function stripBom(stdout: string): string {
  return stdout.charCodeAt(0) === 0xfeff ? stdout.slice(1) : stdout
}

/**
 * Test whether a value is a non-array object.
 *
 * @param value candidate value
 * @returns true when the value is a plain record
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Assert that a value is a record.
 *
 * @param value candidate value
 * @param label field name used in the error message
 * @returns the value narrowed to a record
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE`
 */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidResponse(`${label} must be a JSON object`)
  }
  return value
}

/**
 * Assert that a value is a string.
 *
 * @param value candidate value
 * @param label field name used in the error message
 * @returns the string value
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE`
 */
function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw invalidResponse(`${label} must be a string`)
  }
  return value
}

/**
 * Assert that a value is a finite number.
 *
 * @param value candidate value
 * @param label field name used in the error message
 * @returns the numeric value
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE`
 */
function requireNumber(value: unknown, label: string): number {
  if (!isFiniteNumber(value)) {
    throw invalidResponse(`${label} must be a finite number`)
  }
  return value
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
 * Read an optional string field, treating `null` and `undefined` as absent.
 *
 * @param value candidate value
 * @param label field name used in the error message
 * @returns the string, or `undefined` when absent
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when present but not a string
 */
function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  return requireString(value, 'optional string field')
}

/**
 * Read an optional finite number field, treating `null` and `undefined` as absent.
 *
 * @param value candidate value
 * @returns the number, or `undefined` when absent
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when present but not a finite number
 */
function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!isFiniteNumber(value)) {
    throw invalidResponse('optional numeric field must be a finite number')
  }
  return value
}

/**
 * Read an optional `[longitude, latitude]` tuple.
 *
 * @param value candidate value
 * @param label field name used in the error message
 * @returns the tuple, or `undefined` when absent
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when present but malformed
 */
function optionalCoordinatePair(value: unknown, label: string): readonly [number, number] | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  return requireCoordinatePair(value, label)
}

/**
 * Assert that a value is a two-element tuple of finite numbers.
 *
 * @param value candidate value
 * @param label field name used in the error message
 * @returns the validated tuple
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE`
 */
function requireCoordinatePair(value: unknown, label: string): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw invalidResponse(`${label} must be a two-element [longitude, latitude] array`)
  }
  const [longitude, latitude] = value as readonly unknown[]
  if (!isFiniteNumber(longitude) || !isFiniteNumber(latitude)) {
    throw invalidResponse(`${label} must contain two finite numbers`)
  }
  return [longitude, latitude]
}

/**
 * Parse one raw POI entry.
 *
 * @param value candidate entry
 * @param index zero-based entry index used in error messages
 * @returns normalized POI
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when the entry is malformed
 */
function parsePoi(value: unknown, index: number): AmapPoi {
  const label = `searchPOI data.pois[${index}]`
  const record = requireRecord(value, label)
  const id = requireString(record['id'], `${label}.id`).trim()
  if (id === '') {
    throw invalidResponse(`${label}.id must not be empty`)
  }
  const name = requireString(record['name'], `${label}.name`).trim()
  if (name === '') {
    throw invalidResponse(`${label}.name must not be empty`)
  }
  const rawAddress = record['address']
  const address = typeof rawAddress === 'string' ? rawAddress : ''
  const location = requireCoordinatePair(record['location'], `${label}.location`)
  const tel = optionalNonEmptyString(record['tel'])
  const type = optionalNonEmptyString(record['type'])
  const distance = optionalNumber(record['distance'])
  const photoUrl = optionalNonEmptyString(record['photo'])
  return {
    id,
    name,
    address,
    location,
    ...(tel !== undefined ? { tel } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(photoUrl !== undefined ? { photoUrl } : {}),
    ...(distance !== undefined ? { distanceMeters: distance } : {}),
  }
}

/**
 * Read an optional string field, dropping empty and whitespace-only values.
 *
 * @param value candidate value
 * @returns the trimmed string, or `undefined` when absent or empty
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when present but not a string
 */
function optionalNonEmptyString(value: unknown): string | undefined {
  const text = optionalString(value)
  if (text === undefined) {
    return undefined
  }
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Parse one route endpoint.
 *
 * @param value candidate endpoint
 * @param label field name used in the error message
 * @returns normalized endpoint
 * @throws AmapCliError with code `AMAP_INVALID_RESPONSE` when the endpoint is malformed
 */
function parseEndpoint(value: unknown, label: string): AmapRouteEndpoint {
  const record = requireRecord(value, label)
  const name = requireString(record['name'], `${label}.name`)
  const position = requireCoordinatePair(record['position'], `${label}.position`)
  return { name, position }
}

/**
 * Describe a value in an error message without dumping whole objects.
 *
 * @param value candidate value
 * @returns short description such as `"running"` or `type number`
 */
function describe(value: unknown): string {
  if (value === undefined) {
    return 'undefined'
  }
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  return `type ${typeof value}`
}

/**
 * Create an `AMAP_INVALID_RESPONSE` error.
 *
 * @param message caller-facing message
 * @param detail optional non-secret detail
 * @returns the constructed error
 */
function invalidResponse(message: string, detail?: string): AmapCliError {
  return new AmapCliError('AMAP_INVALID_RESPONSE', message, detail)
}

/**
 * Create an `AMAP_COMMAND_FAILED` error.
 *
 * @param message caller-facing message
 * @returns the constructed error
 */
function commandFailed(message: string): AmapCliError {
  return new AmapCliError('AMAP_COMMAND_FAILED', message)
}

/**
 * Create an `AMAP_UNSUPPORTED_ROUTE` error.
 *
 * @param message caller-facing message
 * @returns the constructed error
 */
function unsupportedRoute(message: string): AmapCliError {
  return new AmapCliError('AMAP_UNSUPPORTED_ROUTE', message)
}

/**
 * Compute the FNV-1a 32-bit hash of a string as zero-padded lowercase hex.
 *
 * @param input text to hash
 * @returns 8 hexadecimal digits
 */
function fnv1a32Hex(input: string): string {
  let hash = FNV_OFFSET_BASIS
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
