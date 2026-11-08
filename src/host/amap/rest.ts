/**
 * AMap Web-service (REST) POI search.
 *
 * The `amap-gui` CLI answers queries by driving a running JSAPI container, so
 * anything that goes through it can open a desktop window. The Web-service API
 * answers the same questions over plain HTTPS with a Web-service key, which is
 * what a photo lookup should use: no container, no window, a few hundred
 * milliseconds.
 */

/** One POI entry of a `place/text` response. */
interface RestPoi {
  readonly id?: unknown
  readonly name?: unknown
  readonly location?: unknown
  readonly address?: unknown
  readonly tel?: unknown
  readonly photos?: unknown
}

/** The fields this module keeps from a REST POI. */
export interface RestFoundPlace {
  /** AMap POI id, when the provider published one. */
  readonly providerPlaceId?: string
  readonly name: string
  readonly address?: string
  readonly telephone?: string
  readonly photoUrl?: string
}

/** Input for one REST POI search. */
export interface RestSearchInput {
  /** Web-service key; used host-side only and never sent to a browser. */
  readonly key: string
  readonly keyword: string
  /** City name or adcode; narrows and speeds up the search. */
  readonly city?: string
  readonly pageSize?: number
}

/** Options shared by the REST calls. */
export interface RestCallOptions {
  readonly signal?: AbortSignal | undefined
  /** Cooperative timeout budget in milliseconds. */
  readonly timeoutMs?: number
  /**
   * Minimum spacing between two calls, in milliseconds.
   *
   * Personal Web-service keys are capped at a few queries per second, so a
   * library-wide backfill must not fire back to back. `0` disables pacing.
   */
  readonly minIntervalMs?: number
  /** Test seam; defaults to the platform fetch. */
  readonly fetchImpl?: typeof fetch
  /** Test seam; defaults to the public endpoint. */
  readonly baseUrl?: string
}

/** Default endpoint. */
const DEFAULT_BASE = 'https://restapi.amap.com'
/** Default budget for one REST call. */
const DEFAULT_TIMEOUT_MS = 15_000
/** Default spacing between calls; personal keys allow only a few per second. */
const DEFAULT_MIN_INTERVAL_MS = 350
/** Epoch milliseconds of the last call, so back-to-back calls can be spaced. */
let lastCallAt = 0

/** Wait until this process may issue another call. */
async function pace(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return
  const now = Date.now()
  const wait = Math.max(0, lastCallAt + minIntervalMs - now)
  lastCallAt = now + wait
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}

/** Error raised for a provider answer this module cannot use. */
class RestError extends Error {
  /** Provider infocode, when the answer carried one. */
  readonly infocode: string | undefined
  /** True when the provider asked the caller to slow down. */
  readonly rateLimited: boolean

  constructor(message: string, infocode: string | undefined) {
    super(message)
    this.name = 'RestError'
    this.infocode = infocode
    this.rateLimited = infocode === '10021'
  }
}

/** Narrow one unknown field to a string, joining the arrays AMap sometimes returns. */
function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    return parts.length === 0 ? undefined : parts.join(' / ')
  }
  return undefined
}

/** First usable photo URL of one REST POI. */
function photoOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const url = asText((entry as { readonly url?: unknown }).url)
    if (url !== undefined) return url
  }
  return undefined
}

/**
 * One paced, retrying Web-service call.
 *
 * @param path - endpoint path plus query, without the base URL.
 * @param options - caller signal, budget, pacing and test seams.
 * @returns the decoded payload.
 * @throws {RestError} when the provider rejects the request.
 */
async function callRest(
  path: string,
  options: RestCallOptions,
): Promise<Record<string, unknown>> {
  const call = options.fetchImpl ?? fetch
  const base = options.baseUrl ?? DEFAULT_BASE
  const interval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  let attempt = 0
  for (;;) {
    await pace(interval)
    const controller = new AbortController()
    const budget = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), budget)
    const forward = (): void => controller.abort()
    options.signal?.addEventListener('abort', forward, { once: true })
    let payload: Record<string, unknown>
    let httpStatus = 0
    try {
      const response = await call(`${base}${path}`, { signal: controller.signal })
      httpStatus = response.status
      if (!response.ok) throw new RestError(`高德 Web 服务返回 HTTP ${String(response.status)}。`, undefined)
      payload = (await response.json()) as Record<string, unknown>
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', forward)
    }

    if (payload['status'] === '1') return payload
    const info = asText(payload['info']) ?? `HTTP ${String(httpStatus)}`
    const code = asText(payload['infocode'])
    const error = new RestError(
      code === '10001' || code === '10003'
        ? `高德 Web 服务 Key 无效或无权限（${info}，${code}）。请检查 amap.restKeyRef 指向的凭据。`
        : `高德 Web 服务查询失败：${info}${code === undefined ? '' : `（${code}）`}。`,
      code,
    )
    // A personal key allows only a few queries per second; one retry after a
    // pause covers the burst a library-wide backfill can produce.
    if (error.rateLimited && attempt < 2) {
      attempt += 1
      await new Promise((resolve) => setTimeout(resolve, Math.max(interval * 2, 600)))
      continue
    }
    throw error
  }
}

/** Map one REST POI entry onto the fields this module keeps. */
function toPlace(poi: RestPoi): RestFoundPlace | undefined {
  const name = asText(poi.name)
  if (name === undefined) return undefined
  const id = asText(poi.id)
  const address = asText(poi.address)
  const telephone = asText(poi.tel)
  const photoUrl = photoOf(poi.photos)
  return {
    ...id === undefined ? {} : { providerPlaceId: id },
    name,
    ...address === undefined ? {} : { address },
    ...telephone === undefined ? {} : { telephone },
    ...photoUrl === undefined ? {} : { photoUrl },
  }
}

/** The POI list of one decoded payload. */
function placesOf(payload: Record<string, unknown>): readonly RestPoi[] {
  return Array.isArray(payload['pois']) ? (payload['pois'] as readonly RestPoi[]) : []
}

/**
 * Search POIs through the Web-service API.
 *
 * @param input - key, keyword and city.
 * @param options - caller signal, timeout budget and test seams.
 * @returns the matches this module understands, plus the provider's total.
 * @throws {Error} with a user-facing message when the key is rejected or the
 *   provider answers with an error status.
 */
export async function searchPoisOverRest(
  input: RestSearchInput,
  options: RestCallOptions = {},
): Promise<{ readonly places: readonly RestFoundPlace[]; readonly total: number }> {
  const query = new URLSearchParams({
    key: input.key,
    keywords: input.keyword,
    extensions: 'all',
    offset: String(input.pageSize ?? 10),
    page: '1',
  })
  if (input.city !== undefined && input.city !== '') query.set('city', input.city)

  const payload = await callRest(`/v3/place/text?${query.toString()}`, options)
  const places: RestFoundPlace[] = []
  for (const poi of placesOf(payload)) {
    const place = toPlace(poi)
    if (place !== undefined) places.push(place)
  }
  const total = Number.parseInt(asText(payload['count']) ?? '0', 10)
  return { places, total: Number.isFinite(total) ? total : places.length }
}

/**
 * Read one POI by its AMap id.
 *
 * This is the exact path when a trip already recorded `providerPlaceId`: the id
 * is authoritative, so the answer needs no name matching and cannot attach a
 * neighbouring POI's photo to the wrong stop.
 *
 * @param input - key and POI id.
 * @param options - caller signal, timeout budget and test seams.
 * @returns the POI, or undefined when the provider has nothing for that id.
 * @throws {Error} with a user-facing message when the key is rejected.
 */
export async function getPoiByIdOverRest(
  input: { readonly key: string; readonly id: string },
  options: RestCallOptions = {},
): Promise<RestFoundPlace | undefined> {
  const query = new URLSearchParams({ key: input.key, id: input.id })
  const payload = await callRest(`/v3/place/detail?${query.toString()}`, options)
  for (const poi of placesOf(payload)) {
    const place = toPlace(poi)
    if (place !== undefined) return place
  }
  return undefined
}

/** One coordinate as an address lookup reports it. */
export interface RestGeocode {
  readonly longitude: number
  readonly latitude: number
  /** The provider's own wording of the address it matched. */
  readonly formattedAddress?: string
}

/**
 * Turn an address or a bare city name into a coordinate.
 *
 * A driving day is often only two names — 「西安 → 成都」 — and the map can draw
 * that road only when each name has a point. Geocoding is the HTTPS answer to
 * that question: no container, no window, one request. A name the provider does
 * not know is not an error here; it is simply a day whose road cannot be drawn
 * yet, so the answer is undefined.
 *
 * @param input - key, address text and an optional city hint.
 * @param options - caller signal, timeout budget and test seams.
 * @returns the coordinate, or undefined when the provider matched nothing.
 * @throws {Error} with a user-facing message when the key is rejected or the
 *   provider answers with an error status.
 */
export async function geocodeAddressOverRest(
  input: { readonly key: string; readonly address: string; readonly city?: string },
  options: RestCallOptions = {},
): Promise<RestGeocode | undefined> {
  const query = new URLSearchParams({ key: input.key, address: input.address })
  if (input.city !== undefined && input.city !== '') query.set('city', input.city)
  const payload = await callRest(`/v3/geocode/geo?${query.toString()}`, options)
  const geocodes = Array.isArray(payload['geocodes'])
    ? (payload['geocodes'] as readonly Record<string, unknown>[])
    : []
  const first = geocodes[0]
  if (first === undefined) return undefined
  const location = asText(first['location'])
  if (location === undefined) return undefined
  const [longitude, latitude] = location.split(',').map((part) => Number.parseFloat(part))
  if (longitude === undefined || latitude === undefined) return undefined
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return undefined
  const formattedAddress = asText(first['formatted_address'])
  return {
    longitude,
    latitude,
    ...formattedAddress === undefined ? {} : { formattedAddress },
  }
}

/** One driving route as the Web-service API reports it. */
export interface RestDrivingRoute {
  readonly distanceMeters: number
  readonly durationSeconds: number
  readonly tollsYuan?: number
  /** Provider path as `lng,lat;lng,lat…`, ready for an AMap `Polyline`. */
  readonly polyline: string
}

/** Join the per-step paths of one route into a single provider path. */
function joinPolylines(steps: readonly Record<string, unknown>[]): string {
  const parts: string[] = []
  for (const step of steps) {
    const polyline = asText(step['polyline'])
    if (polyline === undefined || polyline === '') continue
    parts.push(polyline)
  }
  return parts.join(';')
}

/**
 * Plan a driving route through the Web-service API.
 *
 * The CLI's route answer carries turn-by-turn text but no geometry, so a
 * transit drawn from it can only be a straight line between its ends. This call
 * returns the provider's own path, which is what makes a long drive look like
 * the road it is.
 *
 * @param input - key, origin and destination as `lng,lat`.
 * @param options - caller signal, timeout budget and test seams.
 * @returns distance, duration, tolls and the path.
 * @throws {Error} with a user-facing message when the key is rejected or the
 *   provider has no route.
 */
export async function drivingRouteOverRest(
  input: { readonly key: string; readonly origin: string; readonly destination: string },
  options: RestCallOptions = {},
): Promise<RestDrivingRoute> {
  const query = new URLSearchParams({
    key: input.key,
    origin: input.origin,
    destination: input.destination,
    show_fields: 'cost,polyline',
    strategy: '32',
  })
  const payload = await callRest(`/v5/direction/driving?${query.toString()}`, options)
  const route = payload['route']
  const paths =
    typeof route === 'object' && route !== null && Array.isArray((route as Record<string, unknown>)['paths'])
      ? ((route as Record<string, unknown>)['paths'] as readonly Record<string, unknown>[])
      : []
  const path = paths[0]
  const distance = path === undefined ? Number.NaN : Number.parseFloat(asText(path['distance']) ?? '')
  if (path === undefined || !Number.isFinite(distance)) {
    throw new RestError('高德 Web 服务没有返回这条驾车路线。', undefined)
  }
  const cost = typeof path['cost'] === 'object' && path['cost'] !== null ? (path['cost'] as Record<string, unknown>) : {}
  const duration = Number.parseFloat(asText(cost['duration']) ?? '')
  const tolls = Number.parseFloat(asText(cost['tolls']) ?? '')
  const steps = Array.isArray(path['steps']) ? (path['steps'] as readonly Record<string, unknown>[]) : []
  return {
    distanceMeters: Math.round(distance),
    durationSeconds: Number.isFinite(duration) ? Math.round(duration) : 0,
    ...Number.isFinite(tolls) ? { tollsYuan: tolls } : {},
    polyline: joinPolylines(steps),
  }
}
