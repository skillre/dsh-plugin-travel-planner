import type {
  GeoPoint,
  ItineraryItem,
  RouteStep,
  TravelMode,
  TripAlert,
  TripDay,
  TripProject,
  TripTransit,
} from '../domain/trip.js'
import { formatPoint } from './amap/cli.js'
import { renderTripMarkdown } from '../domain/markdown.js'
import { applyTripPatch, type PatchOutcome, type TripPatchOp } from '../domain/patch.js'
import { validateTrip, type RouteStaleMode, type ValidationResult } from '../domain/validation.js'
import {
  TripStore,
  TripStoreError,
  summarize,
  type TripFs,
  type TripSummary,
  type WorkspaceState,
} from './trip-store.js'
import { buildTravelView, countAlerts, type TravelView } from './view.js'
import { AmapCliError } from './amap/cli.js'
import type { TripSelectionSource } from '../shared/view.js'
import type { AmapGateway } from './amap/gateway.js'
import type { RestCallOptions, RestFoundPlace } from './amap/rest.js'
import { drivingRouteOverRest, geocodeAddressOverRest, getPoiByIdOverRest, searchPoisOverRest } from './amap/rest.js'
import { isTransitFillDay, parseTransferTitle } from './transit-fill.js'

/**
 * Why a fill pass could not plan a day when nothing can be asked.
 *
 * The panel shows this verbatim, so it names the one thing the user can change:
 * configuring a Web-service key (the CLI alternative would open a map window,
 * which a batch pass may not do on its own).
 */
const NO_PROVIDER_REASON = '没有可用的高德 Web 服务 Key'

/** Dependencies of the travel service. */
export interface TravelServiceDeps {
  /** Filesystem adapter used by every store instance. */
  readonly fs: TripFs
  /** Workspace-relative store directory. */
  readonly subdirectory: string
  /** Fallback currency for trips that do not carry one. */
  readonly currency: string
  /** Working directory used when a session has none. */
  readonly fallbackCwd: string
  /** Resolve the working directory owning one session's workspace. */
  readonly cwdFor: (sessionId?: string) => Promise<string>
  /** Current epoch milliseconds. */
  readonly clock: () => number
  /** Current AMap gateway, if the CLI path is available. */
  readonly gateway?: () => AmapGateway | undefined
  /**
   * Resolve the AMap Web-service key, when the deployment has one.
   *
   * With it, provider facts are read over HTTPS and the CLI container is never
   * needed — which is what keeps a photo lookup from opening the AMap window.
   */
  readonly restKey?: () => Promise<string | undefined>
  /**
   * Fetch implementation used by the Web-service calls.
   *
   * A test seam: the REST answers are parsed by pure code in `amap/rest.ts`, but
   * a batch fill also needs to be exercised end to end without a network.
   */
  readonly restFetch?: typeof fetch
  /** AMap Web (JS API) key for the in-panel map; empty disables the browser map. */
  readonly browserMapKey?: () => Promise<string | undefined>
  /** Whether the browser map is allowed at all. */
  readonly browserMapEnabled?: boolean
  /** Route staleness budget in milliseconds. */
  readonly routeStaleAfterMs?: number
  /** How strictly an expired route is graded against the trip's dates. */
  readonly routeStaleMode?: RouteStaleMode
  /** Whether provider photo URLs may be projected to the browser. */
  readonly includePhotos?: boolean
  /** Fact staleness budget in milliseconds. */
  readonly factStaleAfterMs?: number
}

/** Result of one patch request. */
export interface PatchApplication {
  readonly project: TripProject
  readonly outcome: PatchOutcome
  readonly validation: ValidationResult
}

/** Which provider interface answered a fact lookup. */
export type PlaceFactSource = 'web-service' | 'amap-cli'

/** Outcome of one provider-fact refresh. */
export interface PlaceFactRefresh {
  /** Places that were missing facts and got looked up. */
  readonly checked: number
  /** Places that gained at least one fact. */
  readonly updated: number
  /** Places the provider could not be matched for, by place id. */
  readonly unmatched: readonly string[]
  /** Which interface answered, so callers can say so. */
  readonly source: PlaceFactSource
}

/** Outcome of one transport rebuild. */
export interface LegRebuildResult {
  readonly dayId: string
  readonly legs: number
  readonly totalDistanceMeters: number
  readonly totalDurationSeconds: number
  /** Item pairs skipped because one of their places is missing. */
  readonly skipped: readonly string[]
}

/** What the caller tells `setDayTransit` about one end of the move. */
export interface TransitEndInput {
  /** A place already in the trip library; gives the end its coordinates. */
  readonly placeId?: string
  /** A name to show when there is no place: 「西安」. */
  readonly label?: string
  /** A known coordinate for a name-only end; skips the geocode when present. */
  readonly point?: GeoPoint
}

/**
 * Everything `setDayTransit` accepts.
 *
 * `distanceMeters` and `durationSeconds` are what a caller already knows — a day
 * title that states 723 km — and are used only when the route cannot be planned.
 */
export interface TransitWriteInput {
  readonly id?: string
  readonly from: TransitEndInput
  readonly to: TransitEndInput
  readonly mode?: TravelMode
  readonly distanceMeters?: number
  readonly durationSeconds?: number
  readonly departAt?: string
  readonly arriveAt?: string
  /** `false` keeps the caller's figures and asks the provider for nothing. */
  readonly plan?: boolean
  readonly signal?: AbortSignal
}

/** Outcome of writing one transit. */
export interface TransitWriteResult {
  readonly dayId: string
  readonly transitId: string
  readonly distanceMeters?: number
  readonly durationSeconds?: number
  /** How the figures were obtained: a planned route, or the caller's numbers. */
  readonly planned: boolean
  readonly polyline: boolean
}

/** What one day of a batch fill did. */
export interface TransitFillDayResult {
  readonly dayId: string
  readonly planned: boolean
  readonly distanceMeters?: number
  readonly durationSeconds?: number
  /** True when the provider's own path was stored, not just the two ends. */
  readonly polyline: boolean
  /** Why the day was left alone, when it was. */
  readonly reason?: string
}

/** Outcome of one batch fill of the transits day titles claim. */
export interface TransitFillResult {
  /** Days whose road was planned and written. */
  readonly planned: number
  /** Days left alone, each with its reason. */
  readonly skipped: number
  readonly days: readonly TransitFillDayResult[]
}

/** One transit end after the library and the geocoder have had their say. */
interface ResolvedTransitEnd {
  readonly placeId?: string
  readonly label: string
  readonly point?: GeoPoint
}

/** What a provider answered for one transit's road. */
interface PlannedMove {
  readonly distanceMeters?: number
  readonly durationSeconds?: number
  readonly tollsYuan?: number
  /** Provider path as `lng,lat;lng,lat…`; only the Web-service API returns one. */
  readonly polyline?: string
  readonly steps: readonly RouteStep[]
  readonly fetchedAt: string
}

/**
 * The next free transit id for a day.
 *
 * Counting the existing ones is not enough: an id a caller chose can already sit
 * at the number a count would produce, and an upsert keyed by id would then
 * overwrite somebody else's transit instead of adding one.
 *
 * @param day - day the transit belongs to.
 * @returns an id of the form `d2-transit-3` that no transit of the day uses.
 */
function nextTransitId(day: TripDay): string {
  const used = new Set((day.transits ?? []).map((transit) => transit.id))
  for (let index = used.size + 1; ; index += 1) {
    const candidate = `${day.id}-transit-${String(index)}`
    if (!used.has(candidate)) return candidate
  }
}

/**
 * Add a duration to a timestamp, keeping the timestamp's own offset text.
 *
 * The panel reads a clock by slicing the text (`clockLabel`), and every other
 * timestamp in a project carries its local offset, so an arrival written as UTC
 * would read as the wrong hour — 06:00 + 12.6 h is 18:38 in `+08:00`, not
 * 10:38. `Z` and offset-less timestamps keep the ISO form they came in with.
 *
 * @param from - the departure timestamp.
 * @param seconds - how long the journey takes.
 * @returns the arrival timestamp in the same shape, or undefined when `from` is unparsable.
 */
function addDuration(from: string, seconds: number): string | undefined {
  const start = Date.parse(from)
  if (!Number.isFinite(start) || from.length < 16) return undefined
  const shifted = new Date(start + seconds * 1000)
  const offset = /([+-]\d{2}:\d{2})$/.exec(from.slice(16))?.[1]
  if (offset === undefined) return shifted.toISOString()
  const sign = offset.startsWith('-') ? -1 : 1
  const [hours, minutes] = offset.slice(1).split(':').map((part) => Number.parseInt(part, 10))
  const local = new Date(shifted.getTime() + sign * ((hours ?? 0) * 60 + (minutes ?? 0)) * 60_000)
  return `${local.toISOString().slice(0, 19)}${offset}`
}

/** Which trip is in force, and why. */
export interface TripSelection {
  readonly tripId: string
  readonly source: TripSelectionSource
}

/** One trip with the validation numbers the switcher shows. */
export interface TripStats {
  readonly summary: TripSummary
  readonly readiness: number
  readonly alerts: { readonly error: number; readonly warning: number; readonly info: number }
}

/**
 * Orchestrates trips across the filesystem, deterministic validation, and the
 * AMap gateway. Both the model tools and the browser API talk to trips through
 * this one service so their semantics cannot drift.
 */
export class TravelService {
  private readonly deps: TravelServiceDeps
  private readonly stores = new Map<string, TripStore>()
  /** Per-trip validation results, keyed by `id@revision`. */
  private readonly statsMemo = new Map<string, { readonly readiness: number; readonly alerts: TripStats['alerts'] }>()
  /** `direct` once a Web-service key resolved; `container` otherwise. */
  private photoMode: 'direct' | 'container' | undefined
  /**
   * Geocoded names, keyed by the name as written.
   *
   * A driving trip names the same few cities over and over — 「西安」 appears on
   * the day that leaves it and the day that reaches it — and every lookup spends
   * key quota. `'none'` records a name the provider does not know, which will not
   * change under us; failures are not cached, because a key can be fixed.
   */
  private readonly geocodes = new Map<string, GeoPoint | 'none'>()

  /**
   * @param deps - filesystem, path resolution, clock and gateway seams.
   */
  constructor(deps: TravelServiceDeps) {
    this.deps = deps
  }

  /** The gateway when the CLI path was composed. */
  get amap(): AmapGateway | undefined {
    return this.deps.gateway?.()
  }

  /**
   * The store owning one session's workspace.
   * @param sessionId - session whose workspace should be used.
   * @returns the store.
   */
  async storeFor(sessionId?: string): Promise<TripStore> {
    const cwd = await this.deps.cwdFor(sessionId).catch(() => this.deps.fallbackCwd)
    const base = cwd.trim() === '' ? this.deps.fallbackCwd : cwd
    const cached = this.stores.get(base)
    if (cached !== undefined) return cached
    const store = new TripStore(this.deps.fs, `${base}/${this.deps.subdirectory}`)
    this.stores.set(base, store)
    return store
  }

  /**
   * Every trip in one session's workspace.
   * @param sessionId - owning session.
   * @returns summaries, newest first.
   */
  async listTrips(sessionId?: string): Promise<readonly TripSummary[]> {
    return (await this.storeFor(sessionId)).list()
  }

  /**
   * Every trip with the validation numbers the sidebar switcher shows.
   *
   * Validation is pure CPU but must run per trip, so results are memoized by
   * `id@revision`: a 20 s poll re-reads documents but never re-validates an
   * unchanged one.
   *
   * @param sessionId - owning session.
   * @returns per-trip stats, in the store's newest-first order.
   */
  async statsFor(sessionId?: string): Promise<readonly TripStats[]> {
    const store = await this.storeFor(sessionId)
    const summaries = await store.list()
    const stats: TripStats[] = []
    for (const summary of summaries) {
      stats.push(await this.statFor(store, summary))
    }
    return stats
  }

  /** Read one trip's stats, validating only when the revision changed. */
  private async statFor(store: TripStore, summary: TripSummary): Promise<TripStats> {
    const key = `${summary.id}@${String(summary.revision)}`
    const cached = this.statsMemo.get(key)
    if (cached !== undefined) return { summary, readiness: cached.readiness, alerts: cached.alerts }
    const project = await store.read(summary.id)
    if (project === undefined) {
      const empty = { error: 0, warning: 0, info: 0 }
      return { summary, readiness: 0, alerts: empty }
    }
    const validation = this.validate(project)
    const alerts = countAlerts(validation.alerts)
    this.statsMemo.set(key, { readiness: validation.readiness, alerts })
    return { summary, readiness: validation.readiness, alerts }
  }

  /**
   * Decide which trip is in force.
   *
   * Order: an explicit id, then this session's own choice, then the workspace
   * default, then the most recently updated trip. The last step keeps a
   * workspace that never recorded a choice working exactly as before.
   *
   * @param sessionId - session asking.
   * @param tripId - explicit trip id.
   * @returns the selected trip id and why it won, or `undefined` when the workspace is empty.
   */
  async selectTripId(sessionId?: string, tripId?: string): Promise<TripSelection | undefined> {
    const store = await this.storeFor(sessionId)
    const explicit = tripId?.trim()
    if (explicit !== undefined && explicit !== '') return { tripId: explicit, source: 'explicit' }
    const state = await store.readState()
    const fromSession = sessionId === undefined ? undefined : state?.sessions[sessionId]
    if (fromSession !== undefined) {
      const exists = (await store.list()).some((trip) => trip.id === fromSession)
      if (exists) return { tripId: fromSession, source: 'session' }
    }
    if (state?.activeTripId !== undefined) {
      const exists = (await store.list()).some((trip) => trip.id === state.activeTripId)
      if (exists) return { tripId: state.activeTripId, source: 'workspace' }
    }
    const recent = (await store.list())[0]
    return recent === undefined ? undefined : { tripId: recent.id, source: 'recent' }
  }

  /**
   * Record a trip choice.
   * @param sessionId - session making the choice; omitted writes only the workspace default.
   * @param tripId - trip to select.
   * @param asDefault - also make it the workspace default.
   * @returns the newly selected trip id.
   * @throws {TripStoreError} when the trip does not exist.
   */
  async select(sessionId: string | undefined, tripId: string, asDefault = false): Promise<string> {
    const store = await this.storeFor(sessionId)
    const id = tripId.trim()
    if (id === '') throw new TripStoreError('TRIP_NOT_FOUND', '行程 id 不能为空。')
    const exists = (await store.list()).some((trip) => trip.id === id)
    if (!exists) throw new TripStoreError('TRIP_NOT_FOUND', `行程 ${id} 不存在。`)

    const current = await store.readState()
    const sessions = { ...current?.sessions ?? {} }
    if (sessionId !== undefined && sessionId.trim() !== '') sessions[sessionId] = id
    const next: WorkspaceState = {
      version: 1,
      sessions,
      updatedAt: new Date(this.deps.clock()).toISOString(),
      ...current?.activeTripId === undefined ? {} : { activeTripId: current.activeTripId },
    }
    const withActive = asDefault || next.activeTripId === undefined ? { ...next, activeTripId: id } : next
    await store.writeState(withActive)
    return id
  }

  /**
   * Resolve one trip, following {@link selectTripId}.
   * @param sessionId - owning session.
   * @param tripId - explicit trip id.
   * @returns the project, or `undefined` when nothing matched.
   */
  async resolve(sessionId?: string, tripId?: string): Promise<TripProject | undefined> {
    const store = await this.storeFor(sessionId)
    const selection = await this.selectTripId(sessionId, tripId)
    if (selection === undefined) return undefined
    return store.read(selection.tripId)
  }

  /**
   * Resolve a trip or fail loudly.
   * @param sessionId - owning session.
   * @param tripId - explicit trip id.
   * @returns the project.
   * @throws {TripStoreError} when the trip does not exist.
   */
  async require(sessionId?: string, tripId?: string): Promise<TripProject> {
    const project = await this.resolve(sessionId, tripId)
    if (project === undefined) {
      throw new TripStoreError('TRIP_NOT_FOUND', '当前工作区还没有旅行项目；请先调用 travel_project_create。')
    }
    return project
  }

  /**
   * Run deterministic validation.
   * @param project - trip to validate.
   * @returns alerts and readiness.
   */
  validate(project: TripProject): ValidationResult {
    return validateTrip(project, {
      now: new Date(this.deps.clock()).toISOString(),
      ...this.deps.routeStaleAfterMs === undefined ? {} : { routeStaleAfterMs: this.deps.routeStaleAfterMs },
      ...this.deps.routeStaleMode === undefined ? {} : { routeStaleMode: this.deps.routeStaleMode },
      ...this.deps.factStaleAfterMs === undefined ? {} : { factStaleAfterMs: this.deps.factStaleAfterMs },
    })
  }

  /**
   * Look one place up over the Web-service API.
   *
   * The stored POI id is tried first: it is authoritative, so a hit needs no
   * name matching. Only a place without an id — or whose id the provider has
   * forgotten — falls back to a keyword search.
   *
   * @param key - Web-service key.
   * @param place - place to look up.
   * @param city - trip destination, used to narrow the keyword search.
   * @param signal - caller cancellation.
   * @returns candidate matches, most authoritative first.
   */
  private async lookupOverRest(
    key: string,
    place: TripProject['places'][string],
    city: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<readonly RestFoundPlace[]> {
    const call = this.restCall(signal)
    const found: RestFoundPlace[] = []
    if (place.providerPlaceId !== undefined) {
      const exact = await getPoiByIdOverRest({ key, id: place.providerPlaceId }, call)
      if (exact !== undefined) {
        if (exact.photoUrl !== undefined) return [exact]
        found.push(exact)
      }
    }
    const search = await searchPoisOverRest(
      { key, keyword: place.name, ...city === undefined ? {} : { city }, pageSize: 10 },
      call,
    )
    return [...found, ...search.places]
  }

  /**
   * Whether a provider-fact lookup is direct or needs the CLI container.
   *
   * Resolved once: a Web-service key cannot appear mid-process, and the answer
   * decides whether the sidebar may look a photo up without asking first.
   *
   * @returns `direct` when the Web-service key resolved, `container` otherwise.
   */
  private async photoLookupMode(): Promise<'direct' | 'container'> {
    if (this.photoMode !== undefined) return this.photoMode
    const key = await this.deps.restKey?.()
    this.photoMode = key === undefined ? 'container' : 'direct'
    return this.photoMode
  }

  /**
   * Build the sidebar projection.
   * @param sessionId - owning session.
   * @param tripId - explicit trip id.
   * @returns the view, with `headline: null` when no trip exists.
   */
  async view(sessionId?: string, tripId?: string): Promise<TravelView> {
    const stats = await this.statsFor(sessionId)
    const map = await this.mapView()
    const selection = await this.selectTripId(sessionId, tripId)
    if (selection === undefined) {
      return {
        trips: [],
        headline: null,
        days: [],
        places: [],
        alerts: [],
        map,
        photos: this.deps.includePhotos === true,
        photoLookup: await this.photoLookupMode(),
      }
    }
    const store = await this.storeFor(sessionId)
    const project = await store.read(selection.tripId)
    if (project === undefined) {
      return {
        trips: [],
        headline: null,
        days: [],
        places: [],
        alerts: [],
        map,
        photos: this.deps.includePhotos === true,
        photoLookup: await this.photoLookupMode(),
      }
    }
    const validation = this.validate(project)
    return buildTravelView(project, validation.alerts, stats, {
      readiness: validation.readiness,
      map,
      photoLookup: await this.photoLookupMode(),
      selection,
      includePhotos: this.deps.includePhotos === true,
    })
  }

  /**
   * Describe how the client should draw the map.
   * @returns the map view; `enabled: false` when no key is available or the map is switched off.
   */
  private async mapView(): Promise<TravelView['map']> {
    const style = 'normal'
    if (this.deps.browserMapEnabled === false) return { enabled: false, version: '2.0', style }
    const key = await this.deps.browserMapKey?.().catch(() => undefined) ?? undefined
    if (key === undefined || key.trim() === '') return { enabled: false, version: '2.0', style }
    return { enabled: true, key: key.trim(), version: '2.0', style }
  }

  /**
   * Apply one patch batch and persist the result.
   * @param sessionId - owning session.
   * @param tripId - explicit trip id.
   * @param ops - validated operations.
   * @param expectedRevision - optional optimistic-concurrency guard.
   * @returns the persisted project, the patch outcome, and fresh validation.
   */
  async patch(
    sessionId: string | undefined,
    tripId: string | undefined,
    ops: readonly TripPatchOp[],
    expectedRevision?: number,
  ): Promise<PatchApplication> {
    const store = await this.storeFor(sessionId)
    const project = await this.require(sessionId, tripId)
    const outcome = applyTripPatch(project, ops, {
      now: new Date(this.deps.clock()).toISOString(),
      ...expectedRevision === undefined ? {} : { expectedRevision },
    })
    const withAlerts = attachAlerts(outcome.project, this.validate(outcome.project).alerts)
    if (outcome.changed) await store.write(withAlerts)
    return {
      project: withAlerts,
      outcome: { ...outcome, project: withAlerts },
      validation: this.validate(withAlerts),
    }
  }

  /**
   * Persist a project without changing its revision.
   * @param project - project to persist.
   * @param sessionId - session whose workspace owns the project.
   * @returns the persisted project.
   */
  async persist(project: TripProject, sessionId?: string): Promise<TripProject> {
    const store = await this.storeFor(sessionId)
    await store.write(project)
    return project
  }

  /**
   * Render and write one export file.
   * @param project - trip to export.
   * @param format - `markdown` or `json`.
   * @param sessionId - session whose workspace owns the project.
   * @returns the absolute path written.
   */
  async exportTrip(project: TripProject, format: 'markdown' | 'json', sessionId?: string): Promise<string> {
    const store = await this.storeFor(sessionId)
    const validation = this.validate(project)
    if (format === 'json') {
      return store.writeExport(project.id, 'trip.json', `${JSON.stringify(project, null, 2)}\n`)
    }
    const markdown = renderTripMarkdown(project, {
      alerts: validation.alerts,
      generatedAt: new Date(this.deps.clock()).toISOString(),
    })
    return store.writeExport(project.id, 'itinerary.md', markdown)
  }

  /**
   * Rebuild every transport leg of one day from the AMap CLI.
   *
   * One implementation serves both the `travel_day_rebuild_legs` tool and the
   * sidebar's 「重算这一天交通」 action, so the two can never drift.
   *
   * @param sessionId - session whose workspace owns the trip.
   * @param tripId - explicit trip id, or undefined for the active trip.
   * @param dayId - day to rebuild.
   * @param options - travel mode, transit city and a caller signal.
   * @returns how many legs were written and what they add up to.
   * @throws {TripStoreError} when the trip or the day does not exist.
   * @throws {AmapCliError} when the CLI path is unavailable or a query fails.
   */
  async rebuildDayLegs(
    sessionId: string | undefined,
    tripId: string | undefined,
    dayId: string,
    options: { readonly mode?: TravelMode; readonly city?: string; readonly signal?: AbortSignal } = {},
  ): Promise<LegRebuildResult> {
    const gateway = this.amap
    if (gateway === undefined) {
      throw new AmapCliError('AMAP_CLI_NOT_FOUND', '高德 CLI 未接线，无法重算交通。')
    }
    const project = await this.require(sessionId, tripId)
    const day = findDay(project, dayId)
    if (day === undefined) throw new TripStoreError('TRIP_NOT_FOUND', `第 ${dayId} 天不存在。`)

    const mode: TravelMode = options.mode ?? project.preferences.preferredModes[0] ?? 'transit'
    const skipped: string[] = []
    const legs: { readonly id: string; readonly value: Record<string, unknown> }[] = []
    let totalDistanceMeters = 0
    let totalDurationSeconds = 0

    for (let index = 0; index + 1 < day.items.length; index += 1) {
      const fromItem = day.items[index]
      const toItem = day.items[index + 1]
      if (fromItem === undefined || toItem === undefined) continue
      const fromPlace = project.places[fromItem.placeId]
      const toPlace = project.places[toItem.placeId]
      if (fromPlace === undefined || toPlace === undefined) {
        skipped.push(`${fromItem.id} → ${toItem.id}`)
        continue
      }
      const fact = await gateway.planRoute(
        {
          from: formatPoint(fromPlace.point),
          to: formatPoint(toPlace.point),
          mode,
          fromName: fromPlace.name,
          toName: toPlace.name,
          ...options.city === undefined ? {} : { city: options.city },
        },
        options.signal,
      )
      totalDistanceMeters += fact.distanceMeters
      totalDurationSeconds += fact.durationSeconds
      const id = `${day.id}-leg-${String(index + 1)}`
      legs.push({
        id,
        value: {
          id,
          fromItemId: fromItem.id,
          toItemId: toItem.id,
          mode: fact.mode,
          distanceMeters: fact.distanceMeters,
          durationSeconds: fact.durationSeconds,
          ...fact.tollsYuan === undefined ? {} : { tollsYuan: fact.tollsYuan },
          steps: fact.steps.map((step: RouteStep) => ({
            instruction: step.instruction,
            distanceMeters: step.distanceMeters,
            durationSeconds: step.durationSeconds,
          })),
          freshness: 'fresh',
          fetchedAt: fact.fetchedAt,
        },
      })
    }

    if (legs.length > 0) {
      await this.patch(
        sessionId,
        project.id,
        legs.map((leg) => ({ kind: 'set-leg' as const, dayId: day.id, leg: leg.value as never })),
      )
    }
    return { dayId: day.id, legs: legs.length, totalDistanceMeters, totalDurationSeconds, skipped }
  }

  /**
   * Record how one day changes city.
   *
   * A driving trip has days that are nothing but road, and before transits
   * existed the only way to put one on a day was to invent a stop for it. This
   * writes the move itself: the ends may be library places (which give the map
   * coordinates) or plain names, and the figures come from a planned route when
   * one can be had, otherwise from what the caller already knows. A name-only
   * end is geocoded first when the deployment has a Web-service key, so 「成都」
   * can be drawn on the map without inventing a stop for it.
   *
   * One implementation serves the `travel_day_set_transit` tool, the panel's
   * 「记为转场」 action and the migration path, so they cannot drift.
   *
   * @param sessionId - session whose workspace owns the trip.
   * @param tripId - explicit trip id, or undefined for the active trip.
   * @param dayId - day the move belongs to.
   * @param input - the two ends, the mode, and whatever figures the caller has.
   * @returns what was written and where the figures came from.
   * @throws {TripStoreError} when the trip or the day does not exist.
   * @throws {AmapCliError} when planning was asked for and no provider answered.
   */
  async setDayTransit(
    sessionId: string | undefined,
    tripId: string | undefined,
    dayId: string,
    input: TransitWriteInput,
  ): Promise<TransitWriteResult> {
    const project = await this.require(sessionId, tripId)
    const day = findDay(project, dayId)
    if (day === undefined) throw new TripStoreError('TRIP_NOT_FOUND', `第 ${dayId} 天不存在。`)

    const from = await this.resolveTransitEnd(project, input.from, '起点', input.signal)
    const to = await this.resolveTransitEnd(project, input.to, '终点', input.signal)
    const mode: TravelMode = input.mode ?? project.preferences.preferredModes[0] ?? 'driving'
    const id = input.id ?? nextTransitId(day)
    const fetchedAt = new Date().toISOString()

    let distanceMeters = input.distanceMeters
    let durationSeconds = input.durationSeconds
    let tollsYuan: number | undefined
    let polyline: string | undefined
    let steps: readonly RouteStep[] = []
    let planned = false
    let source: TripTransit['source'] = { provider: 'title', fetchedAt }

    if (input.plan !== false) {
      // A write asked for by the tool or the panel may fall back to the CLI,
      // which answers on a running container; a batch pass passes `false` here
      // so it can never open the AMap window.
      const move = await this.planMove(from, to, mode, {
        ...input.signal === undefined ? {} : { signal: input.signal },
        allowStart: true,
      })
      if (move !== undefined) {
        distanceMeters = move.distanceMeters ?? distanceMeters
        durationSeconds = move.durationSeconds ?? durationSeconds
        tollsYuan = move.tollsYuan
        polyline = move.polyline
        steps = move.steps
        planned = true
        source = { provider: 'amap-cli', fetchedAt: move.fetchedAt }
      }
    }

    const departAt = input.departAt ?? day.items[0]?.startAt
    const arriveAt =
      input.arriveAt ??
      (departAt === undefined || durationSeconds === undefined
        ? undefined
        : addDuration(departAt, durationSeconds))

    const transit: TripTransit = {
      id,
      from,
      to,
      mode,
      ...distanceMeters === undefined ? {} : { distanceMeters },
      ...durationSeconds === undefined ? {} : { durationSeconds },
      ...departAt === undefined ? {} : { departAt },
      ...arriveAt === undefined ? {} : { arriveAt },
      ...tollsYuan === undefined ? {} : { tollsYuan },
      steps,
      // Figures nobody re-checked stay usable but marked: the panel shows them
      // as 「按标题估算」 until a rebuild makes them real.
      freshness: planned ? 'fresh' : 'stale',
      source,
      ...polyline === undefined ? {} : { polyline },
    }

    await this.patch(sessionId, project.id, [{ kind: 'set-day-transit', dayId: day.id, transit }])
    return {
      dayId: day.id,
      transitId: transit.id,
      ...distanceMeters === undefined ? {} : { distanceMeters },
      ...durationSeconds === undefined ? {} : { durationSeconds },
      planned,
      polyline: polyline !== undefined,
    }
  }

  /**
   * Resolve one end of a transit, and give a name-only end a coordinate.
   *
   * A place id is authoritative: the library already knows the name and the
   * point. An end that is only a name is geocoded once when a Web-service key is
   * configured, because that coordinate is what lets the map draw the road. A
   * lookup that fails leaves the end exactly as it was — a name the provider does
   * not know must not turn a writable transit into an error, and this path never
   * touches the CLI, so it can never open the AMap window.
   *
   * @param project - trip project owning the library.
   * @param end - caller's end: a place id, a label, a point, or a combination.
   * @param role - 起点/终点, for the error message.
   * @param signal - caller cancellation.
   * @returns the stored end, with a coordinate when one could be had.
   * @throws {TripStoreError} when the end names nothing at all.
   */
  private async resolveTransitEnd(
    project: TripProject,
    end: TransitEndInput,
    role: string,
    signal: AbortSignal | undefined,
  ): Promise<ResolvedTransitEnd> {
    const place = end.placeId === undefined ? undefined : project.places[end.placeId]
    if (place !== undefined) return { placeId: place.id, label: place.name, point: place.point }
    const label = end.label?.trim() ?? ''
    if (label === '') {
      throw new TripStoreError('TRIP_INVALID_DOCUMENT', `转场${role}需要一个地点或一个名称。`)
    }
    if (end.point !== undefined) return { label, point: end.point }
    const point = await this.geocodeLabel(label, signal)
    return point === undefined ? { label } : { label, point }
  }

  /**
   * Turn a bare place name into a coordinate over the Web-service API.
   *
   * @param label - the name as written, e.g. 「西安」.
   * @param signal - caller cancellation.
   * @returns the coordinate, or undefined when there is no key, the provider has
   *   no such name, or the lookup failed.
   */
  private async geocodeLabel(label: string, signal: AbortSignal | undefined): Promise<GeoPoint | undefined> {
    const cached = this.geocodes.get(label)
    if (cached !== undefined) return cached === 'none' ? undefined : cached
    try {
      // Resolving the credential is part of this best-effort lookup, not of the
      // write it decorates: a credentials service that refuses must leave the
      // end a name rather than fail the transit that carries it.
      const key = await this.restKeyOrUndefined()
      if (key === undefined || key.trim() === '') return undefined
      const found = await geocodeAddressOverRest({ key, address: label }, this.restCall(signal))
      if (found === undefined) {
        this.geocodes.set(label, 'none')
        return undefined
      }
      const point: GeoPoint = { longitude: found.longitude, latitude: found.latitude, coordinateSystem: 'gcj02' }
      this.geocodes.set(label, point)
      return point
    } catch {
      // A geocode only makes the map richer. Swallowing the failure keeps the
      // name the user wrote and lets the write go through.
      return undefined
    }
  }

  /**
   * Resolve the Web-service key, treating a refusing credential provider as
   * "no key".
   *
   * Every caller below uses the key to make an answer better, never to decide
   * whether a write happens, so a credentials failure belongs in the same bucket
   * as a missing key rather than in an exception that fails the whole operation.
   *
   * @returns the key, or undefined when none can be resolved.
   */
  private async restKeyOrUndefined(): Promise<string | undefined> {
    try {
      return await this.deps.restKey?.()
    } catch {
      return undefined
    }
  }

  /** Options for one Web-service call: the caller signal plus the test seam. */
  private restCall(signal?: AbortSignal): RestCallOptions {
    return {
      ...signal === undefined ? {} : { signal },
      ...this.deps.restFetch === undefined ? {} : { fetchImpl: this.deps.restFetch },
    }
  }

  /**
   * Ask a provider for the road between two located ends.
   *
   * The Web-service API answers first for a driving move, because its answer
   * carries the provider's own path; the CLI is the fallback for a deployment
   * without that key. Whether the CLI may start a cold container is the caller's
   * decision, which is how a batch pass stays window-free.
   *
   * @param from - located start.
   * @param to - located end.
   * @param mode - travel mode the trip prefers.
   * @param options - cancellation, whether a cold container may be started, and
   *   whether a Web-service failure may fall back to the CLI.
   * @returns the provider's figures, or undefined when no provider could be asked
   *   at all (an end without a coordinate, or neither key nor CLI).
   * @throws {Error} when a provider was asked and failed.
   */
  private async planMove(
    from: ResolvedTransitEnd,
    to: ResolvedTransitEnd,
    mode: TravelMode,
    options: { readonly signal?: AbortSignal | undefined; readonly allowStart: boolean; readonly fallBackToCli?: boolean },
  ): Promise<PlannedMove | undefined> {
    if (from.point === undefined || to.point === undefined) return undefined
    const origin = formatPoint(from.point)
    const destination = formatPoint(to.point)
    const key = await this.restKeyOrUndefined()
    let restError: unknown
    if (key !== undefined && key.trim() !== '' && mode === 'driving') {
      try {
        const route = await drivingRouteOverRest({ key, origin, destination }, this.restCall(options.signal))
        return {
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          ...route.tollsYuan === undefined ? {} : { tollsYuan: route.tollsYuan },
          ...route.polyline === '' ? {} : { polyline: route.polyline },
          // The Web-service answer carries geometry instead of turn text, and the
          // panel draws the path rather than reading the steps aloud.
          steps: [],
          fetchedAt: new Date().toISOString(),
        }
      } catch (error) {
        if (options.fallBackToCli !== true) throw error
        restError = error
      }
    }
    const gateway = this.amap
    if (gateway !== undefined) {
      try {
        const fact = await gateway.planRoute(
          { from: origin, to: destination, mode, fromName: from.label, toName: to.label },
          options.signal,
          { allowStart: options.allowStart },
        )
        return {
          distanceMeters: fact.distanceMeters,
          durationSeconds: fact.durationSeconds,
          ...fact.tollsYuan === undefined ? {} : { tollsYuan: fact.tollsYuan },
          steps: fact.steps.map((step) => ({
            instruction: step.instruction,
            distanceMeters: step.distanceMeters,
            durationSeconds: step.durationSeconds,
          })),
          fetchedAt: fact.fetchedAt,
        }
      } catch (error) {
        // Both providers were asked; the reason should carry both answers,
        // because the key path is the one the reader can actually fix.
        if (restError !== undefined) {
          throw new Error(`${messageOf(restError)}（高德 CLI 也没能规划：${messageOf(error)}）`)
        }
        throw error
      }
    }
    if (restError !== undefined) throw restError
    return undefined
  }

  /**
   * Plan every transit a day title claims and no record accounts for.
   *
   * The panel's 「补全 N 天路线」 button calls this: a driving trip carries days
   * whose only record of the road is the title, and planning them one at a time
   * is ten operations. Nothing here starts the AMap container — a batch pass must
   * never open a desktop window — and a day that cannot be planned is reported
   * with its reason instead of failing the whole batch.
   *
   * @param sessionId - session whose workspace owns the trip.
   * @param tripId - explicit trip id, or undefined for the active trip.
   * @param dayId - one day to fill; every missing day when omitted.
   * @returns how many days were written, how many were left alone, and why.
   * @throws {TripStoreError} when the trip, or the requested day, does not exist.
   */
  async fillTransits(
    sessionId: string | undefined,
    tripId: string | undefined,
    dayId?: string,
  ): Promise<TransitFillResult> {
    const project = await this.require(sessionId, tripId)
    const scenario = project.scenarios.find((entry) => entry.id === project.activeScenarioId)
    const days = scenario?.days ?? []
    if (dayId !== undefined && !days.some((day) => day.id === dayId)) {
      throw new TripStoreError('TRIP_NOT_FOUND', `第 ${dayId} 天不存在。`)
    }
    const targets = days.filter((day) => isTransitFillDay(day) && (dayId === undefined || day.id === dayId))
    if (dayId !== undefined && targets.length === 0) {
      // One day was named and it does not need filling: say that, rather than
      // answering an explicit question with an empty batch.
      return {
        planned: 0,
        skipped: 1,
        days: [{ dayId, planned: false, polyline: false, reason: '这一天已经记录了转场或里程，无需补全' }],
      }
    }
    const results: TransitFillDayResult[] = []
    let planned = 0
    for (const day of targets) {
      const outcome = await this.fillDayTransit(sessionId, project, day)
      if (outcome.planned) planned += 1
      results.push(outcome)
    }
    return { planned, skipped: results.length - planned, days: results }
  }

  /**
   * Plan and write the one transit one day is missing.
   *
   * @param sessionId - session whose workspace owns the trip.
   * @param project - trip the day belongs to.
   * @param day - day whose title claims an unrecorded hop.
   * @returns what happened, with a reason when nothing could be planned.
   */
  private async fillDayTransit(
    sessionId: string | undefined,
    project: TripProject,
    day: TripDay,
  ): Promise<TransitFillDayResult> {
    const claimed = parseTransferTitle(day.title)
    if (claimed.from === undefined || claimed.to === undefined || claimed.from === claimed.to) {
      return { dayId: day.id, planned: false, polyline: false, reason: '标题里没有解析出两个不同的起终点名称' }
    }
    const restKey = await this.restKeyOrUndefined()
    const hasKey = restKey !== undefined && restKey.trim() !== ''
    if (!hasKey && this.amap === undefined) {
      return { dayId: day.id, planned: false, polyline: false, reason: NO_PROVIDER_REASON }
    }
    const from = await this.titleEnd(project, claimed.from)
    const to = await this.titleEnd(project, claimed.to)
    if (from.point === undefined || to.point === undefined) {
      const missing = [from, to].filter((end) => end.point === undefined).map((end) => end.label)
      return {
        dayId: day.id,
        planned: false,
        polyline: false,
        reason: hasKey
          ? `地理编码没有找到「${missing.join('」「')}」的坐标`
          : `端点只有名称，且没有可用的高德 Web 服务 Key（${missing.join('、')}）`,
      }
    }
    const mode: TravelMode = project.preferences.preferredModes[0] ?? 'driving'
    let move: PlannedMove | undefined
    try {
      move = await this.planMove(from, to, mode, { allowStart: false, fallBackToCli: true })
    } catch (error) {
      return { dayId: day.id, planned: false, polyline: false, reason: messageOf(error) }
    }
    if (move === undefined) {
      return { dayId: day.id, planned: false, polyline: false, reason: NO_PROVIDER_REASON }
    }
    // No clock is invented: a title states none, and the day's first stop is
    // usually the arrival, not the departure.
    const transit: TripTransit = {
      id: nextTransitId(day),
      from,
      to,
      mode,
      ...move.distanceMeters === undefined ? {} : { distanceMeters: move.distanceMeters },
      ...move.durationSeconds === undefined ? {} : { durationSeconds: move.durationSeconds },
      ...move.tollsYuan === undefined ? {} : { tollsYuan: move.tollsYuan },
      steps: move.steps,
      freshness: 'fresh',
      source: { provider: 'amap-cli', fetchedAt: move.fetchedAt },
      ...move.polyline === undefined ? {} : { polyline: move.polyline },
    }
    const application = await this.patch(sessionId, project.id, [{ kind: 'set-day-transit', dayId: day.id, transit }])
    // `changed` is what says the document holds the transit now; a rejected op
    // leaves the project untouched, and reporting it as planned would show the
    // panel a route that no reader can find in the store.
    if (!application.outcome.changed) {
      const rejection = application.outcome.rejected[0]
      return {
        dayId: day.id,
        planned: false,
        polyline: false,
        reason:
          rejection === undefined
            ? '补全结果被校验拒绝'
            : `补全结果被校验拒绝：${rejection.reason}`,
      }
    }
    return {
      dayId: day.id,
      planned: true,
      ...move.distanceMeters === undefined ? {} : { distanceMeters: move.distanceMeters },
      ...move.durationSeconds === undefined ? {} : { durationSeconds: move.durationSeconds },
      polyline: move.polyline !== undefined,
    }
  }

  /**
   * Turn one name from a day title into an end.
   *
   * A library place with exactly that name is the best answer — it already
   * carries a coordinate and a photo. Otherwise the name is geocoded, which is
   * what makes a day of nothing but 「西安 → 成都」 drawable.
   *
   * @param project - trip project owning the library.
   * @param label - the name as the title writes it.
   * @returns the end, located when either step could locate it.
   */
  private async titleEnd(project: TripProject, label: string): Promise<ResolvedTransitEnd> {
    const place = Object.values(project.places).find((entry) => entry.name === label)
    if (place !== undefined) return { placeId: place.id, label: place.name, point: place.point }
    const point = await this.geocodeLabel(label, undefined)
    return point === undefined ? { label } : { label, point }
  }

  /**
   * Fill in provider facts that older documents never captured.
   *
   * Places imported before photos were stored have no photo, so they are
   * re-looked-up by name in the trip's city and matched back on their stored
   * POI id. A place that never recorded an id is accepted only from an exactly
   * equal name that also carries a photo — a looser match is how a wrong photo
   * ends up on the wrong stop.
   *
   * @param sessionId - session whose workspace owns the trip.
   * @param tripId - explicit trip id, or undefined for the active trip.
   * @param options - optional single `placeId`, the caller signal, and whether a
   *   cold container may be started. Scoping to one place is what a detail card
   *   wants: one lookup, not a library sweep.
   * @returns how many places were checked and how many gained facts.
   * @throws {TripStoreError} when no trip exists.
   * @throws {AmapCliError} when the CLI path is unavailable, or when the
   *   container is down and `allowStart` was not granted.
   */
  async refreshPlaceFacts(
    sessionId: string | undefined,
    tripId: string | undefined,
    options: {
      readonly placeId?: string
      readonly signal?: AbortSignal
      /** Whether a cold container may be started; photos default to no. */
      readonly allowStart?: boolean
    } = {},
  ): Promise<PlaceFactRefresh> {
    const gateway = this.amap
    if (gateway === undefined) {
      throw new AmapCliError('AMAP_CLI_NOT_FOUND', '高德 CLI 未接线，无法补全地点信息。')
    }
    const project = await this.require(sessionId, tripId)
    const city = project.destinations[0]
    const candidates = Object.values(project.places).filter(
      (place) => place.photoUrl === undefined && (options.placeId === undefined || place.id === options.placeId),
    )

    const restKey = await this.deps.restKey?.()
    const ops: TripPatchOp[] = []
    const unmatched: string[] = []
    for (const place of candidates) {
      // The Web-service API answers over HTTPS and needs no container at all;
      // the CLI is the fallback for a deployment without that key.
      const found =
        restKey === undefined
          ? await gateway
              .searchPlaces(
                {
                  keyword: place.name,
                  ...city === undefined ? {} : { city },
                  pageSize: 10,
                },
                options.signal,
                // A photo is a nicety: it must not open the AMap desktop window
                // by itself. Only a caller that says so may start a container.
                { allowStart: options.allowStart === true },
              )
              .then((outcome) => outcome.places)
          : await this.lookupOverRest(restKey, place, city, options.signal)
      const match =
        found.find((entry) => entry.providerPlaceId !== undefined && entry.providerPlaceId === place.providerPlaceId) ??
        found.find((entry) => entry.name === place.name && entry.photoUrl !== undefined)
      if (match?.photoUrl === undefined) {
        unmatched.push(place.id)
        continue
      }
      ops.push({
        kind: 'set-place-facts',
        placeId: place.id,
        photoUrl: match.photoUrl,
        ...match.telephone === undefined || place.telephone !== undefined ? {} : { telephone: match.telephone },
      })
    }

    const source: PlaceFactSource = restKey === undefined ? 'amap-cli' : 'web-service'
    if (ops.length === 0) return { checked: candidates.length, updated: 0, unmatched, source }
    const applied = await this.patch(sessionId, project.id, ops)
    return { checked: candidates.length, updated: applied.outcome.applied.length, unmatched, source }
  }

  /**
   * Persist freshly computed alerts onto a project document.
   * @param project - project to update.
   * @param alerts - alerts to store.
   * @param sessionId - session whose workspace owns the project.
   * @returns the stored project.
   */
  async storeAlerts(project: TripProject, alerts: readonly TripAlert[], sessionId?: string): Promise<TripProject> {
    const updated = attachAlerts(project, alerts)
    await (await this.storeFor(sessionId)).write(updated)
    return updated
  }

  /**
   * Summary of every trip, for tool output.
   * @param sessionId - owning session.
   * @returns trip summaries.
   */
  async summaries(sessionId?: string): Promise<readonly TripSummary[]> {
    return (await this.storeFor(sessionId)).list()
  }

  /**
   * Summary of one trip.
   * @param project - trip to summarize.
   * @returns the summary.
   */
  summaryOf(project: TripProject): TripSummary {
    return summarize(project)
  }
}

/**
 * Replace the stored alert list without touching the revision.
 * @param project - source project.
 * @param alerts - alerts to store.
 * @returns a new project value.
 */
export function attachAlerts(project: TripProject, alerts: readonly TripAlert[]): TripProject {
  return { ...project, alerts }
}

/**
 * Readable message for a thrown value.
 *
 * A batch pass reports a failure as a reason rather than an exception, and the
 * reason has to survive `unknown`.
 *
 * @param error - value caught from a provider call.
 * @returns the error's message, or its string form when it is not an Error.
 */
function messageOf(error: unknown): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : String(error)
}

/**
 * Find one day of the active scenario.
 *
 * @param project - trip to search.
 * @param dayId - day id to resolve.
 * @returns the day, or undefined when the active scenario has no such id.
 */
function findDay(project: TripProject, dayId: string): TripDay | undefined {
  const scenario = project.scenarios.find((entry) => entry.id === project.activeScenarioId)
  return scenario?.days.find((entry) => entry.id === dayId)
}
