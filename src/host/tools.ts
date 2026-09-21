import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { CURRENT_TRIP_SCHEMA_VERSION } from '../domain/trip.js'
import type { TripAlert, TripDay, TripProject, TripScenario, TravelMode } from '../domain/trip.js'
import { TripRevisionError } from '../domain/patch.js'
import { AmapCliError } from './amap/cli.js'
import type { AmapGateway } from './amap/gateway.js'
import { formatPoint } from './amap/cli.js'
import { addDays, itemIdFor, tripIdFor } from './ids.js'
import { parsePatchOps } from './patch-input.js'
import type { TravelService } from './travel-service.js'
import { TripStoreError } from './trip-store.js'
import { countAlerts } from './view.js'

/** Dependencies of the tool surface. */
export interface TravelToolDeps {
  /** Shared travel service. */
  readonly service: TravelService
  /** Default currency for new trips. */
  readonly currency: string
  /** Default time zone recorded on new trips. */
  readonly timezone: string
}

/** Maximum number of alert details returned inline. */
const ALERT_PREVIEW_LIMIT = 20

/**
 * Register every `travel_*` model tool on the host.
 * @param ctx - plugin context carrying the tool registry.
 * @param deps - service and defaults.
 */
export function registerTravelTools(ctx: Context, deps: TravelToolDeps): void {
  const { service } = deps

  /** Register one tool inside its own effect. */
  const register = (tool: ToolDefinition): void => {
    ctx.effect(() => ctx.tools.register(tool), `travel-planner: ${tool.name}`)
  }

  register(
    defineTool({
      name: 'travel_project_create',
      description:
        'Create a Trip Project for the current workspace. Use this before adding places or days. Dates are YYYY-MM-DD and endDate is inclusive.',
      parameters: {
        title: { type: 'string', required: true, description: '旅行标题，例如「京都 5 日」。' },
        startDate: { type: 'string', required: true, description: '出发日期，YYYY-MM-DD。' },
        endDate: { type: 'string', required: true, description: '结束日期，YYYY-MM-DD，含当天。' },
        destinations: { type: 'array', items: { type: 'string' }, required: true, description: '目的地城市或地区。' },
        travelers: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', required: true },
              interests: { type: 'array', items: { type: 'string' } },
            },
          },
          description: '同行人；只有一位时也建议填写。',
        },
        pace: { type: 'string', enum: ['relaxed', 'balanced', 'intensive'], description: '行程节奏，默认 balanced。' },
        interests: { type: 'array', items: { type: 'string' }, description: '兴趣标签。' },
        avoid: { type: 'array', items: { type: 'string' }, description: '希望避开的类型或地点。' },
        budgetLimit: { type: 'number', description: '总预算上限。' },
        currency: { type: 'string', description: '预算货币，默认使用插件配置。' },
        timezone: { type: 'string', description: '目的地时区，例如 Asia/Tokyo。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tripId: { type: 'string' },
            revision: { type: 'number' },
            dayCount: { type: 'number' },
            days: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `已创建旅行项目 ${value.tripId}（${String(value.dayCount)} 天，revision ${String(value.revision)}）。` },
        ],
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.session.id
        const tripId = tripIdFor(args.title, args.startDate)
        const store = await service.storeFor(sessionId)
        if ((await store.read(tripId)) !== undefined) {
          throw new Error(`已存在同标题同出发日期的旅行项目 ${tripId}；请改用 travel_project_read 读取，或更换标题/日期。`)
        }
        const days = buildDays(args.startDate, args.endDate)
        const now = new Date().toISOString()
        const currency = args.currency?.trim() ?? deps.currency
        const scenario: TripScenario = { id: 'main', title: '主方案', basedOnRevision: 0, days }
        const project: TripProject = {
          schemaVersion: CURRENT_TRIP_SCHEMA_VERSION,
          id: tripId,
          revision: 1,
          title: args.title,
          status: 'drafting',
          timezone: args.timezone?.trim() ?? deps.timezone,
          startDate: args.startDate,
          endDate: args.endDate,
          destinations: args.destinations,
          travelers: (args.travelers ?? []).map((traveler, index) => ({
            id: `traveler-${String(index + 1)}`,
            label: traveler.label,
            interests: traveler.interests ?? [],
            accessibilityNeeds: [],
          })),
          preferences: {
            pace: args.pace ?? 'balanced',
            interests: args.interests ?? [],
            avoid: args.avoid ?? [],
            preferredModes: ['transit', 'walking'],
          },
          constraints: [],
          places: {},
          scenarios: [scenario],
          activeScenarioId: scenario.id,
          budget: {
            currency,
            ...args.budgetLimit === undefined ? {} : { limit: args.budgetLimit },
          },
          alerts: [],
          createdAt: now,
          updatedAt: now,
        }
        await store.write(project)
        // A freshly created trip becomes the one this session works on, and the
        // workspace default too, so the sidebar follows the conversation.
        await service.select(sessionId, tripId, true)
        return {
          tripId,
          revision: project.revision,
          dayCount: days.length,
          days: days.map((day) => day.date),
          activeTripId: tripId,
        }
      },
    }),
  )

  register(
    defineTool({
      name: 'travel_project_list',
      description:
        'List every Trip Project in the current workspace with its dates, day count, readiness and alert counts, and say which one is active. Call this before switching trips or when the user refers to a trip by name instead of id.',
      parameters: {
        includeArchived: { type: 'boolean', description: '是否包含已归档（status=archived）的行程，默认 true。' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [jsonBlock(value)],
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.session.id
        const stats = await service.statsFor(sessionId)
        const selection = await service.selectTripId(sessionId)
        const trips = stats
          .filter((stat) => args.includeArchived !== false || stat.summary.status !== 'archived')
          .map((stat) => ({
            tripId: stat.summary.id,
            title: stat.summary.title,
            status: stat.summary.status,
            startDate: stat.summary.startDate,
            endDate: stat.summary.endDate,
            dayCount: stat.summary.durationDays,
            destinations: stat.summary.destinations,
            readiness: stat.readiness,
            alerts: stat.alerts,
            updatedAt: stat.summary.updatedAt,
            active: stat.summary.id === selection?.tripId,
          }))
        return asJson({
          count: trips.length,
          activeTripId: selection?.tripId,
          selectionSource: selection?.source,
          trips,
          ...trips.length === 0 ? { hint: '当前工作区还没有旅行项目，请调用 travel_project_create 建立第一个。' } : {},
        })
      },
    }),
  )

  register(
    defineTool({
      name: 'travel_project_select',
      description:
        'Make one Trip Project the active one for this session, so later calls without tripId operate on it. Use it when the user says "换到京都那个行程". Pass asDefault to also make it the workspace default that new sessions start from.',
      parameters: {
        tripId: { type: 'string', required: true, description: '要切换到的行程 id；可用 travel_project_list 取得。' },
        asDefault: { type: 'boolean', description: '是否同时设为工作区默认行程。' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [jsonBlock(value)],
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.session.id
        const activeTripId = await service.select(sessionId, args.tripId, args.asDefault === true)
        const project = await service.require(sessionId, activeTripId)
        return asJson({
          activeTripId,
          asDefault: args.asDefault === true,
          title: project.title,
          startDate: project.startDate,
          endDate: project.endDate,
          note: `当前行程已切换为「${project.title}」。`,
        })
      },
    }),
  )

  register(
    defineTool({
      name: 'travel_project_read',
      description:
        'Read the active Trip Project exactly as the user sees it in the travel sidebar: headline, days with items and transport legs, places, and alerts. Use this before editing.',
      parameters: {
        tripId: { type: 'string', description: '项目 id；省略时读取当前行程（会话选择 → 工作区默认 → 最近更新）。' },
        includePlaces: { type: 'boolean', description: '是否返回候选地点库，默认 true。' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [jsonBlock(value)],
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.session.id
        const stats = await service.statsFor(sessionId)
        const project = await service.resolve(sessionId, args.tripId)
        if (project === undefined) {
          return asJson({ exists: false, trips: stats.map((stat) => stat.summary), hint: '当前工作区还没有旅行项目，请先调用 travel_project_create。' })
        }
        const view = await service.view(sessionId, project.id)
        return asJson({
          exists: true,
          tripId: project.id,
          title: project.title,
          selectionSource: view.selectionSource,
          summary: service.summaryOf(project),
          candidates: stats.map((stat) => ({ tripId: stat.summary.id, title: stat.summary.title, updatedAt: stat.summary.updatedAt })),
          view: args.includePlaces === false ? { ...view, places: [] } : view,
        })
      },
    }),
  )

  register(
    defineTool({
      name: 'travel_project_patch',
      description:
        'Apply incrementally validated edits to the active Trip Project. Only unlocked items can be moved, retimed or removed. Pass expectedRevision from the last read to avoid overwriting concurrent edits.',
      parameters: {
        tripId: { type: 'string', description: '项目 id；省略时使用最近更新的项目。' },
        expectedRevision: { type: 'number', description: '期望的当前 revision；不匹配时整批拒绝。' },
        ops: {
          type: 'array',
          items: { type: 'json' },
          required: true,
          description: [
            '操作数组，每个元素是 {"kind":"…",…}，只认以下 kind：',
            '行程级：rename-trip{title}、set-status{status}、set-trip-dates{startDate,endDate?,redateDays?}',
            '（改行程日期；默认各天从 startDate 起按顺序顺延并同步改写时间块的日期，省略 endDate 时按天数自动算出，redateDays:false 只改行程级日期）、',
            'set-budget{currency?,limit?,estimatedTotal?,confirmedTotal?}、set-preferences{preferences}。',
            '地点库：add-place{place}、set-place-status{placeId,status}。',
            '单天时间块：add-item{dayId,item,afterItemId?}、remove-item{dayId,itemId}、move-item{dayId,itemId,afterItemId?}、',
            'set-item-lock{dayId,itemId,locked}、set-item-time{dayId,itemId,startAt?,endAt?,plannedDurationMinutes?}、set-day-title{dayId,title,areaLabel?}。',
            '交通段：set-leg{dayId,leg}、remove-leg{dayId,legId}。',
            '日期结构：add-day{day}、remove-day{dayId}、set-active-scenario{scenarioId}。',
            '例如 {"kind":"set-trip-dates","startDate":"2026-09-25"} 或 {"kind":"set-item-lock","dayId":"d1","itemId":"d1-i0","locked":true}。',
          ].join(''),
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [jsonBlock(value)],
      },
      async execute(args, exec) {
        const parsed = parsePatchOps(args.ops)
        if (parsed.ops.length === 0) {
          return asJson({ applied: [], rejected: [], violations: parsed.violations, changed: false })
        }
        try {
          const application = await service.patch(exec.agent?.session.id, args.tripId, parsed.ops, args.expectedRevision)
          const counts = countAlerts(application.validation.alerts)
          return asJson({
            tripId: application.project.id,
            revision: application.project.revision,
            applied: application.outcome.applied,
            rejected: application.outcome.rejected,
            violations: parsed.violations,
            changed: application.outcome.changed,
            readiness: application.validation.readiness,
            alerts: counts,
          })
        } catch (error) {
          if (error instanceof TripRevisionError) {
            return asJson({
              applied: [],
              changed: false,
              violations: parsed.violations,
              rejected: [{ index: -1, kind: 'batch', code: error.code, reason: error.message }],
              expectedRevision: error.expectedRevision,
              actualRevision: error.actualRevision,
            })
          }
          throw error
        }
      },
    }),
  )

  register(
    defineTool({
      name: 'travel_place_search',
      description:
        'Search places through the AMap CLI. Returns normalized candidates with GCJ-02 coordinates. Set add=true to store the returned candidates in the project place library.',
      parameters: {
        tripId: { type: 'string', description: '项目 id；省略时使用最近更新的项目。' },
        keyword: { type: 'string', required: true, description: '搜索关键词，例如「咖啡馆」「清水寺」。' },
        city: { type: 'string', description: '城市名；关键词搜索建议填写。' },
        centerLongitude: { type: 'number', description: '周边搜索中心经度。' },
        centerLatitude: { type: 'number', description: '周边搜索中心纬度。' },
        radiusMeters: { type: 'number', description: '周边搜索半径，单位米。' },
        limit: { type: 'number', description: '返回条数上限，默认 5。' },
        add: { type: 'boolean', description: '是否把结果写入项目地点库，默认 false。' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [jsonBlock(value)],
      },
      async execute(args, exec) {
        const gateway = requireGateway(service)
        const sessionId = exec.agent?.session.id
        const center =
          args.centerLongitude !== undefined && args.centerLatitude !== undefined
            ? { longitude: args.centerLongitude, latitude: args.centerLatitude, coordinateSystem: 'gcj02' as const }
            : undefined
        const outcome = await gateway.searchPlaces(
          {
            keyword: args.keyword,
            ...args.city === undefined ? {} : { city: args.city },
            ...center === undefined ? {} : { center },
            ...args.radiusMeters === undefined ? {} : { radiusMeters: args.radiusMeters },
            pageSize: Math.max(1, Math.min(25, Math.trunc(args.limit ?? 5))),
          },
          exec.signal,
        )
        const limit = Math.max(1, Math.trunc(args.limit ?? 5))
        const selected = outcome.places.slice(0, limit)
        let added: string[] = []
        if (args.add === true && selected.length > 0) {
          const application = await service.patch(
            sessionId,
            args.tripId,
            selected.map((place) => ({ kind: 'add-place' as const, place })),
          )
          added = selected.map((place) => place.id).filter((id) => application.project.places[id] !== undefined)
        }
        return asJson({
          keyword: outcome.keyword,
          total: outcome.total,
          fromCache: outcome.fromCache,
          places: selected.map((place) => ({
            id: place.id,
            name: place.name,
            address: place.address,
            categories: place.categories,
            longitude: place.point.longitude,
            latitude: place.point.latitude,
            ...place.telephone === undefined ? {} : { telephone: place.telephone },
            providerPlaceId: place.providerPlaceId ?? null,
          })),
          added,
        })
      },
    }),
  )

  register(
    defineTool({
      name: 'travel_place_refresh',
      description:
        'Fill in missing provider facts (photo, and phone when absent) for places that have none yet. Matches each place back to the provider by its stored POI id first, then by an exactly equal name. Pass placeId to look up one place only. Starts the AMap container when it is not running, which opens the AMap desktop window.',
      parameters: {
        tripId: { type: 'string', description: '项目 id；省略时使用当前行程。' },
        placeId: { type: 'string', description: '只补全这一个地点；省略时扫描地点库中所有缺照片的地点。' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [jsonBlock(value)],
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.session.id
        const refreshed = await service.refreshPlaceFacts(sessionId, args.tripId, {
          ...args.placeId === undefined ? {} : { placeId: args.placeId },
          ...exec.signal === undefined ? {} : { signal: exec.signal },
          // An explicit tool call may open the container; the sidebar's silent
          // lookups may not.
          allowStart: true,
        })
        return asJson({ ...refreshed, unmatched: [...refreshed.unmatched] })
      },
    }),
  )

  register(
    defineTool({
      name: 'travel_route_plan',
      description:
        'Plan one route through the AMap CLI between two places or coordinates. Use the result to fill transport legs; it is not persisted by this tool.',
      parameters: {
        from: { type: 'string', required: true, description: '起点地名或 "lng,lat"。' },
        to: { type: 'string', required: true, description: '终点地名或 "lng,lat"。' },
        mode: { type: 'string', enum: ['walking', 'transit', 'riding', 'driving'], required: true },
        city: { type: 'string', description: '公交路线必填的城市名。' },
        fromName: { type: 'string', description: '起点显示名称。' },
        toName: { type: 'string', description: '终点显示名称。' },
        waypoints: { type: 'array', items: { type: 'string' }, description: '驾车途经点，最多 16 个。' },
        includeSteps: { type: 'boolean', description: '是否返回逐段导航文字，默认 false。' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [jsonBlock(value)],
      },
      async execute(args, exec) {
        const gateway = requireGateway(service)
        const fact = await gateway.planRoute(
          {
            from: args.from,
            to: args.to,
            mode: args.mode,
            ...args.city === undefined ? {} : { city: args.city },
            ...args.fromName === undefined ? {} : { fromName: args.fromName },
            ...args.toName === undefined ? {} : { toName: args.toName },
            ...args.waypoints === undefined ? {} : { waypoints: args.waypoints },
          },
          exec.signal,
        )
        return asJson({
          mode: fact.mode,
          distanceMeters: fact.distanceMeters,
          durationSeconds: fact.durationSeconds,
          ...fact.tollsYuan === undefined ? {} : { tollsYuan: fact.tollsYuan },
          from: fact.from,
          to: fact.to,
          fetchedAt: fact.fetchedAt,
          fromCache: fact.fromCache,
          steps: args.includeSteps === true ? fact.steps : [],
        })
      },
    }),
  )

  register(
    defineTool({
      name: 'travel_day_rebuild_legs',
      description:
        'Rebuild every transport leg of one day by querying the AMap CLI for each consecutive pair of placed items, then persist the legs. Locked items keep their position, so their legs are rebuilt too.',
      parameters: {
        tripId: { type: 'string', description: '项目 id；省略时使用当前行程（会话选择 → 工作区默认 → 最近更新）。' },
        dayId: { type: 'string', required: true, description: '目标日期 id，例如 d1。' },
        mode: { type: 'string', enum: ['walking', 'transit', 'riding', 'driving'], description: '出行方式；默认取项目偏好。' },
        city: { type: 'string', description: '公交路线必填的城市名。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dayId: { type: 'string' },
            legs: { type: 'number' },
            totalDistanceMeters: { type: 'number' },
            totalDurationSeconds: { type: 'number' },
            skipped: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `已重建 ${value.dayId ?? ''} 的 ${String(value.legs ?? 0)} 段交通，总里程 ${String(Math.round((value.totalDistanceMeters ?? 0) / 100) / 10)} km。` },
        ],
      },
      async execute(args, exec) {
        // One implementation serves this tool and the sidebar's rebuild action.
        const sessionId = exec.agent?.session.id
        const project = await service.require(sessionId, args.tripId)
        const rebuilt = await service.rebuildDayLegs(sessionId, project.id, args.dayId, {
          ...args.mode === undefined ? {} : { mode: args.mode },
          ...args.city === undefined ? {} : { city: args.city },
          ...exec.signal === undefined ? {} : { signal: exec.signal },
        })
        return { ...rebuilt, skipped: [...rebuilt.skipped] }
      },
    }),
  )

  register(
    defineTool({
      name: 'travel_day_set_transit',
      description:
        'Record how one day changes city: a transit with its two ends, distance, duration and path. Use it for days that are nothing but driving — a transit day needs no stop and no place, and its ends may be library place ids or plain names. By default the road is planned through AMap (the Web-service API when a key is configured, otherwise the CLI, which answers on a running container) and the distance and duration you pass are ignored; pass plan:false to keep those numbers instead, e.g. the 723 km a day title states.',
      parameters: {
        tripId: { type: 'string', description: '项目 id；省略时使用当前行程（会话选择 → 工作区默认 → 最近更新）。' },
        dayId: { type: 'string', required: true, description: '目标日期 id，例如 d1。' },
        fromPlaceId: { type: 'string', description: '起点地点 id（有坐标）。' },
        fromLabel: { type: 'string', description: '起点名称，例如「西安」；没有地点时使用。' },
        toPlaceId: { type: 'string', description: '终点地点 id（有坐标）。' },
        toLabel: { type: 'string', description: '终点名称，例如「成都」。' },
        mode: { type: 'string', enum: ['walking', 'transit', 'riding', 'driving'], description: '出行方式，默认驾车。' },
        departAt: { type: 'string', description: '出发时刻（ISO 8601）；省略时取当天第一站的开始时间。' },
        distanceMeters: { type: 'number', description: '已知里程（米）；仅在无法规划时写入。' },
        durationSeconds: { type: 'number', description: '已知时长（秒）；仅在无法规划时写入。' },
        plan: { type: 'boolean', description: '是否向高德要真实路线，默认 true。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dayId: { type: 'string' },
            transitId: { type: 'string' },
            distanceMeters: { type: 'number' },
            durationSeconds: { type: 'number' },
            planned: { type: 'boolean' },
            polyline: { type: 'boolean' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `${value.planned === true ? '已按真实路网写入' : '已记为待重算的转场'}：${value.dayId ?? ''} ${String(
                Math.round((value.distanceMeters ?? 0) / 100) / 10,
              )} km${value.planned === true && value.polyline === true ? '，含真实路径' : ''}。`,
          },
        ],
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.session.id
        const project = await service.require(sessionId, args.tripId)
        const written = await service.setDayTransit(sessionId, project.id, args.dayId, {
          from: {
            ...args.fromPlaceId === undefined ? {} : { placeId: args.fromPlaceId },
            ...args.fromLabel === undefined ? {} : { label: args.fromLabel },
          },
          to: {
            ...args.toPlaceId === undefined ? {} : { placeId: args.toPlaceId },
            ...args.toLabel === undefined ? {} : { label: args.toLabel },
          },
          ...args.mode === undefined ? {} : { mode: args.mode },
          ...args.departAt === undefined ? {} : { departAt: args.departAt },
          ...args.distanceMeters === undefined ? {} : { distanceMeters: args.distanceMeters },
          ...args.durationSeconds === undefined ? {} : { durationSeconds: args.durationSeconds },
          ...args.plan === undefined ? {} : { plan: args.plan },
          ...exec.signal === undefined ? {} : { signal: exec.signal },
        })
        return { ...written }
      },
    }),
  )

  register(
    defineTool({
      name: 'travel_itinerary_validate',
      description:
        'Run deterministic validation over the active Trip Project: time overlaps, missing or stale transport, day overload, budget and fact staleness. Run this before telling the user a plan is ready.',
      parameters: {
        tripId: { type: 'string', description: '项目 id；省略时使用最近更新的项目。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tripId: { type: 'string' },
            revision: { type: 'number' },
            readiness: { type: 'number' },
            errors: { type: 'number' },
            warnings: { type: 'number' },
            infos: { type: 'number' },
            alerts: { type: 'array', items: { type: 'json' } },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `就绪度 ${String(Math.round((value.readiness ?? 0) * 100))}%：阻塞 ${String(value.errors ?? 0)}，警告 ${String(value.warnings ?? 0)}，提示 ${String(value.infos ?? 0)}。`,
          },
        ],
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.session.id
        const project = await service.require(sessionId, args.tripId)
        const validation = service.validate(project)
        await service.storeAlerts(project, validation.alerts, sessionId)
        const counts = countAlerts(validation.alerts)
        return {
          tripId: project.id,
          revision: project.revision,
          readiness: validation.readiness,
          errors: counts.error,
          warnings: counts.warning,
          infos: counts.info,
          alerts: previewAlerts(validation.alerts),
        }
      },
    }),
  )

  register(
    defineTool({
      name: 'travel_project_export',
      description: 'Export the active Trip Project as Markdown or JSON inside its exports directory.',
      parameters: {
        tripId: { type: 'string', description: '项目 id；省略时使用最近更新的项目。' },
        format: { type: 'string', enum: ['markdown', 'json'], required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { tripId: { type: 'string' }, path: { type: 'string' }, format: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: `已导出 ${value.format}：${value.path}` }],
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.session.id
        const project = await service.require(sessionId, args.tripId)
        const path = await service.exportTrip(project, args.format, sessionId)
        return { tripId: project.id, path, format: args.format }
      },
    }),
  )

  register(
    defineTool({
      name: 'travel_map_focus',
      description:
        'Ask the shared AMap container to show a location or one day of the trip, so the user can inspect it on the AMap map surface.',
      parameters: {
        tripId: { type: 'string', description: '项目 id；省略时使用最近更新的项目。' },
        dayId: { type: 'string', description: '要居中显示的日期 id。' },
        longitude: { type: 'number', description: '显式经度，优先于 dayId。' },
        latitude: { type: 'number', description: '显式纬度，优先于 dayId。' },
        zoom: { type: 'number', description: '缩放级别 3-20。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            focused: { type: 'boolean' },
            longitude: { type: 'number' },
            latitude: { type: 'number' },
            dayId: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `地图已定位到 ${String(value.longitude)},${String(value.latitude)}${value.dayId === '' ? '' : `（${value.dayId}）`}。` },
        ],
      },
      async execute(args, exec) {
        const gateway = requireGateway(service)
        const sessionId = exec.agent?.session.id
        let center: { longitude: number; latitude: number } | undefined
        let dayId = ''
        if (args.longitude !== undefined && args.latitude !== undefined) {
          center = { longitude: args.longitude, latitude: args.latitude }
        } else {
          const project = await service.require(sessionId, args.tripId)
          const day = args.dayId === undefined ? undefined : findDay(project, args.dayId)
          const points = (day?.items ?? [])
            .map((item) => project.places[item.placeId]?.point)
            .filter((point): point is NonNullable<typeof point> => point !== undefined)
          if (points.length > 0) {
            center = {
              longitude: points.reduce((sum, point) => sum + point.longitude, 0) / points.length,
              latitude: points.reduce((sum, point) => sum + point.latitude, 0) / points.length,
            }
            dayId = day?.id ?? ''
          } else {
            throw new Error('无法定位：该日期没有带坐标的地点，请提供 longitude/latitude。')
          }
        }
        await gateway.focusMap(
          { center: { ...center, coordinateSystem: 'gcj02' }, ...args.zoom === undefined ? {} : { zoom: args.zoom } },
          exec.signal,
        )
        return { focused: true, longitude: center.longitude, latitude: center.latitude, dayId }
      },
    }),
  )
}

/** Build one day per date in the inclusive range, capped at 30 days. */
function buildDays(startDate: string, endDate: string): readonly TripDay[] {
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = Date.parse(`${endDate}T00:00:00Z`)
  const totalDays = Number.isNaN(start) || Number.isNaN(end) ? 1 : Math.min(30, Math.max(1, Math.round((end - start) / 86_400_000) + 1))
  return Array.from({ length: totalDays }, (_, index) => {
    const date = addDays(startDate, index)
    return { id: `d${String(index + 1)}`, date, title: `Day ${String(index + 1)}`, items: [], legs: [] }
  })
}

/** Find one day of the active scenario. */
function findDay(project: TripProject, dayId: string): TripDay {
  const scenario = project.scenarios.find((entry) => entry.id === project.activeScenarioId)
  const day = scenario?.days.find((entry) => entry.id === dayId)
  if (day === undefined) {
    const known = (scenario?.days ?? []).map((entry) => entry.id).join(', ')
    throw new Error(`找不到日期 "${dayId}"；当前可用日期：${known === '' ? '（无）' : known}。`)
  }
  return day
}

/** Resolve the gateway or explain how to enable it. */
function requireGateway(service: TravelService): AmapGateway {
  const gateway = service.amap
  if (gateway === undefined) {
    throw new Error('高德 CLI 不可用：当前 profile 未提供 subprocess 服务。请检查插件配置与 profile 组合。')
  }
  return gateway
}

/** Render a JSON value as a tool text block. */
function jsonBlock(value: JsonValue): { readonly type: 'text'; readonly text: string } {
  const text = JSON.stringify(value, null, 2) ?? 'null'
  return { type: 'text', text: text.length > 16_000 ? `${text.slice(0, 16_000)}\n…（已截断）` : text }
}

/** Present an owned object at the lossless-JSON tool boundary. */
function asJson(value: unknown): JsonValue {
  return value as JsonValue
}

/** Keep tool output bounded while preserving the most severe alerts. */
function previewAlerts(alerts: readonly TripAlert[]): JsonValue[] {
  return alerts.slice(0, ALERT_PREVIEW_LIMIT).map((alert) => asJson({
    id: alert.id,
    severity: alert.severity,
    code: alert.code,
    message: alert.message,
    relatedIds: alert.relatedIds,
    suggestedActions: alert.suggestedActions,
  }))
}

/** Re-export used by the day-leg builder to keep item ids stable. */
export { itemIdFor }

/** Thrown errors that should reach the model as guidance rather than a stack. */
export const TRAVEL_TOOL_ERRORS = [TripStoreError, AmapCliError] as const
