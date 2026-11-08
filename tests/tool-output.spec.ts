/**
 * Tool output contract coverage.
 *
 * The two defects this file exists for were both **boundary** mistakes, not
 * business-logic mistakes: `travel_project_create` returned an undeclared
 * `activeTripId` against its own `additionalProperties: false` output schema
 * (so every call was rejected after the trip had already been written), and
 * `travel_project_list` returned `undefined` fields on an empty workspace
 * (rejected as "value is not lossless JSON"). Neither was visible to a test
 * that only asserted the service layer.
 *
 * So this file does not assert per-tool return shapes; it asserts the boundary
 * itself for every registered tool:
 *
 * 1. when `output.schema` is an `additionalProperties: false` object, every
 *    top-level key of the canonical value must be a declared property;
 * 2. the canonical value must be lossless JSON — no `undefined` at any depth,
 *    and a `JSON.parse(JSON.stringify(...))` round trip must be strictly equal.
 *
 * Each tool runs a real happy path over a minimal usable workspace. Tools that
 * need AMap go through a stub gateway in the style of `tests/host.spec.ts`; no
 * tool is silently skipped, and the coverage test at the bottom fails when a
 * new tool is registered without a case here.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import type { TripPlace } from '../src/domain/trip.js'
import type { AmapGateway } from '../src/host/amap/gateway.js'
import { registerTravelTools } from '../src/host/tools.js'
import { TravelService } from '../src/host/travel-service.js'
import type { TripFs, TripFsTarget } from '../src/host/trip-store.js'

/** Workspace the fake filesystem serves. */
const WORKSPACE = '/workspace'
/** Session every tool call is attributed to. */
const SESSION = 'session-1'
/** Fixed evaluation instant, so nothing in this file depends on the clock. */
const NOW = '2026-09-15T07:00:00.000Z'

/** Assert a value is present and narrow it for the rest of the test. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`)
  return value
}

/**
 * Build an in-memory `TripFs`.
 *
 * The same shape `tests/host.spec.ts` uses: keys are absolute paths, so every
 * assertion is a direct read of what the plugin would have written.
 */
function createFakeFs(): TripFs {
  const files = new Map<string, string>()
  const pathOf = (target: TripFsTarget): string => (target as { readonly path: string }).path
  const has = (path: string): boolean =>
    files.has(path) || [...files.keys()].some((candidate) => candidate.startsWith(`${path}/`))
  return {
    resolve: async (path: string): Promise<TripFsTarget> => ({ path }),
    readText: async (target: TripFsTarget): Promise<string> => {
      const text = files.get(pathOf(target))
      if (text === undefined) throw new Error(`ENOENT: no such file, open '${pathOf(target)}'`)
      return text
    },
    writeText: async (target: TripFsTarget, content: string): Promise<unknown> => {
      files.set(pathOf(target), content)
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
  }
}

/** One AMap place as the provider would return it. */
function makeProviderPlace(id: string, name: string, telephone?: string): TripPlace {
  return {
    id,
    name,
    address: `京都府 ${name}`,
    point: { longitude: 135.785, latitude: 34.9949, coordinateSystem: 'gcj02' },
    categories: ['风景名胜'],
    status: 'candidate',
    providerPlaceId: `B0${id}`,
    photoUrl: `https://example.invalid/${id}.jpg`,
    ...telephone === undefined ? {} : { telephone },
    source: { provider: 'amap-cli', fetchedAt: NOW, providerVersion: '1.0.0' },
  }
}

/**
 * Stub gateway: enough of the AMap surface for the tools that reach the
 * provider, and nothing that opens a container.
 *
 * The two search results deliberately differ — one carries a telephone, the
 * other none — so the conditional spreads and the `?? null` fallback in
 * `travel_place_search` are exercised rather than assumed.
 */
function stubGateway(): AmapGateway {
  return {
    searchPlaces: async (input: { readonly keyword: string }) => ({
      keyword: input.keyword,
      total: 2,
      places: [makeProviderPlace('poi-1', '清水寺', '075-551-1234'), makeProviderPlace('poi-2', '金阁寺')],
      fromCache: false,
    }),
    planRoute: async (input: { readonly mode: string }) => ({
      mode: input.mode,
      distanceMeters: 723_000,
      durationSeconds: 29_520,
      tollsYuan: 320,
      steps: [],
      from: { name: '西安', point: { longitude: 108.939_77, latitude: 34.341_574, coordinateSystem: 'gcj02' } },
      to: { name: '成都', point: { longitude: 104.066_8, latitude: 30.572_8, coordinateSystem: 'gcj02' } },
      fetchedAt: NOW,
      fromCache: false,
    }),
    focusMap: async (): Promise<void> => undefined,
  } as unknown as AmapGateway
}

/** Workspace state one tool case needs before it is called. */
type Setup = 'empty' | 'trip' | 'planned'

/** What {@link prepare} produced. */
interface Workspace {
  readonly tripId: string | undefined
  readonly placeIds: readonly string[]
}

/** One tool plus the workspace and arguments its happy path needs. */
interface ToolCase {
  /** Registered tool name. */
  readonly name: string
  /** Case title; twice for a tool exercised in two workspace states. */
  readonly label: string
  /** Workspace state the call needs. */
  readonly setup: Setup
  /** Arguments for that call. */
  readonly args: (workspace: Workspace) => Record<string, unknown>
  /** Extra assertion for a case whose branch must be provably taken, not just non-throwing. */
  readonly check?: (value: unknown) => void
}

/** A registered tool surface over a fake filesystem and a stub gateway. */
interface Harness {
  readonly tools: ReadonlyMap<string, ToolDefinition>
  readonly service: TravelService
  /** Invoke one registered tool the way the registry would. */
  call(name: string, args: Record<string, unknown>): Promise<unknown>
}

/** Register every tool over a fresh workspace. */
function createHarness(): Harness {
  const service = new TravelService({
    fs: createFakeFs(),
    subdirectory: '.travel',
    currency: 'CNY',
    fallbackCwd: WORKSPACE,
    cwdFor: async () => WORKSPACE,
    clock: () => Date.parse(NOW),
    gateway: () => stubGateway(),
  })
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    tools: {
      register: (tool: ToolDefinition) => {
        tools.set(tool.name, tool)
        return () => undefined
      },
    },
  } as unknown as Context
  registerTravelTools(ctx, { service, currency: 'CNY', timezone: 'Asia/Shanghai' })
  return {
    tools,
    service,
    call: async (name, args) => {
      const tool = required(tools.get(name), `the registered tool ${name}`)
      return await tool.execute(args, { agent: { session: { id: SESSION } } } as never)
    },
  }
}

/** Bring a fresh harness up to the state one case needs. */
async function prepare(harness: Harness, setup: Setup): Promise<Workspace> {
  if (setup === 'empty') return { tripId: undefined, placeIds: [] }
  // Every non-empty case starts the way a model would: through the create tool.
  const created = (await harness.call('travel_project_create', {
    title: '京都 5 日',
    startDate: '2026-09-20',
    endDate: '2026-09-24',
    destinations: ['京都'],
  })) as { readonly tripId: string }
  const tripId = created.tripId
  if (setup === 'trip') return { tripId, placeIds: [] }

  const placeIds = ['p1', 'p2']
  await harness.call('travel_project_patch', {
    tripId,
    ops: [
      { kind: 'add-place', place: { id: placeIds[0], name: '清水寺', point: { longitude: 135.785, latitude: 34.9949 } } },
      { kind: 'add-place', place: { id: placeIds[1], name: '金阁寺', point: { longitude: 135.7292, latitude: 35.0394 } } },
    ],
  })
  return { tripId, placeIds }
}

/** Return the path of the first `undefined` in a JSON value, or `undefined` when there is none. */
function findUndefined(value: unknown, path = '$'): string | undefined {
  if (value === undefined) return path
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findUndefined(entry, `${path}[${String(index)}]`)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      const found = findUndefined(entry, `${path}.${key}`)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * Assert the two boundaries the tool registry enforces on every canonical value.
 * @param name - tool name, for the failure message.
 * @param tool - registered definition carrying the declared output schema.
 * @param value - what `execute` returned.
 */
function expectLosslessOutput(name: string, tool: ToolDefinition, value: unknown): void {
  const schema = tool.output.schema as {
    readonly type?: unknown
    readonly additionalProperties?: unknown
    readonly properties?: Readonly<Record<string, unknown>>
  }
  if (schema.additionalProperties === false && schema.properties !== undefined) {
    expect(schema.type, `${name}: additionalProperties:false 的对象 schema 应声明 type: object`).toBe('object')
    const declared = new Set(Object.keys(schema.properties))
    const returned = typeof value === 'object' && value !== null ? Object.keys(value) : []
    expect(
      returned.filter((key) => !declared.has(key)),
      `${name}: 返回体带了 output.schema 未声明的顶层键（回退到 B1 那样），运行时会以 "is not a declared property" 拒绝整次调用`,
    ).toEqual([])
  }

  const undefinedPath = findUndefined(value)
  expect(
    undefinedPath,
    `${name}: 返回体在 ${undefinedPath ?? ''} 处是 undefined（回退到 B2 那样）；工具边界按无损 JSON 校验，undefined 不是 JSON 值`,
  ).toBeUndefined()
  expect(
    JSON.parse(JSON.stringify(value)) as unknown,
    `${name}: JSON 往返后与原值不再严格相等，返回体不是无损 JSON`,
  ).toStrictEqual(value)
}

/** Every tool this plugin registers, with the happy path each one needs. */
const CASES: readonly ToolCase[] = [
  {
    name: 'travel_project_create',
    label: 'create（空工作区）',
    setup: 'empty',
    args: () => ({ title: '京都 5 日', startDate: '2026-09-20', endDate: '2026-09-24', destinations: ['京都'] }),
  },
  {
    name: 'travel_project_list',
    label: 'list（空工作区，B2 现场）',
    setup: 'empty',
    args: () => ({}),
  },
  {
    name: 'travel_project_list',
    label: 'list（已有行程）',
    setup: 'trip',
    args: () => ({}),
  },
  {
    name: 'travel_project_read',
    label: 'read（空工作区）',
    setup: 'empty',
    args: () => ({}),
  },
  {
    name: 'travel_project_read',
    label: 'read（含地点库）',
    setup: 'planned',
    args: () => ({}),
  },
  {
    name: 'travel_project_select',
    label: 'select',
    setup: 'trip',
    args: (workspace) => ({ tripId: workspace.tripId, asDefault: true }),
  },
  {
    name: 'travel_project_patch',
    label: 'patch（rename-trip）',
    setup: 'trip',
    args: (workspace) => ({ tripId: workspace.tripId, ops: [{ kind: 'rename-trip', title: '京都五日改' }] }),
  },
  {
    name: 'travel_project_patch',
    label: 'patch（revision 冲突的拒绝分支）',
    setup: 'trip',
    args: (workspace) => ({
      tripId: workspace.tripId,
      expectedRevision: 999,
      ops: [{ kind: 'rename-trip', title: '不该写进去' }],
    }),
    check: (value) => {
      // 这个分支是手写返回体，必须真的走到，而不是碰巧没抛错。
      const rejected = (value as { readonly rejected: readonly { readonly code: string }[] }).rejected
      expect(rejected[0]?.code).toBe('REVISION_MISMATCH')
    },
  },
  {
    name: 'travel_place_search',
    label: 'place_search（stub 高德）',
    setup: 'trip',
    args: () => ({ keyword: '清水寺', city: '京都', limit: 2 }),
  },
  {
    name: 'travel_place_refresh',
    label: 'place_refresh（stub 高德）',
    setup: 'planned',
    args: () => ({}),
  },
  {
    name: 'travel_route_plan',
    label: 'route_plan（stub 高德）',
    setup: 'empty',
    args: () => ({ from: '108.93977,34.341574', to: '104.0668,30.5728', mode: 'driving' }),
  },
  {
    name: 'travel_day_rebuild_legs',
    label: 'day_rebuild_legs（无时间块的一天）',
    setup: 'planned',
    args: () => ({ dayId: 'd1', mode: 'walking' }),
  },
  {
    name: 'travel_day_set_transit',
    label: 'day_set_transit（plan:false，不碰高德）',
    setup: 'planned',
    args: (workspace) => ({
      dayId: 'd1',
      fromPlaceId: workspace.placeIds[0],
      toPlaceId: workspace.placeIds[1],
      plan: false,
      distanceMeters: 723_000,
      durationSeconds: 29_520,
    }),
  },
  {
    name: 'travel_itinerary_validate',
    label: 'itinerary_validate',
    setup: 'planned',
    args: () => ({}),
  },
  {
    name: 'travel_project_export',
    label: 'project_export（markdown）',
    setup: 'planned',
    args: (workspace) => ({ tripId: workspace.tripId, format: 'markdown' }),
  },
  {
    name: 'travel_map_focus',
    label: 'map_focus（显式坐标）',
    setup: 'empty',
    args: () => ({ longitude: 135.785, latitude: 34.9949, zoom: 12 }),
  },
]

describe('travel_* 工具输出边界', () => {
  it('每个注册的工具都有本文件的 happy path case', () => {
    const harness = createHarness()

    expect([...harness.tools.keys()].sort()).toEqual([...new Set(CASES.map((entry) => entry.name))].sort())
  })

  for (const entry of CASES) {
    it(`${entry.name} 的输出合法：${entry.label}`, async () => {
      const harness = createHarness()
      const workspace = await prepare(harness, entry.setup)

      const value = await harness.call(entry.name, entry.args(workspace))

      expectLosslessOutput(entry.name, required(harness.tools.get(entry.name), entry.name), value)
      entry.check?.(value)
    })
  }

  it('B1 回归：travel_project_create 返回的 activeTripId 已在 output.schema 中声明', async () => {
    const harness = createHarness()
    const tool = required(harness.tools.get('travel_project_create'), 'travel_project_create')
    const declared = Object.keys((tool.output.schema as { readonly properties: Record<string, unknown> }).properties)

    const value = (await harness.call('travel_project_create', {
      title: '京都 5 日',
      startDate: '2026-09-20',
      endDate: '2026-09-24',
      destinations: ['京都'],
    })) as Record<string, unknown>

    // 行程已经写入；模型必须能拿到 id，而返回它的前提是声明它。
    expect(declared).toContain('activeTripId')
    expect(value['tripId']).toBeTruthy()
    expect(value['activeTripId']).toBe(value['tripId'])
  })

  it('B2 回归：空工作区的 travel_project_list 不返回 undefined 字段', async () => {
    const harness = createHarness()

    const value = (await harness.call('travel_project_list', {})) as Record<string, unknown>

    expect(value['count']).toBe(0)
    expect(value['trips']).toEqual([])
    expect(value['hint']).toBeTruthy()
    // 键必须整个缺席，而不是存在且为 undefined。
    expect(Object.hasOwn(value, 'activeTripId')).toBe(false)
    expect(Object.hasOwn(value, 'selectionSource')).toBe(false)
    expect(findUndefined(value)).toBeUndefined()
  })

  it('B2 回归的反面：有选中行程时两个字段都在，且没有被顺手删掉', async () => {
    const harness = createHarness()
    const workspace = await prepare(harness, 'trip')

    const value = (await harness.call('travel_project_list', {})) as Record<string, unknown>

    expect(value['count']).toBe(1)
    expect(value['activeTripId']).toBe(workspace.tripId)
    expect(value['selectionSource']).toBeTruthy()
  })
})
