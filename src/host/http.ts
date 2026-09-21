import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { TripRevisionError } from '../domain/patch.js'
import { AmapCliError } from './amap/cli.js'
import { parsePatchOps } from './patch-input.js'
import type { TravelService } from './travel-service.js'
import type { PlaceFactRefresh } from './travel-service.js'
import { TripStoreError } from './trip-store.js'
import { countAlerts, type AmapRuntimeView } from './view.js'

/** Structural view of the web server route seat. */
export interface WebServerLike {
  register(route: { readonly kind: 'exact' | 'prefix'; readonly path: string; readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
  /** Optional raw-HTML index transform used to publish the API path to the browser. */
  tapIndex?(transform: (html: string) => string): () => void
}

/** Dependencies of the browser API. */
export interface TravelHttpDeps {
  /** Shared travel service. */
  readonly service: TravelService
  /** Whether AMap credentials were configured, for the runtime view. */
  readonly configuration: () => { readonly configured: boolean; readonly missing: readonly string[] }
}

/** Maximum accepted request body, in bytes. */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Register the browser-facing JSON API.
 *
 * The sidebar reads and mutates trips through this one prefix; nothing else
 * crosses the Host/Client boundary, and every response is lossless JSON.
 * @param ctx - plugin context, used only for logging.
 * @param webServer - route seat.
 * @param prefix - absolute path prefix without a trailing slash.
 * @param deps - service and configuration facts.
 * @returns the route disposer.
 */
export function registerTravelHttp(
  ctx: Context,
  webServer: WebServerLike,
  prefix: string,
  deps: TravelHttpDeps,
): () => void {
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const route = url.pathname.slice(prefix.length) === '' ? '/' : url.pathname.slice(prefix.length)
    try {
      if (req.method === 'GET' && route === '/state') {
        const view = await deps.service.view(
          url.searchParams.get('sessionId') ?? undefined,
          url.searchParams.get('tripId') ?? undefined,
        )
        sendJson(res, 200, { ok: true, view, amap: readAmapView(deps) })
        return
      }
      if (req.method === 'GET' && route === '/health') {
        sendJson(res, 200, { ok: true, ...deps.configuration(), amap: readAmapView(deps) })
        return
      }
      if (req.method === 'POST' && route === '/patch') {
        const body = await readJsonBody(req)
        if (!isRecord(body)) {
          sendJson(res, 400, { ok: false, error: 'request body must be a JSON object' })
          return
        }
        const parsed = parsePatchOps(body['ops'])
        if (parsed.ops.length === 0) {
          sendJson(res, 200, { ok: true, changed: false, applied: [], rejected: [], violations: parsed.violations })
          return
        }
        const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : undefined
        const tripId = typeof body['tripId'] === 'string' ? body['tripId'] : undefined
        const expectedRevision = typeof body['expectedRevision'] === 'number' ? body['expectedRevision'] : undefined
        try {
          const application = await deps.service.patch(sessionId, tripId, parsed.ops, expectedRevision)
          sendJson(res, 200, {
            ok: true,
            changed: application.outcome.changed,
            applied: application.outcome.applied,
            rejected: application.outcome.rejected,
            violations: parsed.violations,
            revision: application.project.revision,
            alerts: countAlerts(application.validation.alerts),
            view: await deps.service.view(sessionId, application.project.id),
          })
        } catch (error) {
          if (error instanceof TripRevisionError) {
            sendJson(res, 409, {
              ok: false,
              error: error.message,
              code: error.code,
              expectedRevision: error.expectedRevision,
              actualRevision: error.actualRevision,
              violations: parsed.violations,
            })
            return
          }
          throw error
        }
        return
      }
      if (req.method === 'POST' && route === '/select') {
        const body = await readJsonBody(req)
        if (!isRecord(body)) {
          sendJson(res, 400, { ok: false, error: 'request body must be a JSON object' })
          return
        }
        const tripId = typeof body['tripId'] === 'string' ? body['tripId'].trim() : ''
        if (tripId === '') {
          sendJson(res, 400, { ok: false, error: 'tripId is required' })
          return
        }
        const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : undefined
        const asDefault = body['asDefault'] === true
        const activeTripId = await deps.service.select(sessionId, tripId, asDefault)
        sendJson(res, 200, {
          ok: true,
          activeTripId,
          view: await deps.service.view(sessionId, activeTripId),
        })
        return
      }
      if (req.method === 'POST' && route === '/reflow-day') {
        const body = await readJsonBody(req)
        if (!isRecord(body)) {
          sendJson(res, 400, { ok: false, error: 'request body must be a JSON object' })
          return
        }
        const dayId = typeof body['dayId'] === 'string' ? body['dayId'].trim() : ''
        if (dayId === '') {
          sendJson(res, 400, { ok: false, error: 'dayId is required' })
          return
        }
        const rawOrder: readonly unknown[] | undefined = Array.isArray(body['order']) ? (body['order'] as readonly unknown[]) : undefined
        const order = rawOrder?.filter((entry): entry is string => typeof entry === 'string')
        if (rawOrder !== undefined && (order === undefined || order.length === 0 || order.length !== rawOrder.length)) {
          sendJson(res, 400, { ok: false, error: 'order must be a non-empty array of item ids' })
          return
        }
        const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : undefined
        const tripId = typeof body['tripId'] === 'string' ? body['tripId'] : undefined
        const expectedRevision = typeof body['expectedRevision'] === 'number' ? body['expectedRevision'] : undefined
        const application = await deps.service.patch(
          sessionId,
          tripId,
          [order === undefined ? { kind: 'reflow-day', dayId } : { kind: 'reorder-day', dayId, order }],
          expectedRevision,
        )
        sendJson(res, 200, {
          ok: true,
          changed: application.outcome.changed,
          applied: application.outcome.applied,
          rejected: application.outcome.rejected,
          revision: application.project.revision,
          alerts: countAlerts(application.validation.alerts),
          view: await deps.service.view(sessionId, application.project.id),
        })
        return
      }
      if (req.method === 'POST' && route === '/rebuild-legs') {
        const body = await readJsonBody(req)
        if (!isRecord(body)) {
          sendJson(res, 400, { ok: false, error: 'request body must be a JSON object' })
          return
        }
        const dayId = typeof body['dayId'] === 'string' ? body['dayId'].trim() : ''
        if (dayId === '') {
          sendJson(res, 400, { ok: false, error: 'dayId is required' })
          return
        }
        const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : undefined
        const tripId = typeof body['tripId'] === 'string' ? body['tripId'] : undefined
        const mode = body['mode']
        const city = typeof body['city'] === 'string' && body['city'].trim() !== '' ? body['city'].trim() : undefined
        const rebuilt = await deps.service.rebuildDayLegs(sessionId, tripId, dayId, {
          ...isTravelMode(mode) ? { mode } : {},
          ...city === undefined ? {} : { city },
        })
        sendJson(res, 200, {
          ok: true,
          ...rebuilt,
          skipped: [...rebuilt.skipped],
          view: await deps.service.view(sessionId, tripId),
        })
        return
      }
      if (req.method === 'POST' && route === '/refresh-places') {
        const body = await readJsonBody(req)
        if (!isRecord(body)) {
          sendJson(res, 400, { ok: false, error: 'request body must be a JSON object' })
          return
        }
        const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : undefined
        const tripId = typeof body['tripId'] === 'string' ? body['tripId'] : undefined
        const placeId = typeof body['placeId'] === 'string' ? body['placeId'] : undefined
        // Only an explicit request may open the AMap window: a cold container
        // answers with `needsStart` instead of appearing on screen unasked.
        let refreshed: PlaceFactRefresh
        try {
          refreshed = await deps.service.refreshPlaceFacts(sessionId, tripId, {
            ...placeId === undefined ? {} : { placeId },
            allowStart: body['start'] === true,
          })
        } catch (error) {
          if (error instanceof AmapCliError && error.code === 'AMAP_NOT_RUNNING') {
            sendJson(res, 200, {
              ok: true,
              checked: 0,
              updated: 0,
              unmatched: [],
              needsStart: true,
              error: error.message,
              view: await deps.service.view(sessionId, tripId),
            })
            return
          }
          throw error
        }
        sendJson(res, 200, {
          ok: true,
          ...refreshed,
          unmatched: [...refreshed.unmatched],
          view: await deps.service.view(sessionId, tripId),
        })
        return
      }
      if (req.method === 'POST' && route === '/focus') {
        const body = await readJsonBody(req)
        const gateway = deps.service.amap
        if (gateway === undefined || !isRecord(body)) {
          sendJson(res, 503, { ok: false, error: 'amap gateway unavailable' })
          return
        }
        const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : undefined
        const tripId = typeof body['tripId'] === 'string' ? body['tripId'] : undefined
        const dayId = typeof body['dayId'] === 'string' ? body['dayId'] : undefined
        const project = await deps.service.resolve(sessionId, tripId)
        if (project === undefined) {
          sendJson(res, 404, { ok: false, error: 'no trip project' })
          return
        }
        const scenario = project.scenarios.find((entry) => entry.id === project.activeScenarioId)
        const day = dayId === undefined ? undefined : scenario?.days.find((entry) => entry.id === dayId)
        const points = (day?.items ?? [])
          .map((item) => project.places[item.placeId]?.point)
          .filter((point): point is NonNullable<typeof point> => point !== undefined)
        if (points.length === 0) {
          sendJson(res, 400, { ok: false, error: 'day has no located places' })
          return
        }
        const center = {
          longitude: points.reduce((sum, point) => sum + point.longitude, 0) / points.length,
          latitude: points.reduce((sum, point) => sum + point.latitude, 0) / points.length,
          coordinateSystem: 'gcj02' as const,
        }
        await gateway.focusMap({ center, zoom: 14 })
        sendJson(res, 200, { ok: true, center })
        return
      }
      sendJson(res, 404, { ok: false, error: `unknown route ${route}` })
    } catch (error) {
      const described = describeError(error)
      loggerOf(ctx).warn(`travel-planner: api ${route} failed: ${described.message}`)
      sendJson(res, described.status, { ok: false, code: described.code, error: described.message })
    }
  }

  return webServer.register({ kind: 'prefix', path: prefix, handler })
}

/** Build the AMap runtime view shown by the sidebar. */
function readAmapView(deps: TravelHttpDeps): AmapRuntimeView {
  const configuration = deps.configuration()
  const gateway = deps.service.amap
  const snapshot = gateway?.snapshot()
  return {
    status: snapshot?.status ?? 'unavailable',
    mapReady: snapshot?.mapReady ?? false,
    startedByPlugin: snapshot?.startedByPlugin ?? false,
    configured: configuration.configured,
    missing: configuration.missing,
  }
}

/** Map a thrown value into a status code, an optional code and a safe message. */
function describeError(error: unknown): { readonly status: number; readonly code?: string; readonly message: string } {
  if (error instanceof TripRevisionError) {
    return { status: 409, code: error.code, message: error.message }
  }
  if (error instanceof TripStoreError) {
    const status = error.code === 'TRIP_NOT_FOUND' ? 404 : 400
    return { status, code: error.code, message: error.message }
  }
  if (error instanceof AmapCliError) {
    const status = error.code === 'AMAP_CLI_NOT_FOUND' || error.code === 'AMAP_CREDENTIAL_MISSING' ? 503 : 502
    return { status, code: error.code, message: error.message }
  }
  return { status: 500, message: error instanceof Error ? error.message : String(error) }
}

/** Whether the request comes from the served application origin. */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read and parse a bounded JSON body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/** Send one JSON response. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** Whether a value is one of the modes the CLI accepts. */
function isTravelMode(value: unknown): value is 'walking' | 'transit' | 'riding' | 'driving' {
  return value === 'walking' || value === 'transit' || value === 'riding' || value === 'driving'
}

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Best-effort logger access without making logging a hard dependency. */
function loggerOf(ctx: Context): { warn(message: string): void } {
  const logger = (ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger
  return {
    warn: (message: string) => {
      logger?.warn?.(message)
    },
  }
}
