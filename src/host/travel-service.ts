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
import type { RestFoundPlace } from './amap/rest.js'
import { drivingRouteOverRest, getPoiByIdOverRest, searchPoisOverRest } from './amap/rest.js'

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
    const call = { ...signal === undefined ? {} : { signal } }
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
   * one can be had, otherwise from what the caller already knows.
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

    const from = this.resolveTransitEnd(project, input.from, '起点')
    const to = this.resolveTransitEnd(project, input.to, '终点')
    const mode: TravelMode = input.mode ?? project.preferences.preferredModes[0] ?? 'driving'
    const id = input.id ?? `${day.id}-transit-${String((day.transits ?? []).length + 1)}`
    const fetchedAt = new Date().toISOString()

    let distanceMeters = input.distanceMeters
    let durationSeconds = input.durationSeconds
    let tollsYuan: number | undefined
    let polyline: string | undefined
    let steps: readonly RouteStep[] = []
    let planned = false
    let source: TripTransit['source'] = { provider: 'title', fetchedAt }

    const bothLocated = from.point !== undefined && to.point !== undefined
    if (input.plan !== false && bothLocated && mode === 'driving') {
      const restKey = await this.deps.restKey?.()
      if (restKey !== undefined) {
        // The Web-service answer carries the provider's own path; the CLI's
        // carries turn-by-turn text but no geometry.
        const route = await drivingRouteOverRest(
          { key: restKey, origin: formatPoint(from.point as never), destination: formatPoint(to.point as never) },
          { ...input.signal === undefined ? {} : { signal: input.signal } },
        )
        distanceMeters = route.distanceMeters
        durationSeconds = route.durationSeconds
        tollsYuan = route.tollsYuan
        polyline = route.polyline === '' ? undefined : route.polyline
        planned = true
        source = { provider: 'amap-cli', fetchedAt }
      }
    }
    if (!planned && input.plan !== false && bothLocated && this.amap !== undefined) {
      const fact = await this.amap.planRoute(
        {
          from: formatPoint(from.point as never),
          to: formatPoint(to.point as never),
          mode,
          fromName: from.label,
          toName: to.label,
        },
        input.signal,
      )
      distanceMeters = fact.distanceMeters
      durationSeconds = fact.durationSeconds
      tollsYuan = fact.tollsYuan
      steps = fact.steps.map((step) => ({
        instruction: step.instruction,
        distanceMeters: step.distanceMeters,
        durationSeconds: step.durationSeconds,
      }))
      planned = true
      source = { provider: 'amap-cli', fetchedAt: fact.fetchedAt }
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
   * Resolve one end of a transit against the place library.
   *
   * @param project - trip project owning the library.
   * @param end - caller's end: a place id, a label, or both.
   * @param role - 起点/终点, for the error message.
   * @returns the stored end, with the place's name and coordinate when it has one.
   * @throws {TripStoreError} when the end names nothing at all.
   */
  private resolveTransitEnd(
    project: TripProject,
    end: TransitEndInput,
    role: string,
  ): { readonly placeId?: string; readonly label: string; readonly point?: GeoPoint } {
    const place = end.placeId === undefined ? undefined : project.places[end.placeId]
    if (place !== undefined) return { placeId: place.id, label: place.name, point: place.point }
    const label = end.label?.trim() ?? ''
    if (label === '') {
      throw new TripStoreError('TRIP_INVALID_DOCUMENT', `转场${role}需要一个地点或一个名称。`)
    }
    return { label }
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
