import type { AmapConfig } from '../config.js'
import type { GeoPoint, RouteLeg, RouteStep, TripPlace, TravelMode } from '../../domain/trip.js'
import {
  AmapCliError,
  parseRoute,
  parseSearchPoi,
  parseStatus,
  poiCacheKey,
  routeArgs,
  routeCacheKey,
  searchPoiArgs,
  type AmapStatusData,
} from './cli.js'
import { normalizePlace, normalizeRouteLeg, placeCacheId } from './normalize.js'
import type { ExecLike } from './exec.js'

/** Route facts for one origin/destination pair, independent of any itinerary. */
export interface RouteFact {
  readonly mode: TravelMode
  readonly distanceMeters: number
  readonly durationSeconds: number
  readonly tollsYuan?: number
  readonly steps: readonly RouteStep[]
  readonly from: { readonly name: string; readonly point: GeoPoint }
  readonly to: { readonly name: string; readonly point: GeoPoint }
  readonly fetchedAt: string
  readonly fromCache: boolean
}

/** One POI search outcome. */
export interface PlaceSearchOutcome {
  readonly keyword: string
  readonly total: number
  readonly places: readonly TripPlace[]
  readonly fromCache: boolean
}

/** Runtime state of the AMap container as this plugin last observed it. */
export interface AmapRuntimeState {
  readonly status: AmapStatusData['status']
  readonly mapReady: boolean
  readonly port?: number
  readonly startedByPlugin: boolean
  readonly lastError?: string
}

/** Logger seam; the plugin passes a console-backed implementation. */
export interface AmapLogger {
  info(message: string): void
  warn(message: string): void
}

/** Constructor dependencies. */
export interface AmapGatewayOptions {
  readonly exec: ExecLike
  /** Resolve CLI environment variables (credentials) at call time. */
  readonly env: () => Promise<Readonly<Record<string, string>>>
  /** Per-call working directory. */
  readonly cwd: string
  readonly amap: AmapConfig
  readonly clock?: () => number
  readonly logger?: AmapLogger
}

interface CacheEntry {
  readonly expiresAt: number
  readonly value: unknown
}

/** Search input accepted by {@link AmapGateway.searchPlaces}. */
export interface GatewaySearchInput {
  readonly keyword: string
  readonly city?: string
  readonly center?: GeoPoint
  readonly radiusMeters?: number
  readonly pageSize?: number
  readonly pageIndex?: number
}

/** Route input accepted by {@link AmapGateway.planRoute}. */
export interface GatewayRouteInput {
  readonly from: string
  readonly to: string
  readonly mode: TravelMode
  readonly fromName?: string
  readonly toName?: string
  readonly waypoints?: readonly string[]
  readonly city?: string
  readonly policy?: 'fastest' | 'least_fee' | 'shortest' | 'no_highway' | 'avoid_jam'
  readonly strategy?: 'fastest' | 'least_cost' | 'least_walk' | 'most_comfort' | 'no_subway'
}

/** The AMap CLI gateway: one serialized owner of the shared CLI and its container. */
export class AmapGateway {
  private readonly options: AmapGatewayOptions
  private readonly cache = new Map<string, CacheEntry>()
  private tail: Promise<unknown> = Promise.resolve()
  private disposePromise: Promise<void> | undefined
  private disposed = false
  private startedByPlugin = false
  private state: AmapRuntimeState = { status: 'not_running', mapReady: false, startedByPlugin: false }

  /**
   * @param options - execution seam, credential provider, working directory and settings.
   */
  constructor(options: AmapGatewayOptions) {
    this.options = options
  }

  /** The container state as last observed. */
  snapshot(): AmapRuntimeState {
    return this.state
  }

  /**
   * Ensure the executable answers and the map container is ready.
   *
   * Starting the container opens the AMap desktop window, so a caller that only
   * wants a nicety — a place photo, say — must pass `allowStart: false` and be
   * told to ask for the container instead of having it appear on screen.
   *
   * @param signal - caller cancellation.
   * @param options - whether this call may start the container.
   * @returns the observed state.
   * @throws {AmapCliError} `AMAP_NOT_RUNNING` when the container is down and this
   *   call is not allowed to start it.
   */
  async ensureReady(signal?: AbortSignal, options: { readonly allowStart?: boolean } = {}): Promise<AmapRuntimeState> {
    const current = await this.status(signal)
    if (current.status === 'running' && current.mapReady) return this.state
    if (options.allowStart === false) {
      throw new AmapCliError(
        'AMAP_NOT_RUNNING',
        '高德地图容器未运行。启动它会打开高德地图窗口，所以只有在你明确要求时才会启动。',
      )
    }
    if (!this.options.amap.autoStart) {
      throw new AmapCliError(
        'AMAP_NOT_READY',
        '高德地图容器未运行，且当前配置禁止自动启动。请在插件设置中开启自动启动，或手动执行 amap-gui start。',
      )
    }
    const result = await this.run(['start'], { signal, cacheable: false, timeoutMs: this.options.amap.commandTimeoutMs })
    const parsed = parseStatus(result)
    if (parsed.mapReady !== true) {
      throw new AmapCliError('AMAP_START_FAILED', '高德地图容器已启动，但地图尚未就绪。')
    }
    this.startedByPlugin = true
    this.state = { status: 'running', mapReady: true, startedByPlugin: true, ...parsed.port === undefined ? {} : { port: parsed.port } }
    return this.state
  }

  /**
   * Read the container status without changing it.
   * @param signal - caller cancellation.
   * @returns the parsed status.
   */
  async status(signal?: AbortSignal): Promise<AmapStatusData> {
    try {
      const parsed = parseStatus(await this.run(['status'], { signal, cacheable: false }))
      this.state = {
        status: parsed.status,
        mapReady: parsed.mapReady === true,
        startedByPlugin: this.startedByPlugin,
        ...parsed.port === undefined ? {} : { port: parsed.port },
      }
      return parsed
    } catch (error) {
      this.state = {
        status: 'not_running',
        mapReady: false,
        startedByPlugin: this.startedByPlugin,
        lastError: error instanceof Error ? error.message : String(error),
      }
      throw error
    }
  }

  /**
   * Search POIs through the CLI, with a bounded cache.
   * @param input - search parameters.
   * @param signal - caller cancellation.
   * @param options - whether a cold container may be started (default yes).
   * @returns normalized places.
   */
  async searchPlaces(
    input: GatewaySearchInput,
    signal?: AbortSignal,
    options: { readonly allowStart?: boolean } = {},
  ): Promise<PlaceSearchOutcome> {
    const key = poiCacheKey(input)
    const cached = this.readCache<PlaceSearchOutcome>(key)
    if (cached !== undefined) return { ...cached, fromCache: true }
    await this.ensureReady(signal, options)
    const data = parseSearchPoi(
      await this.run(searchPoiArgs(input), { signal, cacheable: false }),
    )
    const fetchedAt = new Date(this.now()).toISOString()
    const places = data.pois.map((poi) =>
      normalizePlace(poi, { id: placeCacheId(poi.id), fetchedAt, status: 'candidate' }),
    )
    const outcome: PlaceSearchOutcome = {
      keyword: data.keyword,
      total: data.total,
      places,
      fromCache: false,
    }
    this.writeCache(key, outcome, this.options.amap.poiCacheTtlMs)
    return outcome
  }

  /**
   * Plan one route through the CLI, with a bounded cache.
   * @param input - route parameters.
   * @param signal - caller cancellation.
   * @returns the route facts.
   */
  async planRoute(input: GatewayRouteInput, signal?: AbortSignal): Promise<RouteFact> {
    const key = routeCacheKey(input)
    const cached = this.readCache<RouteFact>(key)
    if (cached !== undefined) return { ...cached, fromCache: true }
    await this.ensureReady(signal)
    const raw = parseRoute(await this.run(routeArgs(input), { signal, cacheable: false }))
    const fetchedAt = new Date(this.now()).toISOString()
    const leg: RouteLeg = normalizeRouteLeg(raw, {
      id: `route-${key.slice('route:'.length)}`,
      fromItemId: input.fromName ?? input.from,
      toItemId: input.toName ?? input.to,
      mode: input.mode,
      fetchedAt,
    })
    const fact: RouteFact = {
      mode: leg.mode,
      distanceMeters: leg.distanceMeters,
      durationSeconds: leg.durationSeconds,
      ...leg.tollsYuan === undefined ? {} : { tollsYuan: leg.tollsYuan },
      steps: leg.steps,
      from: { name: raw.from.name, point: { longitude: raw.from.position[0], latitude: raw.from.position[1], coordinateSystem: 'gcj02' } },
      to: { name: raw.to.name, point: { longitude: raw.to.position[0], latitude: raw.to.position[1], coordinateSystem: 'gcj02' } },
      fetchedAt,
      fromCache: false,
    }
    this.writeCache(key, fact, this.options.amap.routeCacheTtlMs)
    return fact
  }

  /**
   * Ask the shared AMap container to show one view.
   * @param input - center, zoom and style.
   * @param signal - caller cancellation.
   */
  async focusMap(input: { readonly center: GeoPoint; readonly zoom?: number; readonly style?: string }, signal?: AbortSignal): Promise<void> {
    await this.ensureReady(signal)
    const args = [
      'mapState',
      '--action',
      'set',
      '--center',
      `${input.center.longitude},${input.center.latitude}`,
    ]
    if (input.zoom !== undefined) args.push('--zoom', String(Math.max(3, Math.min(20, Math.trunc(input.zoom)))))
    if (input.style !== undefined && input.style.trim() !== '') args.push('--style', input.style.trim())
    await this.run(args, { signal, cacheable: false })
  }

  /**
   * Release the gateway: stop the container only when this plugin started it.
   * Idempotent.
   */
  async dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      this.disposed = true
      this.cache.clear()
      await this.tail.catch(() => undefined)
      if (!this.startedByPlugin || !this.options.amap.autoStop) return
      try {
        await this.run(['stop'], { cacheable: false, allowDisposed: true })
        this.startedByPlugin = false
        this.state = { status: 'stopped', mapReady: false, startedByPlugin: false }
      } catch (error) {
        this.options.logger?.warn(`travel-planner: amap-gui stop failed: ${describe(error)}`)
      }
    })()
    await this.disposePromise
  }

  /** Run one CLI command through the serialized queue. */
  private run(
    args: readonly string[],
    options: { readonly signal?: AbortSignal | undefined; readonly cacheable: boolean; readonly timeoutMs?: number; readonly allowDisposed?: boolean },
  ): Promise<string> {
    if (this.disposed && options.allowDisposed !== true) {
      return Promise.reject(new AmapCliError('AMAP_COMMAND_ABORTED', '旅行插件已停止，无法再调用高德 CLI。'))
    }
    const task = async (): Promise<string> => {
      const env = await this.options.env()
      const result = await this.options.exec({
        argv: [this.options.amap.executable, ...args],
        cwd: this.options.cwd,
        env,
        timeoutMs: options.timeoutMs ?? this.options.amap.commandTimeoutMs,
        signal: options.signal,
      })
      if (result.aborted) {
        throw new AmapCliError('AMAP_COMMAND_ABORTED', '高德 CLI 调用已被取消。')
      }
      if (result.timedOut) {
        throw new AmapCliError('AMAP_COMMAND_TIMEOUT', `高德 CLI 在 ${String(options.timeoutMs ?? this.options.amap.commandTimeoutMs)}ms 内未返回结果。`)
      }
      if (result.exitCode !== 0) {
        throw new AmapCliError(
          'AMAP_COMMAND_FAILED',
          `高德 CLI 退出码 ${String(result.exitCode ?? 'null')}。`,
          result.stderr.trim().slice(0, 500),
        )
      }
      return result.stdout
    }
    const queued = this.tail.then(task, task)
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  /** Current epoch milliseconds. */
  private now(): number {
    return this.options.clock?.() ?? Date.now()
  }

  /** Read a live cache entry. */
  private readCache<T>(key: string): T | undefined {
    const entry = this.cache.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key)
      return undefined
    }
    return entry.value as T
  }

  /** Store a cache entry when a positive lifetime is configured. */
  private writeCache(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) return
    this.cache.set(key, { expiresAt: this.now() + ttlMs, value })
  }
}

/** Describe an unknown thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
