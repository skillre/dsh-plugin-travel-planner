import type { TripProject } from '../domain/trip.js'

/** Opaque filesystem target; the adapter owns the concrete DSH type. */
export type TripFsTarget = object

/**
 * Minimal filesystem slice the trip store needs.
 *
 * Kept structural so the store can be tested with a fake and so the DSH
 * filesystem service is adapted in exactly one place.
 */
export interface TripFs {
  /** Resolve an absolute path (or a path relative to `cwd`) to a target. */
  resolve(path: string, cwd?: string): Promise<TripFsTarget>
  /** Read a UTF-8 text file; rejects when the file is missing. */
  readText(target: TripFsTarget): Promise<string>
  /** Create or overwrite a UTF-8 text file, creating parent directories. */
  writeText(target: TripFsTarget, content: string): Promise<unknown>
  /** List one directory's entry names; rejects when it is missing. */
  listDir(target: TripFsTarget): Promise<readonly string[]>
  /** Whether a path exists. */
  exists(target: TripFsTarget): Promise<boolean>
}

/** One trip available in the store, without its full body. */
export interface TripSummary {
  readonly id: string
  readonly title: string
  readonly status: TripProject['status']
  readonly startDate: string
  readonly endDate: string
  readonly durationDays: number
  readonly revision: number
  readonly updatedAt: string
  readonly activeScenarioId: string
  readonly destinations: readonly string[]
}

/**
 * The workspace's cross-session trip selection.
 *
 * One workspace holds many trips, so "which trip am I working on" is explicit
 * state rather than a guess: `activeTripId` is the workspace default and
 * `sessions` overrides it per session, so two sessions in one directory can
 * plan different trips without fighting over a single pointer.
 */
export interface WorkspaceState {
  /** Schema version of the state document itself. */
  readonly version: 1
  /** Workspace default trip, when one is chosen. */
  readonly activeTripId?: string
  /** Per-session overrides keyed by session id. */
  readonly sessions: Readonly<Record<string, string>>
  /** ISO-8601 timestamp of the last write. */
  readonly updatedAt: string
}

/** Raised when a persisted document cannot be understood. */
export class TripStoreError extends Error {
  /** Machine-readable failure code. */
  readonly code: 'TRIP_NOT_FOUND' | 'TRIP_INVALID_DOCUMENT' | 'TRIP_SCHEMA_UNSUPPORTED'

  constructor(code: TripStoreError['code'], message: string) {
    super(message)
    this.name = 'TripStoreError'
    this.code = code
  }
}

/**
 * Versions this build reads.
 *
 * 2 added `TripDay.transits`; a version-1 file loads unchanged and is only
 * rewritten at the new version when something writes to it.
 */
const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2]

/**
 * Filesystem-backed Trip Project store.
 *
 * Layout: `<directory>/projects/<tripId>/trip.json`, so a trip stays readable
 * and portable without the plugin, and a reviewer can diff it in Git.
 */
export class TripStore {
  private readonly fs: TripFs
  private readonly directory: string

  /**
   * @param fs - filesystem adapter.
   * @param directory - absolute directory holding the store.
   */
  constructor(fs: TripFs, directory: string) {
    this.fs = fs
    this.directory = directory
  }

  /** Absolute directory holding every project of this store. */
  get root(): string {
    return this.directory
  }

  /**
   * Absolute path of one trip document.
   * @param tripId - trip identifier.
   * @returns the document path.
   */
  pathFor(tripId: string): string {
    return `${this.directory}/projects/${tripId}/trip.json`
  }

  /** Absolute directory holding one trip's exports. */
  exportDirFor(tripId: string): string {
    return `${this.directory}/projects/${tripId}/exports`
  }

  /**
   * List every readable trip, newest first.
   * @returns summaries; unreadable documents are skipped.
   */
  async list(): Promise<readonly TripSummary[]> {
    const projectsTarget = await this.fs.resolve(`${this.directory}/projects`)
    if (!(await this.fs.exists(projectsTarget))) return []
    let entries: readonly string[]
    try {
      entries = await this.fs.listDir(projectsTarget)
    } catch {
      return []
    }
    const summaries: TripSummary[] = []
    for (const entry of entries) {
      // One damaged document must not hide every healthy trip; `read()` still
      // throws loudly for an explicit single-trip request.
      const project = await this.read(entry).catch(() => undefined)
      if (project !== undefined) summaries.push(summarize(project))
    }
    summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return summaries
  }

  /**
   * Read one trip.
   * @param tripId - trip identifier.
   * @returns the project, or `undefined` when it does not exist.
   * @throws {TripStoreError} when the document exists but cannot be parsed.
   */
  async read(tripId: string): Promise<TripProject | undefined> {
    const target = await this.fs.resolve(this.pathFor(tripId))
    if (!(await this.fs.exists(target))) return undefined
    const text = await this.fs.readText(target)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new TripStoreError('TRIP_INVALID_DOCUMENT', `trip "${tripId}" is not valid JSON: ${describe(error)}`)
    }
    return assertTripProject(parsed, tripId)
  }

  /**
   * Write one trip document.
   * @param project - project to persist.
   * @param expectedRevision - when given, the stored revision must equal it.
   * @returns the persisted project.
   * @throws {TripStoreError} when the stored revision differs.
   */
  async write(project: TripProject, expectedRevision?: number): Promise<TripProject> {
    if (expectedRevision !== undefined) {
      const current = await this.read(project.id)
      if (current !== undefined && current.revision !== expectedRevision) {
        throw new TripStoreError(
          'TRIP_INVALID_DOCUMENT',
          `trip "${project.id}" is at revision ${current.revision}, expected ${expectedRevision}`,
        )
      }
    }
    const target = await this.fs.resolve(this.pathFor(project.id))
    await this.fs.writeText(target, `${JSON.stringify(project, null, 2)}\n`)
    return project
  }

  /**
   * Write a text file beside a trip, under its `exports/` directory.
   * @param tripId - trip identifier.
   * @param fileName - file name inside `exports/`.
   * @param content - file body.
   * @returns the absolute path written.
   */
  async writeExport(tripId: string, fileName: string, content: string): Promise<string> {
    const path = `${this.exportDirFor(tripId)}/${fileName}`
    const target = await this.fs.resolve(path)
    await this.fs.writeText(target, content)
    return path
  }

  /** Absolute path of the workspace state document. */
  get statePath(): string {
    return `${this.directory}/state.json`
  }

  /**
   * Read the workspace's trip selection.
   *
   * A missing, unreadable or malformed document is not an error: it means no
   * choice was ever recorded, and callers fall back to the most recently
   * updated trip. The next write replaces it.
   *
   * @returns the state, or `undefined` when nothing usable is stored.
   */
  async readState(): Promise<WorkspaceState | undefined> {
    const target = await this.fs.resolve(this.statePath)
    if (!(await this.fs.exists(target))) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(await this.fs.readText(target))
    } catch {
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (record['version'] !== 1) return undefined
    const sessions: Record<string, string> = {}
    const rawSessions = record['sessions']
    if (typeof rawSessions === 'object' && rawSessions !== null && !Array.isArray(rawSessions)) {
      for (const [key, value] of Object.entries(rawSessions as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim() !== '') sessions[key] = value.trim()
      }
    }
    const activeTripId = readNonEmpty(record['activeTripId'])
    const updatedAt = readNonEmpty(record['updatedAt']) ?? new Date(0).toISOString()
    return {
      version: 1,
      sessions,
      updatedAt,
      ...activeTripId === undefined ? {} : { activeTripId },
    }
  }

  /**
   * Replace the workspace's trip selection.
   * @param state - state to persist.
   * @returns the persisted state.
   */
  async writeState(state: WorkspaceState): Promise<WorkspaceState> {
    const target = await this.fs.resolve(this.statePath)
    await this.fs.writeText(target, `${JSON.stringify(state, null, 2)}\n`)
    return state
  }
}

/**
 * Read a required non-empty trimmed string.
 * @param value - candidate value.
 * @returns the trimmed string, or undefined when absent or blank.
 */
function readNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Project one trip into its summary form.
 * @param project - full project.
 * @returns the summary.
 */
export function summarize(project: TripProject): TripSummary {
  const active = project.scenarios.find((scenario) => scenario.id === project.activeScenarioId)
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    startDate: project.startDate,
    endDate: project.endDate,
    durationDays: active?.days.length ?? 0,
    revision: project.revision,
    updatedAt: project.updatedAt,
    activeScenarioId: project.activeScenarioId,
    destinations: project.destinations,
  }
}

/**
 * Validate the parts of a persisted document the rest of the plugin relies on.
 * @param value - parsed JSON value.
 * @param tripId - expected trip id, used in the error message.
 * @returns the project typed as a `TripProject`.
 * @throws {TripStoreError} when required fields are missing or the version is unsupported.
 */
export function assertTripProject(value: unknown, tripId: string): TripProject {
  if (typeof value !== 'object' || value === null) {
    throw new TripStoreError('TRIP_INVALID_DOCUMENT', `trip "${tripId}" is not a JSON object`)
  }
  const record = value as Record<string, unknown>
  const schemaVersion = record['schemaVersion']
  if (typeof schemaVersion !== 'number' || !SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
    throw new TripStoreError(
      'TRIP_SCHEMA_UNSUPPORTED',
      `trip "${tripId}" uses schema version ${String(schemaVersion)}; this plugin supports ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
    )
  }
  for (const field of ['id', 'title', 'startDate', 'endDate', 'activeScenarioId', 'updatedAt'] as const) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim() === '') {
      throw new TripStoreError('TRIP_INVALID_DOCUMENT', `trip "${tripId}" is missing string field "${field}"`)
    }
  }
  if (typeof record['revision'] !== 'number' || !Number.isInteger(record['revision'])) {
    throw new TripStoreError('TRIP_INVALID_DOCUMENT', `trip "${tripId}" is missing integer field "revision"`)
  }
  if (!Array.isArray(record['scenarios'])) {
    throw new TripStoreError('TRIP_INVALID_DOCUMENT', `trip "${tripId}" is missing array field "scenarios"`)
  }
  return value as TripProject
}

/** Describe an unknown thrown value for an error message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
