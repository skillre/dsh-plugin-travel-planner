/**
 * Host-layer coverage for the travel planner.
 *
 * Everything here runs in-process against fakes: no network, no child process,
 * and no clock read outside an injected `clock`. The fake `TripFs` is a plain
 * `Map<string, string>` keyed by absolute path, so every store assertion is a
 * direct check of what the plugin would have written to disk.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { CURRENT_TRIP_SCHEMA_VERSION } from '../src/domain/trip.js'
import type {
  BudgetSummary,
  ItineraryItem,
  RouteFreshness,
  RouteLeg,
  SourceStamp,
  TravelMode,
  TravelPreferences,
  TravelerProfile,
  TripAlert,
  TripDay,
  TripPlace,
  TripProject,
  TripScenario,
  TripStatus,
  TripTransit,
} from '../src/domain/trip.js'
import type { AmapErrorCode } from '../src/host/amap/cli.js'
import { AmapCliError } from '../src/host/amap/cli.js'
import { createSubprocessExec } from '../src/host/amap/exec.js'
import type { ExecRequest, SubprocessLike } from '../src/host/amap/exec.js'
import type { AmapGateway } from '../src/host/amap/gateway.js'
import { CONFIG_LIMITS, normalizeConfig, normalizeHttpPath } from '../src/host/config.js'
import type { AmapConfig, Config } from '../src/host/config.js'
import { registerTravelHttp } from '../src/host/http.js'
import type { WebServerLike } from '../src/host/http.js'
import { addDays, itemIdFor, slugify, tripIdFor } from '../src/host/ids.js'
import { parsePatchOps } from '../src/host/patch-input.js'
import { summarize, TripStore, TripStoreError } from '../src/host/trip-store.js'
import type { TripFs, TripFsTarget, TripSummary } from '../src/host/trip-store.js'
import { TravelService } from '../src/host/travel-service.js'
import { registerTravelTools } from '../src/host/tools.js'
import { amapRuntimeView, buildTravelView, countAlerts, severityLabel } from '../src/host/view.js'
import type { AmapRuntimeView, TravelView } from '../src/shared/view.js'

/** Fixed evaluation timestamp used by every test. */
const NOW = '2026-09-15T07:00:00+08:00'
/** The same instant as epoch milliseconds, for the injected clock. */
const NOW_MS = Date.parse(NOW)

/** Assert a value is present and narrow it for the rest of the test. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`)
  return value
}

/** Capture the rejection reason of a promise. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

/** Let queued microtasks run so an executor has consumed its fake child's exit facts. */
async function settleMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Trip fixtures, shaped after tests/domain.spec.ts
// ---------------------------------------------------------------------------

/** Builds a source stamp. */
function makeSource(fetchedAt: string = NOW): SourceStamp {
  return { provider: 'amap-cli', fetchedAt, providerVersion: '1.0.0' }
}

/** Builds a trip place. */
function makePlace(id: string, overrides: Partial<TripPlace> = {}): TripPlace {
  return {
    id,
    name: `地点 ${id}`,
    address: `地址 ${id}`,
    point: { longitude: 120.15, latitude: 30.28, coordinateSystem: 'gcj02' },
    categories: ['风景名胜'],
    status: 'planned',
    source: makeSource(),
    ...overrides,
  }
}

/** Optional item fields accepted by {@link makeItem}. */
interface ItemExtras {
  readonly startAt?: string
  readonly endAt?: string
  readonly plannedDurationMinutes?: number
  readonly locked?: boolean
  readonly notes?: readonly string[]
}

/** Builds an itinerary item. */
function makeItem(id: string, placeId: string, extras: ItemExtras = {}): ItineraryItem {
  const item: {
    id: string
    placeId: string
    startAt?: string
    endAt?: string
    plannedDurationMinutes?: number
    locked: boolean
    notes: readonly string[]
  } = { id, placeId, locked: extras.locked ?? false, notes: extras.notes ?? [] }
  if (extras.startAt !== undefined) item.startAt = extras.startAt
  if (extras.endAt !== undefined) item.endAt = extras.endAt
  if (extras.plannedDurationMinutes !== undefined) {
    item.plannedDurationMinutes = extras.plannedDurationMinutes
  }
  return item
}

/** Optional leg fields accepted by {@link makeLeg}. */
interface LegExtras {
  readonly mode?: TravelMode
  readonly distanceMeters?: number
  readonly durationSeconds?: number
  readonly freshness?: RouteFreshness
}

/** Builds a route leg. */
function makeLeg(id: string, fromItemId: string, toItemId: string, extras: LegExtras = {}): RouteLeg {
  const distance = extras.distanceMeters ?? 1200
  const duration = extras.durationSeconds ?? 960
  return {
    id,
    fromItemId,
    toItemId,
    mode: extras.mode ?? 'walking',
    distanceMeters: distance,
    durationSeconds: duration,
    steps: [{ instruction: '直行', distanceMeters: distance, durationSeconds: duration }],
    freshness: extras.freshness ?? 'fresh',
    source: makeSource(),
  }
}

/** Optional day fields accepted by {@link makeDay}. */
interface DayExtras {
  readonly date?: string
  readonly title?: string
  readonly areaLabel?: string
  readonly items?: readonly ItineraryItem[]
  readonly legs?: readonly RouteLeg[]
  readonly transits?: readonly TripTransit[]
}

/** Builds a trip day. */
function makeDay(id: string, extras: DayExtras = {}): TripDay {
  const day: {
    id: string
    date: string
    title: string
    areaLabel?: string
    items: readonly ItineraryItem[]
    legs: readonly RouteLeg[]
  } = {
    id,
    date: extras.date ?? '2026-10-01',
    title: extras.title ?? id,
    items: extras.items ?? [],
    legs: extras.legs ?? [],
  }
  if (extras.areaLabel !== undefined) day.areaLabel = extras.areaLabel
  if (extras.transits !== undefined) return { ...day, transits: extras.transits }
  return day
}

/** Builds a scenario. */
function makeScenario(id: string, days: readonly TripDay[]): TripScenario {
  return { id, title: `方案 ${id}`, basedOnRevision: 1, days }
}

/** Builds travel preferences. */
function makePreferences(overrides: Partial<TravelPreferences> = {}): TravelPreferences {
  return { pace: 'balanced', interests: ['美食'], avoid: [], preferredModes: ['walking', 'transit'], ...overrides }
}

/** Optional project fields accepted by {@link makeProject}. */
interface ProjectExtras {
  readonly id?: string
  readonly title?: string
  readonly status?: TripStatus
  readonly revision?: number
  readonly places?: readonly TripPlace[]
  readonly scenarios?: readonly TripScenario[]
  readonly activeScenarioId?: string
  readonly budget?: BudgetSummary
  readonly preferences?: TravelPreferences
  readonly travelers?: readonly TravelerProfile[]
  readonly destinations?: readonly string[]
  readonly startDate?: string
  readonly endDate?: string
  readonly updatedAt?: string
}

/** Builds a trip project with a single active scenario by default. */
function makeProject(extras: ProjectExtras = {}): TripProject {
  const places: Record<string, TripPlace> = {}
  for (const place of extras.places ?? []) places[place.id] = place
  return {
    schemaVersion: CURRENT_TRIP_SCHEMA_VERSION,
    id: extras.id ?? 'trip-1',
    revision: extras.revision ?? 1,
    title: extras.title ?? '杭州三日游',
    status: extras.status ?? 'drafting',
    timezone: 'Asia/Shanghai',
    startDate: extras.startDate ?? '2026-10-01',
    endDate: extras.endDate ?? '2026-10-03',
    destinations: extras.destinations ?? ['杭州'],
    travelers: extras.travelers ?? [{ id: 'u1', label: '我', interests: [], accessibilityNeeds: [] }],
    preferences: extras.preferences ?? makePreferences(),
    constraints: [],
    places,
    scenarios: extras.scenarios ?? [makeScenario('main', [makeDay('day1')])],
    activeScenarioId: extras.activeScenarioId ?? 'main',
    budget: extras.budget ?? { currency: 'CNY' },
    alerts: [],
    createdAt: '2026-09-01T00:00:00+08:00',
    updatedAt: extras.updatedAt ?? '2026-09-01T00:00:00+08:00',
  }
}

// ---------------------------------------------------------------------------
// Fake filesystem
// ---------------------------------------------------------------------------

/** Concrete target the fake filesystem hands back for one absolute path. */
interface FakeTarget {
  readonly path: string
}

/** In-memory {@link TripFs} plus the bookkeeping needed to assert store effects. */
interface FakeFsHandle {
  readonly fs: TripFs
  /** Current file contents, keyed by absolute path. */
  readonly files: Map<string, string>
  /** Paths passed to `writeText`, in call order. */
  readonly writes: readonly string[]
  /** Paths passed to `readText`, in call order. */
  readonly reads: readonly string[]
  /** Seed one file without touching the write counters. */
  seed(path: string, text: string): void
  /** Current text of one path, if any. */
  text(path: string): string | undefined
}

/** Build a fake filesystem over a path→text map; directories are implied by file paths. */
function createFakeFs(): FakeFsHandle {
  const files = new Map<string, string>()
  const writes: string[] = []
  const reads: string[] = []
  const pathOf = (target: TripFsTarget): string => (target as FakeTarget).path
  const has = (path: string): boolean =>
    files.has(path) || [...files.keys()].some((candidate) => candidate.startsWith(`${path}/`))

  return {
    files,
    writes,
    reads,
    seed: (path, text) => {
      files.set(path, text)
    },
    text: (path) => files.get(path),
    fs: {
      resolve: async (path: string) => ({ path }),
      readText: async (target: TripFsTarget): Promise<string> => {
        const path = pathOf(target)
        reads.push(path)
        const text = files.get(path)
        if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
        return text
      },
      writeText: async (target: TripFsTarget, content: string): Promise<unknown> => {
        const path = pathOf(target)
        writes.push(path)
        files.set(path, content)
        return undefined
      },
      listDir: async (target: TripFsTarget): Promise<readonly string[]> => {
        const directory = pathOf(target)
        const names = new Set<string>()
        for (const candidate of files.keys()) {
          if (!candidate.startsWith(`${directory}/`)) continue
          const name = candidate.slice(directory.length + 1).split('/')[0]
          if (name !== undefined && name !== '') names.add(name)
        }
        if (!has(directory)) throw new Error(`ENOENT: no such directory, scandir '${directory}'`)
        return [...names]
      },
      exists: async (target: TripFsTarget): Promise<boolean> => has(pathOf(target)),
    },
  }
}

/** Assert that a promise rejects with a {@link TripStoreError} carrying `code`. */
async function expectStoreError(promise: Promise<unknown>, code: TripStoreError['code']): Promise<TripStoreError> {
  const error = await rejectionOf(promise)
  expect(error).toBeInstanceOf(TripStoreError)
  if (!(error instanceof TripStoreError)) throw new Error(`expected a TripStoreError but received ${String(error)}`)
  expect(error.code).toBe(code)
  return error
}

// ---------------------------------------------------------------------------
// TripStore
// ---------------------------------------------------------------------------

describe('TripStore', () => {
  const ROOT = '/store'

  /** Build a store over a fresh fake filesystem. */
  function createStore(): { readonly store: TripStore; readonly fake: FakeFsHandle } {
    const fake = createFakeFs()
    return { store: new TripStore(fake.fs, ROOT), fake }
  }

  it('derives the documented store, document and export paths', () => {
    const { store } = createStore()

    expect(store.root).toBe(ROOT)
    expect(store.pathFor('trip-1')).toBe('/store/projects/trip-1/trip.json')
    expect(store.exportDirFor('trip-1')).toBe('/store/projects/trip-1/exports')
  })

  it('round-trips a project through write and read', async () => {
    const { store, fake } = createStore()
    const project = makeProject()

    await expect(store.write(project)).resolves.toEqual(project)

    expect(fake.text(store.pathFor('trip-1'))).toBe(`${JSON.stringify(project, null, 2)}\n`)
    await expect(store.read('trip-1')).resolves.toEqual(project)
  })

  it('returns undefined for a trip that does not exist', async () => {
    const { store, fake } = createStore()

    await expect(store.read('missing')).resolves.toBeUndefined()
    expect(fake.reads).toEqual([])
  })

  it('lists summaries newest first and skips entries without a readable document', async () => {
    const { store, fake } = createStore()
    fake.seed(
      store.pathFor('older'),
      `${JSON.stringify(makeProject({ id: 'older', title: '旧行程', updatedAt: '2026-09-10T00:00:00+08:00' }))}\n`,
    )
    fake.seed(
      store.pathFor('middle'),
      `${JSON.stringify(makeProject({ id: 'middle', revision: 3, updatedAt: '2026-09-15T00:00:00+08:00' }))}\n`,
    )
    fake.seed(
      store.pathFor('newest'),
      `${JSON.stringify(
        makeProject({
          id: 'newest',
          title: '苏州两日',
          destinations: ['苏州'],
          scenarios: [makeScenario('main', [makeDay('day1'), makeDay('day2')])],
          updatedAt: '2026-09-20T00:00:00+08:00',
        }),
      )}\n`,
    )
    // A leftover export directory: listed in `projects/`, but it holds no trip document.
    fake.seed(`${store.root}/projects/leftover/exports/itinerary.md`, '# 旧导出')

    const summaries = await store.list()

    expect(summaries.map((entry) => entry.id)).toEqual(['newest', 'middle', 'older'])
    expect(summaries[0]).toEqual({
      id: 'newest',
      title: '苏州两日',
      status: 'drafting',
      startDate: '2026-10-01',
      endDate: '2026-10-03',
      durationDays: 2,
      revision: 1,
      updatedAt: '2026-09-20T00:00:00+08:00',
      activeScenarioId: 'main',
      destinations: ['苏州'],
    })
    expect(summaries[1]?.revision).toBe(3)
    expect(fake.writes).toEqual([])
  })

  // One damaged document must not hide every healthy trip: `list()` skips an
  // entry that exists but is not valid JSON, while an explicit single-trip
  // `read()` still fails loudly (covered by the tests below).
  it('skips an unreadable document while listing', async () => {
    const { store, fake } = createStore()
    fake.seed(store.pathFor('broken'), '{ not json')
    fake.seed(store.pathFor('good'), `${JSON.stringify(makeProject({ id: 'good' }))}\n`)

    const summaries = await store.list()

    expect(summaries.map((summary) => summary.id)).toEqual(['good'])
  })

  it('lists nothing for an empty workspace', async () => {
    const { store } = createStore()

    await expect(store.list()).resolves.toEqual([])
  })

  it('rejects an invalid JSON document with TRIP_INVALID_DOCUMENT', async () => {
    const { store, fake } = createStore()
    fake.seed(store.pathFor('trip-1'), '{ "schemaVersion": 1,')

    const error = await expectStoreError(store.read('trip-1'), 'TRIP_INVALID_DOCUMENT')

    expect(error.message).toContain('is not valid JSON')
    expect(error.name).toBe('TripStoreError')
  })

  it('rejects an unsupported schema version with TRIP_SCHEMA_UNSUPPORTED', async () => {
    const { store, fake } = createStore()
    fake.seed(store.pathFor('trip-1'), `${JSON.stringify({ ...makeProject(), schemaVersion: 3 }, null, 2)}\n`)

    const error = await expectStoreError(store.read('trip-1'), 'TRIP_SCHEMA_UNSUPPORTED')

    expect(error.message).toContain('schema version')
  })

  it('still reads a version-1 document, which has no transits', async () => {
    const { store, fake } = createStore()
    fake.seed(store.pathFor('trip-1'), `${JSON.stringify({ ...makeProject(), schemaVersion: 1 }, null, 2)}\n`)

    // A trip written before transits existed loads unchanged; the field is
    // simply absent and the panel falls back to the day title as it always did.
    const read = await store.read('trip-1')

    expect(read?.schemaVersion).toBe(1)
    expect(read?.scenarios[0]?.days[0]?.transits).toBeUndefined()
  })

  it('rejects a document that is missing a required field', async () => {
    const { store, fake } = createStore()
    const { title: _dropped, ...withoutTitle } = makeProject()
    fake.seed(store.pathFor('trip-1'), `${JSON.stringify(withoutTitle)}\n`)

    const error = await expectStoreError(store.read('trip-1'), 'TRIP_INVALID_DOCUMENT')

    expect(error.message).toContain('title')
  })

  it('guards a write with expectedRevision and accepts a match or no expectation', async () => {
    const { store, fake } = createStore()
    await store.write(makeProject({ revision: 3 }))

    const error = await expectStoreError(store.write(makeProject({ revision: 4 }), 1), 'TRIP_INVALID_DOCUMENT')
    expect(error.message).toContain('revision 3, expected 1')
    expect(fake.text(store.pathFor('trip-1'))).toBe(`${JSON.stringify(makeProject({ revision: 3 }), null, 2)}\n`)

    await expect(store.write(makeProject({ revision: 4 }), 3)).resolves.toMatchObject({ revision: 4 })
    await expect(store.write(makeProject({ revision: 9 }))).resolves.toMatchObject({ revision: 9 })
  })

  it('writes a first document even when expectedRevision is given', async () => {
    const { store } = createStore()

    await expect(store.write(makeProject({ id: 'fresh' }), 7)).resolves.toMatchObject({ id: 'fresh' })
    await expect(store.read('fresh')).resolves.toMatchObject({ id: 'fresh' })
  })

  it('writes an export under the trip export directory and returns its path', async () => {
    const { store, fake } = createStore()

    const path = await store.writeExport('trip-1', 'itinerary.md', '# 杭州三日游\n')

    expect(path).toBe('/store/projects/trip-1/exports/itinerary.md')
    expect(fake.text(path)).toBe('# 杭州三日游\n')
    expect(fake.writes).toEqual(['/store/projects/trip-1/exports/itinerary.md'])
  })
})

// ---------------------------------------------------------------------------
// parsePatchOps
// ---------------------------------------------------------------------------

describe('parsePatchOps', () => {
  it('accepts a valid batch as typed operations', () => {
    const result = parsePatchOps([
      { kind: 'rename-trip', title: '  杭州两日游  ' },
      { kind: 'set-budget', currency: 'cny', limit: 8000 },
      { kind: 'set-item-lock', dayId: 'day1', itemId: 'i1', locked: true },
      { kind: 'set-trip-dates', startDate: '2026-09-25' },
      { kind: 'set-trip-dates', startDate: '2026-09-25', endDate: '2026-09-27', redateDays: false },
      { kind: 'add-place', place: { id: 'p9', name: '龙井村', point: { longitude: 120.1, latitude: 30.2 } } },
      {
        kind: 'set-leg',
        dayId: 'day1',
        leg: {
          id: 'l9',
          fromItemId: 'i1',
          toItemId: 'i2',
          mode: 'walking',
          distanceMeters: 1200,
          durationSeconds: 900,
          steps: [{ instruction: '直行' }],
        },
      },
    ])

    expect(result.violations).toEqual([])
    expect(result.ops).toEqual([
      { kind: 'rename-trip', title: '杭州两日游' },
      { kind: 'set-budget', currency: 'cny', limit: 8000 },
      { kind: 'set-item-lock', dayId: 'day1', itemId: 'i1', locked: true },
      { kind: 'set-trip-dates', startDate: '2026-09-25' },
      { kind: 'set-trip-dates', startDate: '2026-09-25', endDate: '2026-09-27', redateDays: false },
      {
        kind: 'add-place',
        place: {
          id: 'p9',
          name: '龙井村',
          address: '',
          point: { longitude: 120.1, latitude: 30.2, coordinateSystem: 'gcj02' },
          categories: [],
          status: 'candidate',
          source: { provider: 'manual', fetchedAt: new Date(0).toISOString() },
        },
      },
      {
        kind: 'set-leg',
        dayId: 'day1',
        leg: {
          id: 'l9',
          fromItemId: 'i1',
          toItemId: 'i2',
          mode: 'walking',
          distanceMeters: 1200,
          durationSeconds: 900,
          steps: [{ instruction: '直行', distanceMeters: 0, durationSeconds: 0 }],
          freshness: 'fresh',
          source: { provider: 'amap-cli', fetchedAt: new Date(0).toISOString() },
        },
      },
    ])
  })

  it('reports every violation class with its index while the valid ops still parse', () => {
    const result = parsePatchOps([
      { kind: 'set-status', status: 'ready' },
      { kind: 'teleport' },
      'not-an-operation',
      { kind: 'rename-trip' },
      { kind: 'rename-trip', title: '   ' },
      { kind: 'set-status', status: 'teleporting' },
      { kind: 'set-item-lock', dayId: 'day1', itemId: 'i1' },
      { kind: 'set-budget' },
      { kind: 'set-budget', limit: -1 },
      { kind: 'set-trip-dates' },
      { kind: 'set-trip-dates', startDate: '2026-09-25', redateDays: 'yes' },
      { kind: 'set-preferences', preferences: { interests: ['美食', 3] } },
      { kind: 'set-item-time', dayId: 'day1', itemId: 'i1' },
      { kind: 'add-place', place: { id: 'p9', name: '龙井村', point: 'nope' } },
      { kind: 'add-place', place: { id: 'p9', name: '龙井村', point: { longitude: 181, latitude: 30 } } },
      { kind: 'add-place', place: { id: 'p9', name: '龙井村', point: { longitude: 120, latitude: -90.5 } } },
      {
        kind: 'set-leg',
        dayId: 'day1',
        leg: {
          id: 'l9',
          fromItemId: 'i1',
          toItemId: 'i2',
          mode: 'walking',
          distanceMeters: 1,
          durationSeconds: 1,
          steps: 'nope',
        },
      },
      { kind: 'set-item-lock', dayId: 'day1', itemId: 'i1', locked: false },
    ])

    expect(result.violations.map((violation) => violation.index)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ])
    expect(result.ops.map((op) => op.kind)).toEqual(['set-status', 'set-item-lock'])
    expect(result.ops[0]).toEqual({ kind: 'set-status', status: 'ready' })
    expect(result.ops[1]).toEqual({ kind: 'set-item-lock', dayId: 'day1', itemId: 'i1', locked: false })
    expect(result.violations[0]?.message).toContain('teleport')
    expect(result.violations[2]?.message).toContain('title')
    expect(result.violations[3]?.message).toContain('title')
    expect(result.violations[4]?.message).toContain('status')
    expect(result.violations[5]?.message).toContain('locked')
    expect(result.violations[6]?.message).toContain('set-budget')
    expect(result.violations[7]?.message).toContain('负数')
    expect(result.violations[8]?.message).toContain('startDate')
    expect(result.violations[9]?.message).toContain('redateDays')
    expect(result.violations[10]?.message).toContain('interests')
    expect(result.violations[11]?.message).toContain('set-item-time')
    expect(result.violations[13]?.message).toContain('longitude')
    expect(result.violations[14]?.message).toContain('latitude')
    expect(result.violations[15]?.message).toContain('steps')
  })

  it('reports a single violation with index -1 for a non-array batch', () => {
    const result = parsePatchOps({ ops: [] })

    expect(result.ops).toEqual([])
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]?.index).toBe(-1)
    expect(result.violations[0]?.message).toContain('数组')
  })
})

// ---------------------------------------------------------------------------
// buildTravelView
// ---------------------------------------------------------------------------

/** Wrap summaries into the switcher stats the projection expects. */
function statsOf(summaries: readonly TripSummary[], readiness = 0.7): readonly {
  readonly summary: TripSummary
  readonly readiness: number
  readonly alerts: { readonly error: number; readonly warning: number; readonly info: number }
}[] {
  return summaries.map((summary) => ({ summary, readiness, alerts: { error: 0, warning: 1, info: 1 } }))
}

/** Build the projection context the sidebar passes in. */
function viewContext(readiness = 0.7): {
  readonly readiness: number
  readonly map: { readonly enabled: boolean; readonly version: string; readonly style: string }
  readonly selection: { readonly tripId: string; readonly source: 'explicit' }
} {
  return {
    readiness,
    map: { enabled: false, version: '2.0', style: 'normal' },
    selection: { tripId: 'trip-1', source: 'explicit' },
  }
}

describe('parsePatchOps', () => {
  it('accepts a transit, whose ends may be a place or only a name', () => {
    const result = parsePatchOps([
      {
        kind: 'set-day-transit',
        dayId: 'day1',
        transit: {
          id: 't1',
          from: { placeId: 'p1' },
          to: { label: '  西安  ' },
          mode: 'driving',
          distanceMeters: 723000,
          steps: [{ instruction: '驶入京昆高速' }],
          freshness: 'stale',
          provider: 'title',
          polyline: '108.9,34.2;107.1,33.0',
        },
      },
      { kind: 'remove-day-transit', dayId: 'day1', transitId: 't1' },
    ])

    expect(result.violations).toEqual([])
    expect(result.ops[0]).toMatchObject({
      kind: 'set-day-transit',
      dayId: 'day1',
      transit: {
        id: 't1',
        from: { placeId: 'p1', label: '' },
        // The name is trimmed, and the distance and duration stay optional.
        to: { label: '西安' },
        mode: 'driving',
        distanceMeters: 723000,
        freshness: 'stale',
        polyline: '108.9,34.2;107.1,33.0',
      },
    })
    expect(result.ops[1]).toEqual({ kind: 'remove-day-transit', dayId: 'day1', transitId: 't1' })
  })

  it('rejects a transit whose end names nothing', () => {
    const result = parsePatchOps([
      { kind: 'set-day-transit', dayId: 'day1', transit: { id: 't1', from: {}, to: { label: '西安' } } },
    ])

    expect(result.ops).toEqual([])
    expect(result.violations[0]?.message).toContain('transit.from')
  })
})

describe('buildTravelView', () => {
  /** A two-day trip with two located places, one unknown place, and three legs. */
  function makeViewProject(): TripProject {
    return makeProject({
      id: 'trip-1',
      title: '杭州两日游',
      revision: 4,
      status: 'checking',
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      destinations: ['杭州'],
      budget: { currency: 'CNY', limit: 5000, estimatedTotal: 4200 },
      places: [
        makePlace('p1', { name: '西湖', categories: ['风景名胜', '公园'] }),
        makePlace('p2', { name: '楼外楼', categories: ['餐厅'] }),
      ],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            date: '2026-10-01',
            title: '西湖漫步',
            areaLabel: '西湖区',
            items: [
              makeItem('i1', 'p1', {
                startAt: '2026-10-01T09:00:00+08:00',
                endAt: '2026-10-01T11:00:00+08:00',
                plannedDurationMinutes: 120,
              }),
              makeItem('i2', 'p2', { plannedDurationMinutes: 60, locked: true }),
              makeItem('i3', 'p1'),
            ],
            legs: [
              makeLeg('l1', 'i1', 'i2', { distanceMeters: 1200, durationSeconds: 960 }),
              makeLeg('l2', 'i2', 'i3', { distanceMeters: 300, durationSeconds: 240 }),
            ],
          }),
          makeDay('day2', {
            date: '2026-10-02',
            title: '灵隐问禅',
            items: [makeItem('i4', 'ghost'), makeItem('i5', 'p2')],
            legs: [
              makeLeg('l3', 'i4', 'i5', {
                distanceMeters: 5000,
                durationSeconds: 3600,
                freshness: 'stale',
              }),
            ],
          }),
        ]),
      ],
    })
  }

  const alerts: readonly TripAlert[] = [
    {
      id: 'route-stale:day2:l3',
      severity: 'warning',
      code: 'ROUTE_STALE',
      message: '第 2 天的路线可能过期。',
      relatedIds: ['l3', 'i4', 'i5'],
      suggestedActions: ['重新规划路线'],
    },
    {
      id: 'place-unknown:day2:i4',
      severity: 'error',
      code: 'PLACE_UNKNOWN',
      message: '第 2 天的安排引用了不存在的地点。',
      relatedIds: ['ghost', 'i4'],
      suggestedActions: ['补充地点'],
    },
    {
      id: 'budget-unknown',
      severity: 'info',
      code: 'BUDGET_UNKNOWN',
      message: '已设置预算上限，但还没有估算总额。',
      relatedIds: [],
      suggestedActions: [],
    },
  ]

  it('projects the headline, days, places and summaries', () => {
    const project = makeViewProject()
    const summaries: readonly TripSummary[] = [
      summarize(project),
      summarize(makeProject({ id: 'trip-2', title: '苏州一日', updatedAt: '2026-09-01T00:00:00+08:00' })),
    ]

    const view = buildTravelView(project, alerts, statsOf(summaries), viewContext(0.7))

    expect(view.headline).toEqual({
      tripId: 'trip-1',
      title: '杭州两日游',
      status: 'checking',
      revision: 4,
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      destinations: ['杭州'],
      travelers: ['我'],
      currency: 'CNY',
      budgetLimit: 5000,
      budgetEstimated: 4200,
      readiness: 0.7,
      alerts: { error: 1, warning: 1, info: 1 },
      updatedAt: project.updatedAt,
    })
    expect(view.headline?.alerts).toEqual(countAlerts(alerts))
    expect(view.alerts).toBe(alerts)
    expect(view.trips).toEqual([
      {
        id: 'trip-1',
        title: '杭州两日游',
        status: 'checking',
        startDate: '2026-10-01',
        endDate: '2026-10-02',
        durationDays: 2,
        revision: 4,
        updatedAt: project.updatedAt,
        activeScenarioId: 'main',
        destinations: ['杭州'],
        readiness: 0.7,
        alerts: { error: 0, warning: 1, info: 1 },
      },
      {
        id: 'trip-2',
        title: '苏州一日',
        status: 'drafting',
        startDate: '2026-10-01',
        endDate: '2026-10-03',
        durationDays: 1,
        revision: 1,
        updatedAt: '2026-09-01T00:00:00+08:00',
        activeScenarioId: 'main',
        destinations: ['杭州'],
        readiness: 0.7,
        alerts: { error: 0, warning: 1, info: 1 },
      },
    ])
    expect(view.activeTripId).toBe('trip-1')
    expect(view.selectionSource).toBe('explicit')
    expect(view.places.map((place) => place.name)).toEqual(['西湖', '楼外楼'])
    expect(view.places[0]?.categories).toEqual(['风景名胜', '公园'])
    expect(view.places[0]?.fetchedAt).toBe(NOW)
    expect(view.places[0]?.status).toBe('planned')
  })

  it('makes each day total the sum of its legs', () => {
    const view = buildTravelView(makeViewProject(), alerts, [], viewContext(0.7))

    expect(view.days.map((day) => day.id)).toEqual(['day1', 'day2'])
    const day1 = required(view.days[0], 'day1')
    const day2 = required(view.days[1], 'day2')

    expect(day1.title).toBe('西湖漫步')
    expect(day1.areaLabel).toBe('西湖区')
    expect(day1.totalDistanceMeters).toBe(1500)
    expect(day1.totalDurationSeconds).toBe(1200)
    expect(day1.totalDistanceMeters).toBe(
      day1.legs.reduce((total, leg) => total + leg.distanceMeters, 0),
    )
    expect(day2.totalDistanceMeters).toBe(5000)
    expect(day2.totalDurationSeconds).toBe(3600)
    expect(day2.totalDurationSeconds).toBe(
      day2.legs.reduce((total, leg) => total + leg.durationSeconds, 0),
    )
    expect(day1.legs[0]?.steps).toEqual([{ instruction: '直行', distanceMeters: 1200, durationSeconds: 960 }])
  })

  it('marks only the leg covered by a ROUTE_STALE alert as stale', () => {
    const view = buildTravelView(makeViewProject(), alerts, [], viewContext(0.7))
    const day1 = required(view.days[0], 'day1')
    const day2 = required(view.days[1], 'day2')

    expect(day1.legs.map((leg) => leg.id)).toEqual(['l1', 'l2'])
    expect(day1.legs.map((leg) => leg.stale)).toEqual([false, false])
    expect(day2.legs.map((leg) => leg.id)).toEqual(['l3'])
    expect(day2.legs.map((leg) => leg.stale)).toEqual([true])
    expect(day2.legs[0]?.freshness).toBe('stale')
  })

  it('links a PLACE_UNKNOWN alert to its item and renders the unknown place', () => {
    const view = buildTravelView(makeViewProject(), alerts, [], viewContext(0.7))
    const day2 = required(view.days[1], 'day2')
    const unknown = required(day2.items[0], 'the unknown-place item')

    expect(unknown.name).toBe('未知地点（ghost）')
    expect(unknown.category).toBe('未分类')
    expect(unknown.address).toBe('')
    expect('point' in unknown).toBe(false)
    expect(unknown.alertIds).toEqual(['route-stale:day2:l3', 'place-unknown:day2:i4'])
    expect(day2.alertIds).toEqual(['route-stale:day2:l3', 'place-unknown:day2:i4'])
    expect(day2.items[1]?.alertIds).toEqual(['route-stale:day2:l3'])
  })

  it('keeps item time and lock facts and reports no days without an active scenario', () => {
    const project = makeViewProject()
    const view = buildTravelView(project, [], [], viewContext(1))

    const day1 = required(view.days[0], 'day1')
    const first = required(day1.items[0], 'the first item')
    expect(first.name).toBe('西湖')
    expect(first.startAt).toBe('2026-10-01T09:00:00+08:00')
    expect(first.endAt).toBe('2026-10-01T11:00:00+08:00')
    expect(first.plannedDurationMinutes).toBe(120)
    expect(first.locked).toBe(false)
    expect(day1.items[1]?.locked).toBe(true)
    expect(view.headline?.alerts).toEqual({ error: 0, warning: 0, info: 0 })

    const orphan = buildTravelView({ ...project, activeScenarioId: 'missing' }, [], [], viewContext(1))
    expect(orphan.days).toEqual([])
    expect(orphan.headline?.tripId).toBe('trip-1')
  })
})

describe('view helpers', () => {
  it('counts alerts by severity', () => {
    const alert = (severity: TripAlert['severity'], id: string): TripAlert => ({
      id,
      severity,
      code: 'CODE',
      message: 'm',
      relatedIds: [],
      suggestedActions: [],
    })

    expect(countAlerts([alert('error', 'a'), alert('info', 'b'), alert('warning', 'c'), alert('error', 'd')])).toEqual({
      error: 2,
      warning: 1,
      info: 1,
    })
    expect(countAlerts([])).toEqual({ error: 0, warning: 0, info: 0 })
  })

  it('labels severities in Chinese', () => {
    expect(severityLabel('error')).toBe('阻塞')
    expect(severityLabel('warning')).toBe('警告')
    expect(severityLabel('info')).toBe('提示')
  })

  it('projects the AMap runtime facts with unavailable defaults', () => {
    expect(amapRuntimeView(undefined, { configured: false, missing: ['AMAP_WEB_KEY'] })).toEqual({
      status: 'unavailable',
      mapReady: false,
      startedByPlugin: false,
      configured: false,
      missing: ['AMAP_WEB_KEY'],
    })
    expect(
      amapRuntimeView({ status: 'running', mapReady: true, startedByPlugin: true }, { configured: true, missing: [] }),
    ).toEqual({
      status: 'running',
      mapReady: true,
      startedByPlugin: true,
      configured: true,
      missing: [],
    })
  })
})

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

describe('normalizeConfig', () => {
  /** Build a schema-shaped configuration, overriding only the fields under test. */
  function makeConfig(overrides: Partial<Omit<Config, 'amap'>> = {}, amapOverrides: Partial<AmapConfig> = {}): Config {
    return {
      workspaceSubdirectory: '.travel',
      currency: 'CNY',
      timezone: 'Asia/Shanghai',
      httpPath: '/api/skillre-travel',
      alerts: { routeStaleMode: 'adaptive' },
      ui: { placePhotos: 'auto' },
      ...overrides,
      amap: {
        executable: 'amap-gui',
        webKeyRef: 'AMAP_WEB_KEY',
        browserMap: 'auto',
        autoStart: true,
        autoStop: true,
        commandTimeoutMs: 45_000,
        poiCacheTtlMs: 86_400_000,
        routeCacheTtlMs: 21_600_000,
        ...amapOverrides,
      },
    }
  }

  it('clamps the command timeout and the cache lifetimes into CONFIG_LIMITS', () => {
    const tooSmall = normalizeConfig(
      makeConfig({}, { commandTimeoutMs: 1, poiCacheTtlMs: -5, routeCacheTtlMs: CONFIG_LIMITS.maxCacheTtlMs + 1 }),
    )
    expect(tooSmall.amap.commandTimeoutMs).toBe(CONFIG_LIMITS.minCommandTimeoutMs)
    expect(tooSmall.amap.poiCacheTtlMs).toBe(0)
    expect(tooSmall.amap.routeCacheTtlMs).toBe(CONFIG_LIMITS.maxCacheTtlMs)

    const tooLarge = normalizeConfig(makeConfig({}, { commandTimeoutMs: CONFIG_LIMITS.maxCommandTimeoutMs + 1 }))
    expect(tooLarge.amap.commandTimeoutMs).toBe(CONFIG_LIMITS.maxCommandTimeoutMs)

    const inside = normalizeConfig(makeConfig({}, { commandTimeoutMs: 30_000, poiCacheTtlMs: 1_000 }))
    expect(inside.amap.commandTimeoutMs).toBe(30_000)
    expect(inside.amap.poiCacheTtlMs).toBe(1_000)

    const fractional = normalizeConfig(makeConfig({}, { commandTimeoutMs: 4_500.9 }))
    expect(fractional.amap.commandTimeoutMs).toBe(4_500)

    const notANumber = normalizeConfig(makeConfig({}, { commandTimeoutMs: Number.NaN }))
    expect(notANumber.amap.commandTimeoutMs).toBe(CONFIG_LIMITS.minCommandTimeoutMs)
  })

  it('trims values, uppercases the currency, and keeps a non-empty securityKeyRef', () => {
    const normalized = normalizeConfig(
      makeConfig(
        { workspaceSubdirectory: '  trips  ', currency: ' cny ', timezone: ' UTC ', httpPath: ' api/ ' },
        { executable: '  amap-gui  ', webKeyRef: '  AMAP_WEB_KEY  ', securityKeyRef: '  AMAP_SECURITY_KEY  ' },
      ),
    )

    expect(normalized.workspaceSubdirectory).toBe('trips')
    expect(normalized.currency).toBe('CNY')
    expect(normalized.timezone).toBe('UTC')
    expect(normalized.httpPath).toBe('/api')
    expect(normalized.amap.executable).toBe('amap-gui')
    expect(normalized.amap.webKeyRef).toBe('AMAP_WEB_KEY')
    expect(normalized.amap.securityKeyRef).toBe('AMAP_SECURITY_KEY')
  })

  it('drops a blank securityKeyRef and defaults blank values', () => {
    const dropped = normalizeConfig(makeConfig({}, { securityKeyRef: '   ' }))
    expect('securityKeyRef' in dropped.amap).toBe(false)

    const blank = normalizeConfig(
      makeConfig(
        { workspaceSubdirectory: '   ', currency: '', timezone: '  ', httpPath: '   ' },
        { executable: ' ', webKeyRef: ' K ', securityKeyRef: '' },
      ),
    )
    expect(blank.workspaceSubdirectory).toBe('.travel')
    expect(blank.currency).toBe('CNY')
    expect(blank.timezone).toBe('Asia/Shanghai')
    expect(blank.httpPath).toBe('/api/skillre-travel')
    expect(blank.amap.executable).toBe('amap-gui')
    expect('securityKeyRef' in blank.amap).toBe(false)
  })

  it('preserves the unrelated AMap switches', () => {
    const normalized = normalizeConfig(makeConfig({}, { autoStart: false, autoStop: false }))

    expect(normalized.amap.autoStart).toBe(false)
    expect(normalized.amap.autoStop).toBe(false)
  })
})

describe('normalizeHttpPath', () => {
  it('adds a missing leading slash and strips trailing slashes', () => {
    expect(normalizeHttpPath('api')).toBe('/api')
    expect(normalizeHttpPath('api/')).toBe('/api')
    expect(normalizeHttpPath('/api/skillre-travel/')).toBe('/api/skillre-travel')
    expect(normalizeHttpPath('/api/skillre-travel///')).toBe('/api/skillre-travel')
    expect(normalizeHttpPath('  /api  ')).toBe('/api')
  })

  it('falls back to the default for an empty path', () => {
    expect(normalizeHttpPath('')).toBe('/api/skillre-travel')
    expect(normalizeHttpPath('   ')).toBe('/api/skillre-travel')
    expect(normalizeHttpPath('/')).toBe('/api/skillre-travel')
  })
})

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('handles ASCII, CJK and punctuation-only input', () => {
    expect(slugify('Hangzhou City Trip!')).toBe('hangzhou-city-trip')
    expect(slugify('  杭州 三日游  ')).toBe('杭州-三日游')
    expect(slugify('--a--b--')).toBe('a-b')
    expect(slugify('!!!')).toBe('trip')
    expect(slugify('   ')).toBe('trip')
  })

  it('caps the slug at forty characters without leaving a trailing separator', () => {
    expect(slugify('a'.repeat(50))).toBe('a'.repeat(40))
    expect(slugify(`${'a'.repeat(39)}-${'b'.repeat(10)}`)).toBe('a'.repeat(39))
  })
})

describe('tripIdFor', () => {
  it('is stable and changes with the start date', () => {
    const id = tripIdFor('杭州三日游', '2026-10-01')

    expect(id).toBe(tripIdFor('杭州三日游', '2026-10-01'))
    expect(id).toContain('杭州三日游')
    expect(id).toMatch(/^[\p{Letter}\p{Number}-]+-[0-9a-f]{6}$/u)
    expect(tripIdFor('杭州三日游', '2026-10-02')).not.toBe(id)
    expect(tripIdFor('苏州三日游', '2026-10-01')).not.toBe(id)
  })
})

describe('itemIdFor', () => {
  it('is stable and changes with the sequence', () => {
    expect(itemIdFor('day1', 'p1', 0)).toBe(itemIdFor('day1', 'p1', 0))
    expect(itemIdFor('day1', 'p1', 0)).not.toBe(itemIdFor('day1', 'p1', 1))
    expect(itemIdFor('day1', 'p1', 0)).toMatch(/^day1-i0-[0-9a-f]{4}$/)
  })
})

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-10-01', 0)).toBe('2026-10-01')
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
  })

  it('returns the input unchanged for garbage', () => {
    expect(addDays('not-a-date', 3)).toBe('not-a-date')
    expect(addDays('', 1)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// createSubprocessExec
// ---------------------------------------------------------------------------

/** One fake child the executor can drive deterministically. */
interface FakeChild {
  /** The exact spawn request the executor built. */
  readonly spec: SubprocessSpawnSpec
  /** Settle the child with Node's close-event vocabulary. */
  finish(exitCode: number | null, signal?: NodeJS.Signals | null): void
  /** True once `terminate()` ran, including through the spawn signal. */
  terminated: boolean
}

/** Collected-stream reader over a fixed string. */
function readerFor(text: string): SubprocessOutputReader {
  return {
    readFrom: (fromByte: number) => ({ text: text.slice(fromByte), nextOffset: text.length, lossy: false }),
  }
}

/** Build a fake subprocess service that records every spawn and never touches the OS. */
function createFakeSubprocess(
  options: { readonly stdout?: string; readonly stderr?: string; readonly spawnThrows?: Error } = {},
): { readonly subprocess: SubprocessLike; readonly children: FakeChild[] } {
  const children: FakeChild[] = []
  const subprocess: SubprocessLike = {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      if (options.spawnThrows !== undefined) throw options.spawnThrows
      let settle: ((outcome: SubprocessOutcome) => void) | undefined
      const done = new Promise<SubprocessOutcome>((resolve) => {
        settle = resolve
      })
      const child: FakeChild = {
        spec,
        terminated: false,
        finish: (exitCode, signal = null) => {
          settle?.({ exitCode, signal })
        },
      }
      const kill = (): void => {
        child.terminated = true
        child.finish(null, 'SIGTERM')
      }
      if (spec.signal?.aborted === true) kill()
      else spec.signal?.addEventListener('abort', kill, { once: true })

      children.push(child)
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: { stdout: readerFor(options.stdout ?? ''), stderr: readerFor(options.stderr ?? '') },
        done,
        terminate: kill,
        waitForExit: async () => true,
      }
    },
  }
  return { subprocess, children }
}

/** Timer seam whose firing the test controls, keeping timeout ordering deterministic. */
interface GatedDelay {
  readonly delay: (ms: number) => Promise<void>
  /** Timeout budgets requested so far, in call order. */
  readonly requested: readonly number[]
  /** Fire every pending timer, as the fiber-owned timer service would. */
  fire(): void
}

/** Build a delay that only resolves when the test fires it. */
function createGatedDelay(): GatedDelay {
  const requested: number[] = []
  const waiters: Array<() => void> = []
  return {
    requested,
    delay: (ms: number) => {
      requested.push(ms)
      return new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    },
    fire: () => {
      for (const resolve of waiters.splice(0)) resolve()
    },
  }
}

/** Assert that an async action rejects with an {@link AmapCliError} carrying `code`. */
async function expectAmapErrorCode(action: () => Promise<unknown>, code: AmapErrorCode): Promise<void> {
  const error = await rejectionOf(action())
  expect(AmapCliError.isAmapCliError(error)).toBe(true)
  if (!AmapCliError.isAmapCliError(error)) throw new Error(`expected an AmapCliError but received ${String(error)}`)
  expect(error.code).toBe(code)
}

describe('createSubprocessExec', () => {
  const REQUEST: ExecRequest = {
    argv: ['status'],
    cwd: '/workspace',
    env: { AMAP_WEB_KEY: 'test' },
    timeoutMs: 5_000,
  }

  it('returns the exit code plus the collected stdout and stderr', async () => {
    const fake = createFakeSubprocess({ stdout: '{"success":true}\n', stderr: 'warn\n' })
    const timer = createGatedDelay()
    const exec = createSubprocessExec(fake.subprocess, timer.delay)

    const pending = exec(REQUEST)
    await settleMicrotasks()
    required(fake.children[0], 'the spawned child').finish(0)
    await settleMicrotasks()
    timer.fire()

    const result = await pending
    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: '{"success":true}\n',
      stderr: 'warn\n',
      timedOut: false,
      aborted: false,
    })

    const spec = required(fake.children[0], 'the spawned child').spec
    expect(spec.argv).toEqual(['status'])
    expect(spec.cwd).toBe('/workspace')
    expect(spec.env).toEqual({ AMAP_WEB_KEY: 'test' })
    expect(spec.graceMs).toBeGreaterThan(0)
    expect(spec.stdio.stdin).toBe('ignore')
    expect(typeof spec.stdio.stdout === 'object' ? spec.stdio.stdout.maxBytes : 0).toBeGreaterThan(0)
    expect(timer.requested).toEqual([5_000])
  })

  it('returns a non-zero exit unchanged', async () => {
    const fake = createFakeSubprocess({ stderr: 'boom\n' })
    const timer = createGatedDelay()
    const exec = createSubprocessExec(fake.subprocess, timer.delay)

    const pending = exec(REQUEST)
    await settleMicrotasks()
    required(fake.children[0], 'the spawned child').finish(3)
    await settleMicrotasks()
    timer.fire()

    await expect(pending).resolves.toEqual({
      exitCode: 3,
      signal: null,
      stdout: '',
      stderr: 'boom\n',
      timedOut: false,
      aborted: false,
    })
  })

  it('maps a synchronously failing spawn to AMAP_CLI_NOT_FOUND', async () => {
    const fake = createFakeSubprocess({ spawnThrows: new Error('spawn amap-gui ENOENT') })
    const timer = createGatedDelay()
    const exec = createSubprocessExec(fake.subprocess, timer.delay)

    await expectAmapErrorCode(() => exec(REQUEST), 'AMAP_CLI_NOT_FOUND')

    expect(fake.children).toEqual([])
    expect(timer.requested).toEqual([5_000])
  })

  it('reports an already-aborted request signal', async () => {
    const fake = createFakeSubprocess({ stdout: 'ignored\n' })
    const timer = createGatedDelay()
    const controller = new AbortController()
    controller.abort()
    const exec = createSubprocessExec(fake.subprocess, timer.delay)

    const pending = exec({ ...REQUEST, signal: controller.signal })
    await settleMicrotasks()
    timer.fire()

    await expect(pending).resolves.toEqual({
      exitCode: null,
      signal: 'SIGTERM',
      stdout: 'ignored\n',
      stderr: '',
      timedOut: false,
      aborted: true,
    })
    expect(required(fake.children[0], 'the spawned child').terminated).toBe(true)
  })

  it('reports a timeout when the timer fires before the child exits', async () => {
    const fake = createFakeSubprocess()
    const timer = createGatedDelay()
    const exec = createSubprocessExec(fake.subprocess, timer.delay)

    const pending = exec(REQUEST)
    await settleMicrotasks()
    expect(required(fake.children[0], 'the spawned child').terminated).toBe(false)
    timer.fire()

    await expect(pending).resolves.toEqual({
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      timedOut: true,
      aborted: false,
    })
    expect(required(fake.children[0], 'the spawned child').terminated).toBe(true)
    expect(timer.requested).toEqual([REQUEST.timeoutMs])
  })

  it('returns as soon as the child exits, without waiting out the timeout', async () => {
    // The 45s budget used to be awaited in a `finally`, so every uncached CLI
    // call cost the full timeout even though `amap-gui` answers in well under a
    // second. The timer here never fires: the call must still finish.
    const fake = createFakeSubprocess({ stdout: '{"success":true}\n' })
    const timer = createGatedDelay()
    const exec = createSubprocessExec(fake.subprocess, timer.delay)

    const pending = exec(REQUEST)
    await settleMicrotasks()
    required(fake.children[0], 'the spawned child').finish(0)
    const raced = await Promise.race([pending.then(() => 'resolved' as const), settleMicrotasks().then(() => 'pending' as const)])

    expect(raced).toBe('resolved')
    await expect(pending).resolves.toMatchObject({ exitCode: 0, timedOut: false, stdout: '{"success":true}\n' })
    expect(timer.requested).toEqual([REQUEST.timeoutMs])
  })

  it('leaves a finished call alone when its timer finally fires', async () => {
    const fake = createFakeSubprocess({ stdout: 'ok\n' })
    const timer = createGatedDelay()
    const exec = createSubprocessExec(fake.subprocess, timer.delay)

    const pending = exec(REQUEST)
    await settleMicrotasks()
    const child = required(fake.children[0], 'the spawned child')
    child.finish(0)
    await expect(pending).resolves.toMatchObject({ exitCode: 0, timedOut: false })

    // A budget that outlives its call must not terminate anything.
    timer.fire()
    await settleMicrotasks()
    expect(child.terminated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// registerTravelHttp
// ---------------------------------------------------------------------------

/** One route the API registered on the fake web server. */
interface RegisteredRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** Route seat that captures the API's registration and counts disposals. */
function createFakeWebServer(): {
  readonly server: WebServerLike
  readonly routes: readonly RegisteredRoute[]
  disposeCount(): number
} {
  const routes: RegisteredRoute[] = []
  let disposals = 0
  return {
    routes,
    disposeCount: () => disposals,
    server: {
      register: (route) => {
        routes.push(route)
        return () => {
          disposals += 1
        }
      },
    },
  }
}

/** Captured status, headers and body of one fake response. */
interface CapturedResponse {
  statusCode: number
  readonly headers: Record<string, string>
  body: string
}

/** Minimal `ServerResponse` stand-in that captures everything `sendJson` writes. */
function createFakeResponse(): { readonly res: ServerResponse; readonly captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, headers: {}, body: '' }
  const res = {
    get statusCode(): number {
      return captured.statusCode
    },
    set statusCode(value: number) {
      captured.statusCode = value
    },
    setHeader: (name: string, value: string): void => {
      captured.headers[name.toLowerCase()] = value
    },
    end: (body?: string): void => {
      captured.body = body ?? ''
    },
  }
  return { res: res as unknown as ServerResponse, captured }
}

/** Minimal `IncomingMessage` stand-in with an async-iterable JSON body. */
function createFakeRequest(init: {
  readonly method: string
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
}): IncomingMessage {
  const chunks = init.body === undefined ? [] : [Buffer.from(JSON.stringify(init.body), 'utf8')]
  const req = {
    method: init.method,
    url: init.url,
    headers: init.headers ?? {},
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      for (const chunk of chunks) yield chunk
    },
  }
  return req as unknown as IncomingMessage
}

/** Drive the registered handler once and decode its JSON response. */
async function callApi(
  handler: RegisteredRoute['handler'],
  init: {
    readonly method: string
    readonly url: string
    readonly headers?: Record<string, string>
    readonly body?: unknown
  },
): Promise<{ readonly status: number; readonly headers: Record<string, string>; readonly payload: Record<string, unknown> }> {
  const { res, captured } = createFakeResponse()
  await handler(createFakeRequest(init), res)
  return {
    status: captured.statusCode,
    headers: captured.headers,
    payload: JSON.parse(captured.body) as Record<string, unknown>,
  }
}

describe('registerTravelHttp', () => {
  const API_PREFIX = '/api/skillre-travel'
  const WORKSPACE = '/workspace'
  const SUBDIRECTORY = '.travel'
  const STORE_DIR = `${WORKSPACE}/${SUBDIRECTORY}`
  const SAME_ORIGIN: Record<string, string> = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }

  /** The one trip every HTTP test serves. */
  function makeHttpTrip(): TripProject {
    return makeProject({
      id: 'trip-1',
      title: '杭州两日游',
      places: [makePlace('p1', { name: '西湖' })],
      scenarios: [makeScenario('main', [makeDay('day1', { items: [makeItem('i1', 'p1')] })])],
    })
  }

  /** Register the API over a fake filesystem seeded with one readable trip. */
  function seededApi(project: TripProject = makeHttpTrip()): {
    readonly fake: FakeFsHandle
    readonly route: RegisteredRoute
    readonly dispose: () => void
    readonly disposeCount: () => number
  } {
    const fake = createFakeFs()
    fake.seed(`${STORE_DIR}/projects/${project.id}/trip.json`, `${JSON.stringify(project, null, 2)}\n`)
    const web = createFakeWebServer()
    const service = new TravelService({
      fs: fake.fs,
      subdirectory: SUBDIRECTORY,
      currency: 'CNY',
      fallbackCwd: WORKSPACE,
      cwdFor: async () => WORKSPACE,
      clock: () => NOW_MS,
    })
    const dispose = registerTravelHttp({} as unknown as Context, web.server, API_PREFIX, {
      service,
      configuration: () => ({ configured: false, missing: ['AMAP_WEB_KEY'] }),
    })
    const route = web.routes[0]
    if (route === undefined) throw new Error('registerTravelHttp did not register a route')
    return { fake, route, dispose, disposeCount: web.disposeCount }
  }

  it('registers one prefix route and returns its disposer', () => {
    const api = seededApi()

    expect(api.route.kind).toBe('prefix')
    expect(api.route.path).toBe(API_PREFIX)

    api.dispose()
    expect(api.disposeCount()).toBe(1)
  })

  it('serves the travel view for GET /state', async () => {
    const api = seededApi()

    const response = await callApi(api.route.handler, { method: 'GET', url: `${API_PREFIX}/state` })

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.payload['ok']).toBe(true)
    const view = response.payload['view'] as TravelView
    expect(view.headline?.tripId).toBe('trip-1')
    expect(view.headline?.title).toBe('杭州两日游')
    expect(view.headline?.readiness).toBe(1)
    expect(view.trips.map((trip) => trip.id)).toEqual(['trip-1'])
    expect(view.days.map((day) => day.id)).toEqual(['day1'])
    expect(view.places.map((place) => place.name)).toEqual(['西湖'])
    expect((response.payload['amap'] as AmapRuntimeView).status).toBe('unavailable')
    expect(api.fake.writes).toEqual([])
  })

  it('reports configuration for GET /health', async () => {
    const api = seededApi()

    const response = await callApi(api.route.handler, { method: 'GET', url: `${API_PREFIX}/health` })

    expect(response.status).toBe(200)
    expect(response.payload).toEqual({
      ok: true,
      configured: false,
      missing: ['AMAP_WEB_KEY'],
      amap: {
        status: 'unavailable',
        mapReady: false,
        startedByPlugin: false,
        configured: false,
        missing: ['AMAP_WEB_KEY'],
      },
    })
  })

  it('returns 404 for an unknown route', async () => {
    const api = seededApi()

    const response = await callApi(api.route.handler, { method: 'GET', url: `${API_PREFIX}/nope` })

    expect(response.status).toBe(404)
    expect(response.payload).toEqual({ ok: false, error: 'unknown route /nope' })
  })

  it('rejects a cross-origin POST with 403 without touching the store', async () => {
    const api = seededApi()
    const stored = api.fake.text(`${STORE_DIR}/projects/trip-1/trip.json`)

    const response = await callApi(api.route.handler, {
      method: 'POST',
      url: `${API_PREFIX}/patch`,
      headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' },
      body: { ops: [{ kind: 'set-status', status: 'ready' }] },
    })

    expect(response.status).toBe(403)
    expect(response.payload).toEqual({ ok: false, error: 'cross-origin request rejected' })
    expect(api.fake.reads).toEqual([])
    expect(api.fake.writes).toEqual([])
    expect(api.fake.text(`${STORE_DIR}/projects/trip-1/trip.json`)).toBe(stored)
  })

  it('reports an empty op batch as unchanged without touching the store', async () => {
    const api = seededApi()

    const response = await callApi(api.route.handler, {
      method: 'POST',
      url: `${API_PREFIX}/patch`,
      headers: SAME_ORIGIN,
      body: { ops: [] },
    })

    expect(response.status).toBe(200)
    expect(response.payload).toEqual({ ok: true, changed: false, applied: [], rejected: [], violations: [] })
    expect(api.fake.reads).toEqual([])
    expect(api.fake.writes).toEqual([])
  })

  it('applies a set-item-lock op and returns the new revision', async () => {
    const api = seededApi()

    const response = await callApi(api.route.handler, {
      method: 'POST',
      url: `${API_PREFIX}/patch`,
      headers: SAME_ORIGIN,
      body: { tripId: 'trip-1', ops: [{ kind: 'set-item-lock', dayId: 'day1', itemId: 'i1', locked: true }] },
    })

    expect(response.status).toBe(200)
    expect(response.payload['ok']).toBe(true)
    expect(response.payload['changed']).toBe(true)
    expect(response.payload['applied']).toEqual(['set-item-lock:day1:i1:locked'])
    expect(response.payload['rejected']).toEqual([])
    expect(response.payload['violations']).toEqual([])
    expect(response.payload['revision']).toBe(2)
    expect(response.payload['alerts']).toEqual({ error: 0, warning: 0, info: 0 })

    const stored = JSON.parse(
      required(api.fake.text(`${STORE_DIR}/projects/trip-1/trip.json`), 'the stored document'),
    ) as TripProject
    expect(stored.revision).toBe(2)
    expect(stored.updatedAt).toBe(new Date(NOW_MS).toISOString())
    expect(stored.scenarios[0]?.days[0]?.items[0]?.locked).toBe(true)

    const view = response.payload['view'] as TravelView
    expect(view.days[0]?.items[0]?.locked).toBe(true)
    expect(view.headline?.revision).toBe(2)
  })

  it('returns 409 with REVISION_MISMATCH for a stale expectedRevision', async () => {
    const api = seededApi()

    const response = await callApi(api.route.handler, {
      method: 'POST',
      url: `${API_PREFIX}/patch`,
      headers: SAME_ORIGIN,
      body: { tripId: 'trip-1', expectedRevision: 99, ops: [{ kind: 'set-status', status: 'ready' }] },
    })

    expect(response.status).toBe(409)
    expect(response.payload['ok']).toBe(false)
    expect(response.payload['code']).toBe('REVISION_MISMATCH')
    expect(response.payload['expectedRevision']).toBe(99)
    expect(response.payload['actualRevision']).toBe(1)
    expect(response.payload['violations']).toEqual([])
    expect(api.fake.writes).toEqual([])
  })

  it('reports model-supplied violations beside a successful patch', async () => {
    const api = seededApi()

    const response = await callApi(api.route.handler, {
      method: 'POST',
      url: `${API_PREFIX}/patch`,
      headers: SAME_ORIGIN,
      body: {
        tripId: 'trip-1',
        ops: [{ kind: 'teleport' }, { kind: 'set-item-lock', dayId: 'day1', itemId: 'i1', locked: true }],
      },
    })

    expect(response.status).toBe(200)
    expect(response.payload['applied']).toEqual(['set-item-lock:day1:i1:locked'])
    const violations = response.payload['violations'] as readonly { readonly index: number; readonly message: string }[]
    expect(violations).toHaveLength(1)
    expect(violations[0]?.index).toBe(0)
    expect(violations[0]?.message).toContain('teleport')
  })
})

// ---------------------------------------------------------------------------
// Multi-trip selection
// ---------------------------------------------------------------------------

describe('trip selection', () => {
  const WORKSPACE = '/workspace'
  const SUBDIRECTORY = '.travel'
  const STORE_DIR = `${WORKSPACE}/${SUBDIRECTORY}`
  const STATE_PATH = `${STORE_DIR}/state.json`

  /** Seed three trips whose `updatedAt` decides the implicit fallback. */
  function seededStore(): { readonly fake: FakeFsHandle; readonly service: TravelService } {
    const fake = createFakeFs()
    for (const [id, updatedAt] of [
      ['beijing-3d', '2026-09-10T00:00:00.000Z'],
      ['kyoto-3d', '2026-09-12T00:00:00.000Z'],
      ['paris-4d', '2026-09-11T00:00:00.000Z'],
    ] as const) {
      const project = makeProject({ id, title: id, updatedAt })
      fake.seed(`${STORE_DIR}/projects/${id}/trip.json`, `${JSON.stringify(project, null, 2)}\n`)
    }
    const service = new TravelService({
      fs: fake.fs,
      subdirectory: SUBDIRECTORY,
      currency: 'CNY',
      fallbackCwd: WORKSPACE,
      cwdFor: async () => WORKSPACE,
      clock: () => NOW_MS,
    })
    return { fake, service }
  }

  it('falls back to the most recently updated trip when nothing is recorded', async () => {
    const { service } = seededStore()

    const selection = await service.selectTripId('session-1')

    expect(selection).toEqual({ tripId: 'kyoto-3d', source: 'recent' })
  })

  it('prefers an explicit id over every recorded choice', async () => {
    const { fake, service } = seededStore()
    fake.seed(STATE_PATH, JSON.stringify({ version: 1, activeTripId: 'paris-4d', sessions: { 'session-1': 'beijing-3d' }, updatedAt: '2026-09-14T00:00:00.000Z' }))

    expect(await service.selectTripId('session-1', 'kyoto-3d')).toEqual({ tripId: 'kyoto-3d', source: 'explicit' })
  })

  it('lets a session override the workspace default without touching it', async () => {
    const { fake, service } = seededStore()
    fake.seed(STATE_PATH, JSON.stringify({ version: 1, activeTripId: 'paris-4d', sessions: {}, updatedAt: '2026-09-14T00:00:00.000Z' }))

    await service.select('session-1', 'beijing-3d')

    expect(await service.selectTripId('session-1')).toEqual({ tripId: 'beijing-3d', source: 'session' })
    // Another session still lands on the workspace default.
    expect(await service.selectTripId('session-2')).toEqual({ tripId: 'paris-4d', source: 'workspace' })
    const stored = JSON.parse(fake.text(STATE_PATH) ?? '{}') as Record<string, unknown>
    expect(stored['activeTripId']).toBe('paris-4d')
    expect(stored['sessions']).toEqual({ 'session-1': 'beijing-3d' })
  })

  it('makes the first selection the workspace default and honours an explicit request', async () => {
    const { fake, service } = seededStore()

    await service.select('session-1', 'paris-4d')
    expect((JSON.parse(fake.text(STATE_PATH) ?? '{}') as Record<string, unknown>)['activeTripId']).toBe('paris-4d')

    await service.select('session-2', 'beijing-3d', true)
    expect((JSON.parse(fake.text(STATE_PATH) ?? '{}') as Record<string, unknown>)['activeTripId']).toBe('beijing-3d')
    expect(await service.selectTripId('session-3')).toEqual({ tripId: 'beijing-3d', source: 'workspace' })
  })

  it('ignores a recorded trip that no longer exists', async () => {
    const { fake, service } = seededStore()
    fake.seed(STATE_PATH, JSON.stringify({ version: 1, activeTripId: 'deleted-trip', sessions: { 'session-1': 'gone-too' }, updatedAt: '2026-09-14T00:00:00.000Z' }))

    expect(await service.selectTripId('session-1')).toEqual({ tripId: 'kyoto-3d', source: 'recent' })
  })

  it('treats a corrupt state document as no choice at all', async () => {
    const { fake, service } = seededStore()
    fake.seed(STATE_PATH, '{ not json')

    expect(await service.selectTripId('session-1')).toEqual({ tripId: 'kyoto-3d', source: 'recent' })
  })

  it('refuses to select a trip that does not exist', async () => {
    const { service } = seededStore()

    await expect(service.select('session-1', 'nowhere')).rejects.toThrow(/不存在/)
  })

  it('reports every trip with readiness and alert counts', async () => {
    const { service } = seededStore()

    const stats = await service.statsFor('session-1')

    expect(stats.map((stat) => stat.summary.id).sort()).toEqual(['beijing-3d', 'kyoto-3d', 'paris-4d'])
    expect(stats.every((stat) => stat.readiness >= 0 && stat.readiness <= 1)).toBe(true)
    expect(stats.every((stat) => stat.alerts.error + stat.alerts.warning + stat.alerts.info >= 0)).toBe(true)
  })

  it('stops calling the tab-information hook out of the view and carries map facts instead', async () => {
    const { service } = seededStore()
    const view = await service.view('session-1')

    expect(view.map.enabled).toBe(false)
    expect(view.map.version).toBe('2.0')
    expect(view.activeTripId).toBe('kyoto-3d')
    expect(view.selectionSource).toBe('recent')
    expect(view.trips).toHaveLength(3)
  })
})

describe('browser API: switching trips and the map facts', () => {
  const PREFIX = '/api/skillre-travel'
  const WORKSPACE = '/workspace'
  const STORE_DIR = `${WORKSPACE}/.travel`
  const STATE_PATH = `${STORE_DIR}/state.json`
  const SAME_ORIGIN = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }

  /** Serve two trips over the fake filesystem. */
  function twoTripApi(options: {
    readonly browserMapEnabled?: boolean
    readonly browserMapKey?: string
  } = {}): { readonly fake: FakeFsHandle; readonly handler: RegisteredRoute['handler'] } {
    const fake = createFakeFs()
    for (const [id, updatedAt] of [['beijing-3d', '2026-09-10T00:00:00.000Z'], ['kyoto-3d', '2026-09-12T00:00:00.000Z']] as const) {
      const project = makeProject({ id, title: id, updatedAt })
      fake.seed(`${STORE_DIR}/projects/${id}/trip.json`, `${JSON.stringify(project, null, 2)}\n`)
    }
    const web = createFakeWebServer()
    const service = new TravelService({
      fs: fake.fs,
      subdirectory: '.travel',
      currency: 'CNY',
      fallbackCwd: WORKSPACE,
      cwdFor: async () => WORKSPACE,
      clock: () => NOW_MS,
      ...options.browserMapEnabled === undefined ? {} : { browserMapEnabled: options.browserMapEnabled },
      ...options.browserMapKey === undefined ? {} : { browserMapKey: async () => options.browserMapKey },
    })
    registerTravelHttp({} as unknown as Context, web.server, PREFIX, {
      service,
      configuration: () => ({ configured: true, missing: [] }),
    })
    const route = web.routes[0]
    if (route === undefined) throw new Error('no route registered')
    return { fake, handler: route.handler }
  }

  it('switches the current trip for one session and persists the choice', async () => {
    const api = twoTripApi()

    const before = await callApi(api.handler, { method: 'GET', url: `${PREFIX}/state?sessionId=session-1`, headers: SAME_ORIGIN })
    expect((before.payload['view'] as TravelView).activeTripId).toBe('kyoto-3d')

    const switched = await callApi(api.handler, {
      method: 'POST',
      url: `${PREFIX}/select`,
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      body: { sessionId: 'session-1', tripId: 'beijing-3d' },
    })

    expect(switched.status).toBe(200)
    expect(switched.payload['activeTripId']).toBe('beijing-3d')
    expect((switched.payload['view'] as TravelView).headline?.tripId).toBe('beijing-3d')
    const stored = JSON.parse(api.fake.text(STATE_PATH) ?? '{}') as Record<string, unknown>
    expect(stored['sessions']).toEqual({ 'session-1': 'beijing-3d' })

    const after = await callApi(api.handler, { method: 'GET', url: `${PREFIX}/state?sessionId=session-1`, headers: SAME_ORIGIN })
    expect((after.payload['view'] as TravelView).selectionSource).toBe('session')
  })

  it('rejects a switch without a tripId and one to an unknown trip', async () => {
    const api = twoTripApi()

    const missing = await callApi(api.handler, {
      method: 'POST',
      url: `${PREFIX}/select`,
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      body: {},
    })
    expect(missing.status).toBe(400)

    const unknown = await callApi(api.handler, {
      method: 'POST',
      url: `${PREFIX}/select`,
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      body: { tripId: 'nowhere' },
    })
    expect(unknown.status).toBe(404)
    expect(unknown.payload['code']).toBe('TRIP_NOT_FOUND')
  })

  it('hands the Web JS key to the client only when the browser map is on', async () => {
    const on = twoTripApi({ browserMapEnabled: true, browserMapKey: 'web-key' })
    const onState = await callApi(on.handler, { method: 'GET', url: `${PREFIX}/state`, headers: SAME_ORIGIN })
    expect((onState.payload['view'] as TravelView).map).toEqual({ enabled: true, key: 'web-key', version: '2.0', style: 'normal' })

    const off = twoTripApi({ browserMapEnabled: false, browserMapKey: 'web-key' })
    const offState = await callApi(off.handler, { method: 'GET', url: `${PREFIX}/state`, headers: SAME_ORIGIN })
    expect((offState.payload['view'] as TravelView).map.enabled).toBe(false)

    const missing = twoTripApi({ browserMapEnabled: true })
    const missingState = await callApi(missing.handler, { method: 'GET', url: `${PREFIX}/state`, headers: SAME_ORIGIN })
    expect((missingState.payload['view'] as TravelView).map.enabled).toBe(false)
  })
})

describe('POST /refresh-places', () => {
  const PREFIX = '/api/skillre-travel'
  const WORKSPACE = '/workspace'
  const STORE_DIR = `${WORKSPACE}/.travel`
  const DOCUMENT = `${STORE_DIR}/projects/trip-1/trip.json`
  const SAME_ORIGIN = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
  const PHOTO = 'http://store.is.autonavi.com/showpic/17a36a737908810a310387c7d53e878a'

  /** Serve one trip whose places lack photos, over a stubbed search gateway. */
  function photoApi(
    places: readonly TripPlace[],
    matches: readonly TripPlace[],
    options: { readonly notRunning?: boolean } = {},
  ): {
    readonly fake: FakeFsHandle
    readonly handler: RegisteredRoute['handler']
    readonly keywords: readonly string[]
    readonly lookups: readonly { readonly allowStart?: boolean }[]
  } {
    const fake = createFakeFs()
    fake.seed(DOCUMENT, `${JSON.stringify(makeProject({ places }), null, 2)}\n`)
    const keywords: string[] = []
    const lookups: { readonly allowStart?: boolean }[] = []
    const gateway = {
      searchPlaces: (input: { readonly keyword: string }, _signal?: unknown, call: { readonly allowStart?: boolean } = {}) => {
        keywords.push(input.keyword)
        lookups.push(call)
        if (options.notRunning === true) {
          return Promise.reject(new AmapCliError('AMAP_NOT_RUNNING', '高德地图容器未运行。启动它会打开高德地图窗口。'))
        }
        return Promise.resolve({ keyword: input.keyword, total: matches.length, places: matches, fromCache: false })
      },
    }
    const web = createFakeWebServer()
    const service = new TravelService({
      fs: fake.fs,
      subdirectory: '.travel',
      currency: 'CNY',
      fallbackCwd: WORKSPACE,
      cwdFor: async () => WORKSPACE,
      clock: () => NOW_MS,
      includePhotos: true,
      gateway: () => gateway as unknown as AmapGateway,
    })
    registerTravelHttp({} as unknown as Context, web.server, PREFIX, {
      service,
      configuration: () => ({ configured: true, missing: [] }),
    })
    const route = web.routes[0]
    if (route === undefined) throw new Error('no route registered')
    return { fake, handler: route.handler, keywords, lookups }
  }

  const refresh = (handler: RegisteredRoute['handler']): ReturnType<typeof callApi> =>
    callApi(handler, {
      method: 'POST',
      url: `${PREFIX}/refresh-places`,
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      body: {},
    })

  it('fills a missing photo through the stored POI id', async () => {
    const api = photoApi(
      [makePlace('p1', { name: '西湖', providerPlaceId: 'B0XIHU' })],
      [makePlace('provider-1', { name: '西湖风景区', providerPlaceId: 'B0XIHU', photoUrl: PHOTO })],
    )

    const response = await refresh(api.handler)

    expect(response.status).toBe(200)
    expect(response.payload['checked']).toBe(1)
    expect(response.payload['updated']).toBe(1)
    // No Web-service key in this fixture, so the CLI answered.
    expect(response.payload['source']).toBe('amap-cli')
    expect(api.keywords).toEqual(['西湖'])
    const stored = JSON.parse(api.fake.text(DOCUMENT) ?? '{}') as TripProject
    expect(stored.places['p1']?.photoUrl).toBe(PHOTO)
    expect((response.payload['view'] as TravelView).places[0]?.photoUrl).toBe(PHOTO)
  })

  it('accepts an id-less place only from an exactly equal name that carries a photo', async () => {
    const api = photoApi(
      [makePlace('exact', { name: '西湖' }), makePlace('partial', { name: '西湖 音乐喷泉' })],
      [makePlace('provider-1', { name: '西湖', providerPlaceId: 'B0XIHU', photoUrl: PHOTO })],
    )

    const response = await refresh(api.handler)

    expect(response.payload['checked']).toBe(2)
    expect(response.payload['updated']).toBe(1)
    expect(response.payload['unmatched']).toEqual(['partial'])
    const stored = JSON.parse(api.fake.text(DOCUMENT) ?? '{}') as TripProject
    expect(stored.places['exact']?.photoUrl).toBe(PHOTO)
    expect(stored.places['partial']?.photoUrl).toBeUndefined()
  })

  it('does not call the provider when every place already has a photo', async () => {
    const api = photoApi([makePlace('p1', { name: '西湖', photoUrl: PHOTO })], [])

    const response = await refresh(api.handler)

    expect(response.payload['checked']).toBe(0)
    expect(response.payload['updated']).toBe(0)
    expect(api.keywords).toEqual([])
  })

  it('scopes a refresh to one place when placeId is given', async () => {
    const api = photoApi(
      [makePlace('wanted', { name: '西湖', providerPlaceId: 'B0XIHU' }), makePlace('other', { name: '雷峰塔' })],
      [makePlace('provider-1', { name: '西湖', providerPlaceId: 'B0XIHU', photoUrl: PHOTO })],
    )

    const response = await callApi(api.handler, {
      method: 'POST',
      url: `${PREFIX}/refresh-places`,
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      body: { placeId: 'wanted' },
    })

    expect(response.payload['checked']).toBe(1)
    expect(response.payload['updated']).toBe(1)
    expect(api.keywords).toEqual(['西湖'])
    // A silent photo lookup may not open the AMap window on its own.
    expect(api.lookups).toEqual([{ allowStart: false }])
    const stored = JSON.parse(api.fake.text(DOCUMENT) ?? '{}') as TripProject
    expect(stored.places['wanted']?.photoUrl).toBe(PHOTO)
    expect(stored.places['other']?.photoUrl).toBeUndefined()
  })

  it('starts the container only when the caller asks for it', async () => {
    const api = photoApi(
      [makePlace('p1', { name: '西湖', providerPlaceId: 'B0XIHU' })],
      [makePlace('provider-1', { name: '西湖', providerPlaceId: 'B0XIHU', photoUrl: PHOTO })],
    )

    const response = await callApi(api.handler, {
      method: 'POST',
      url: `${PREFIX}/refresh-places`,
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      body: { start: true },
    })

    expect(response.status).toBe(200)
    expect(response.payload['updated']).toBe(1)
    expect(api.lookups).toEqual([{ allowStart: true }])
  })

  it('answers needsStart instead of opening the window behind the user', async () => {
    const api = photoApi([makePlace('p1', { name: '西湖', providerPlaceId: 'B0XIHU' })], [], { notRunning: true })

    const response = await callApi(api.handler, {
      method: 'POST',
      url: `${PREFIX}/refresh-places`,
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      body: {},
    })

    expect(response.status).toBe(200)
    expect(response.payload['ok']).toBe(true)
    expect(response.payload['needsStart']).toBe(true)
    expect(response.payload['checked']).toBe(0)
    expect(response.payload['view']).toBeDefined()
  })

  it('tells the client whether photos may be projected at all', async () => {
    const api = photoApi([makePlace('p1', { name: '西湖' })], [])

    const response = await refresh(api.handler)

    expect((response.payload['view'] as TravelView).photos).toBe(true)
  })
})

describe('transit days', () => {
  const WORKSPACE = '/workspace'
  const SUBDIRECTORY = '.travel'
  const STORE_DIR = `${WORKSPACE}/${SUBDIRECTORY}`

  /** A trip whose second day is nothing but a 723 km drive. */
  function makeTransitProject(): TripProject {
    return makeProject({
      places: [makePlace('p1', { name: '宽窄巷子' }), makePlace('p2', { name: '回民街' })],
      scenarios: [
        makeScenario('main', [
          makeDay('day1', {
            title: '北京 → 西安｜赶路 1,077km',
            transits: [
              {
                id: 't1',
                from: { placeId: 'p2', label: '回民街' },
                to: { label: '成都' },
                mode: 'driving',
                distanceMeters: 723_000,
                durationSeconds: 8 * 3600,
                departAt: '2026-10-01T08:00:00+08:00',
                arriveAt: '2026-10-01T16:00:00+08:00',
                steps: [{ instruction: '沿京昆高速向西南', distanceMeters: 700_000, durationSeconds: 7 * 3600 }],
                freshness: 'stale',
                source: { provider: 'title', fetchedAt: NOW },
                polyline: '108.9,34.2;107.1,33.0',
              },
            ],
          }),
          makeDay('day2', { date: '2026-10-02', title: '成都｜休整', items: [makeItem('i1', 'p1')] }),
        ]),
      ],
    })
  }

  it('projects a transit with both ends, its path and where the figures came from', () => {
    const view = buildTravelView(makeTransitProject(), [], [], viewContext(0.9))
    const transit = view.days[0]?.transits[0]

    // The end that points at a place gets that place's coordinate; the end that
    // is only a name does not need one.
    expect(transit?.from).toMatchObject({ placeId: 'p2', label: '回民街', point: { latitude: 30.28 } })
    expect(transit?.to.label).toBe('成都')
    expect(transit?.to.point).toBeUndefined()
    expect(transit?.polyline).toBe('108.9,34.2;107.1,33.0')
    expect(transit?.source).toBe('title')
    expect(transit?.steps).toHaveLength(1)
    // The stop list is untouched: the transit is not a place to visit.
    expect(view.days[0]?.items).toEqual([])
    expect(view.days[1]?.transits).toEqual([])
  })

  it('writes a transit from the figures the caller has, and marks them stale', async () => {
    const fake = createFakeFs()
    fake.seed(`${STORE_DIR}/projects/trip-1/trip.json`, `${JSON.stringify(makeProject({ id: 'trip-1' }), null, 2)}\n`)
    const service = new TravelService({
      fs: fake.fs,
      subdirectory: '.travel',
      currency: 'CNY',
      fallbackCwd: WORKSPACE,
      cwdFor: async () => WORKSPACE,
      clock: () => Date.parse(NOW),
    })

    const written = await service.setDayTransit(undefined, 'trip-1', 'day1', {
      from: { label: '西安' },
      to: { label: '成都' },
      distanceMeters: 723_000,
      plan: false,
    })

    expect(written.planned).toBe(false)
    const stored = await service.require(undefined, 'trip-1')
    const transit = stored.scenarios[0]?.days[0]?.transits?.[0]
    expect(transit?.from.label).toBe('西安')
    expect(transit?.distanceMeters).toBe(723_000)
    // Nothing planned the road, so the panel shows it as an estimate.
    expect(transit?.freshness).toBe('stale')
    expect(transit?.source.provider).toBe('title')
  })

  it('plans a transit when both ends are located, and keeps the route facts', async () => {
    const fake = createFakeFs()
    fake.seed(
      `${STORE_DIR}/projects/trip-1/trip.json`,
      `${JSON.stringify(makeProject({ id: 'trip-1', places: [makePlace('p1'), makePlace('p2')] }), null, 2)}\n`,
    )
    const service = new TravelService({
      fs: fake.fs,
      subdirectory: '.travel',
      currency: 'CNY',
      fallbackCwd: WORKSPACE,
      cwdFor: async () => WORKSPACE,
      clock: () => Date.parse(NOW),
      gateway: () =>
        ({
          planRoute: () =>
            Promise.resolve({
              mode: 'driving',
              distanceMeters: 1_077_100,
              durationSeconds: 45_480,
              steps: [{ instruction: '驶入京港澳高速', distanceMeters: 1_000_000, durationSeconds: 40_000 }],
              from: { name: '杭州', point: { longitude: 120.1, latitude: 30.2, coordinateSystem: 'gcj02' } },
              to: { name: '西安', point: { longitude: 108.9, latitude: 34.2, coordinateSystem: 'gcj02' } },
              fetchedAt: NOW,
              fromCache: false,
            }),
        }) as unknown as AmapGateway,
    })

    const written = await service.setDayTransit(undefined, 'trip-1', 'day1', {
      from: { placeId: 'p1' },
      to: { placeId: 'p2' },
      departAt: '2026-10-01T06:00:00+08:00',
    })

    expect(written.planned).toBe(true)
    const transit = (await service.require(undefined, 'trip-1')).scenarios[0]?.days[0]?.transits?.[0]
    expect(transit?.distanceMeters).toBe(1_077_100)
    expect(transit?.freshness).toBe('fresh')
    // The clock is derived and keeps the departure's offset: leave at 06:00
    // +08:00, drive 12.6 hours, arrive at 18:38 the same day. A UTC answer would
    // read as 10:38 in the panel, which slices the text.
    expect(transit?.arriveAt).toBe('2026-10-01T18:38:00+08:00')
    // A place id is enough on its own: the label comes from the library.
    expect(transit?.from.label).toBe('地点 p1')
  })
})

describe('registerTravelTools', () => {
  const WORKSPACE = '/workspace'
  const STORE_DIR = `${WORKSPACE}/.travel`
  const NOW = '2026-09-15T07:00:00.000Z'

  /** Register the model tools over a fake filesystem and capture them by name. */
  async function toolsOver(trips: readonly { readonly id: string; readonly updatedAt: string }[]): Promise<{
    readonly tools: Map<string, { readonly execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }>
    readonly fake: FakeFsHandle
    readonly service: TravelService
  }> {
    const fake = createFakeFs()
    for (const trip of trips) {
      const project = makeProject({ id: trip.id, title: trip.id, updatedAt: trip.updatedAt })
      fake.seed(`${STORE_DIR}/projects/${trip.id}/trip.json`, `${JSON.stringify(project, null, 2)}\n`)
    }
    const service = new TravelService({
      fs: fake.fs,
      subdirectory: '.travel',
      currency: 'CNY',
      fallbackCwd: WORKSPACE,
      cwdFor: async () => WORKSPACE,
      clock: () => Date.parse(NOW),
    })
    const tools = new Map<string, { execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }>()
    const ctx = {
      effect: (callback: () => unknown) => callback(),
      tools: { register: (tool: { name: string; execute: never }) => { tools.set(tool.name, tool as never); return () => undefined } },
    } as unknown as Context
    registerTravelTools(ctx, { service, currency: 'CNY', timezone: 'Asia/Shanghai' })
    return { tools, fake, service }
  }

  it('registers every documented tool', async () => {
    const { tools } = await toolsOver([{ id: 'kyoto-3d', updatedAt: NOW }])

    expect([...tools.keys()].sort()).toEqual([
      'travel_day_rebuild_legs',
      'travel_day_set_transit',
      'travel_itinerary_validate',
      'travel_map_focus',
      'travel_place_refresh',
      'travel_place_search',
      'travel_project_create',
      'travel_project_export',
      'travel_project_list',
      'travel_project_patch',
      'travel_project_read',
      'travel_project_select',
      'travel_route_plan',
    ])
  })

  it('records a driving day through the model tool', async () => {
    const { tools, service } = await toolsOver([{ id: 'kyoto-3d', updatedAt: NOW }])

    const written = (await tools.get('travel_day_set_transit')?.execute(
      {
        tripId: 'kyoto-3d',
        dayId: 'day1',
        fromLabel: '西安',
        toLabel: '成都',
        distanceMeters: 723_000,
        plan: false,
      },
      { agent: { session: { id: 'session-1' } } },
    )) as { readonly transitId: string; readonly planned: boolean }

    expect(written.transitId).toBe('day1-transit-1')
    expect(written.planned).toBe(false)
    const day = (await service.require(undefined, 'kyoto-3d')).scenarios[0]?.days[0]
    expect(day?.transits?.[0]?.to.label).toBe('成都')
  })

  it('lists every trip with the active one marked', async () => {
    const { tools } = await toolsOver([
      { id: 'beijing-3d', updatedAt: '2026-09-10T00:00:00.000Z' },
      { id: 'kyoto-3d', updatedAt: '2026-09-12T00:00:00.000Z' },
    ])

    const listed = (await tools.get('travel_project_list')?.execute({}, { agent: { session: { id: 'session-1' } } })) as {
      readonly count: number
      readonly activeTripId: string
      readonly trips: readonly { readonly tripId: string; readonly active: boolean; readonly readiness: number }[]
    }

    expect(listed.count).toBe(2)
    expect(listed.activeTripId).toBe('kyoto-3d')
    expect(listed.trips.filter((trip) => trip.active).map((trip) => trip.tripId)).toEqual(['kyoto-3d'])
    expect(listed.trips[0]?.readiness).toBeGreaterThan(0)
  })

  it('switches the active trip through the model tool', async () => {
    const { tools, fake, service } = await toolsOver([
      { id: 'beijing-3d', updatedAt: '2026-09-10T00:00:00.000Z' },
      { id: 'kyoto-3d', updatedAt: '2026-09-12T00:00:00.000Z' },
    ])

    const switched = (await tools.get('travel_project_select')?.execute(
      { tripId: 'beijing-3d' },
      { agent: { session: { id: 'session-1' } } },
    )) as { readonly activeTripId: string; readonly note: string }

    expect(switched.activeTripId).toBe('beijing-3d')
    expect(switched.note).toContain('beijing-3d')
    expect((JSON.parse(fake.text(`${STORE_DIR}/state.json`) ?? '{}') as Record<string, unknown>)['sessions']).toEqual({
      'session-1': 'beijing-3d',
    })

    // The read tool now resolves through the session's own choice.
    const read = (await tools.get('travel_project_read')?.execute({}, { agent: { session: { id: 'session-1' } } })) as {
      readonly tripId: string
    }
    expect(read.tripId).toBe('beijing-3d')
    expect(await service.selectTripId('session-1')).toEqual({ tripId: 'beijing-3d', source: 'session' })
  })
})
