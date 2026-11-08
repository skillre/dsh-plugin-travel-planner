import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientContext, SidebarRightTabDefinitionLike } from './contracts'
import type {
  AmapRuntimeView,
  DayView,
  ItemView,
  LegView,
  MapView,
  PlaceView,
  TravelPatchResponse,
  TravelSelectResponse,
  TravelStateResponse,
  TravelView,
  TransitView,
  TripSummaryView,
} from '../shared/view'

declare global {
  interface Window {
    /** Host-injected runtime facts; absent when the host did not tap the index. */
    __SKILLRE_TRAVEL__?: { readonly apiPath?: string }
    /** AMap's official JS API loader, present once the script below has run. */
    AMapLoader?: {
      load(options: {
        readonly key: string
        readonly version: string
        readonly plugins?: readonly string[]
      }): Promise<AmapNamespace>
    }
  }
}

/** Minimal AMap JS API surface this panel uses. */
interface AmapNamespace {
  readonly Map: new (container: HTMLElement, options: Record<string, unknown>) => AmapMap
  readonly Marker: new (options: Record<string, unknown>) => AmapMarker
  readonly Polyline: new (options: Record<string, unknown>) => AmapPolyline
}
interface AmapMap {
  on(event: string, handler: () => void): void
  getZoom(): number
  destroy(): void
  add(overlays: readonly unknown[]): void
  remove(overlays: readonly unknown[]): void
  setFitView(overlays?: readonly unknown[], immediately?: boolean, avoid?: readonly number[]): void
  setZoomAndCenter(zoom: number, center: readonly [number, number], immediately?: boolean): void
}
interface AmapMarker {
  on(event: string, handler: () => void): void
}
interface AmapPolyline {
  setPath(path: readonly (readonly [number, number])[]): void
}

/** One located stop of the active day. */
interface LocatedStop {
  readonly placeId: string
  /** Place name, kept so a map marker has something to announce. */
  readonly name?: string
  readonly point: { readonly longitude: number; readonly latitude: number }
}

/** This implementation's identity in the sidebar tab system. */
const PLUGIN_ID = '@skillre/dsh-plugin-travel-planner'
/** Page kind opened through `ctx.sidebarRight.openTab`. */
const TAB_KIND = 'skillre-travel'
/** Fallback API prefix when the host did not inject one. */
const DEFAULT_API_PATH = '/api/skillre-travel'
/** AMap script that exposes `window.AMapLoader`. */
const AMAP_LOADER_SRC = 'https://webapi.amap.com/loader.js'
/** How long the panel waits for the AMap loader before falling back. */
const AMAP_LOAD_TIMEOUT_MS = 6_000
/** Narrowest pane that still gets the two-column presentation. */
const WIDE_PANE_QUERY = '@container (min-width: 560px)'
/**
 * A pane wide enough for two zones: a reading column and a companion column.
 *
 * Chosen so a 1332px pane (a maximised window) still fits the map beside the
 * itinerary, while anything narrower keeps the single-column shape.
 */
const SIDE_COLUMN_QUERY = '@container (min-width: 1080px)'

/**
 * A pane wide enough for three zones: itinerary, map, day list.
 *
 * The map's box has to match the shape of the route, and a north-south driving
 * trip is about as tall as it is wide: this one spans 16.3° of longitude and
 * 15.1° of latitude, i.e. 0.92:1 once projected. A 593px-wide map at 205px tall
 * is 2.8:1, so fitting that route into it shows 82° of longitude — measured on
 * the live pane, the whole-trip map ran from Iran to Japan with the journey as
 * a small blob in the middle. Three zones give the map a column it can fill
 * vertically, which is the only way the route itself can fill the frame.
 */
const THREE_COLUMN_QUERY = '@container (min-width: 1240px)'

/**
 * Standard props every session-scoped body receives.
 *
 * `sidebar.right.pane.tab` also injects a `useTabInfo` selector hook, which
 * this body deliberately does not use: a registered body may abdicate if it
 * throws during a render, and misusing that hook is a whole-panel failure for
 * a layout detail. The panel reads its own width through a CSS container query
 * instead, which needs no runtime contract and also adapts when the user only
 * widens the docked Sidebar.
 */
interface BodyProps {
  readonly sessionId?: string
  /** Present at runtime; typed loosely because the body never reads it. */
  readonly useTabInfo?: unknown
  /** Composer actions injected by the slot; the only way this panel hands work to the Agent. */
  readonly inputActions?: InputActionsLike
}

/**
 * The composer face the slot injects (`dsh-client-ui-conversation`
 * `contract/input.d.ts`). The panel uses it to seed an editable instruction —
 * it never sends anything on its own.
 */
interface InputActionsLike {
  setDraft(text: string): void
  submit(): void
}

/** Which secondary surface covers the panel. */
type OverlayKey = 'places' | 'alerts' | 'about'

/** How tall the map card is. */
type MapTier = 'compact' | 'comfortable' | 'full'

/** Whether the map shows one day or the whole trip. */
type MapRange = 'day' | 'all'

/** Tallest-to-shortest cycle for the size button. */
const MAP_TIERS: readonly MapTier[] = ['compact', 'comfortable', 'full']

/** From this zoom on, a whole-trip map has room to name its stops. */
const PIN_NAME_ZOOM = 6
/** At or below this many stops the names are drawn whatever the zoom is. */
const PIN_NAME_MAX_STOPS = 10

/** How close the map comes to a place the reader picked, when it is further out. */
const FOCUS_ZOOM = 14

/** 地图左下角那句话：点位与三种线型各自是什么意思。 */
const MAP_LEGEND = '点位为真实坐标 · 细虚线=当天顺序 · 实线=已规划路线 · 长虚线=按标题估算'

/** Local UI preferences; never written into the versioned trip document. */
const UI_PREF_KEY = 'skillre-travel:ui'

/** Read one stored UI preference. */
function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback
  try {
    const stored = JSON.parse(localStorage.getItem(UI_PREF_KEY) ?? '{}') as Record<string, unknown>
    const value = stored[key]
    return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
  } catch {
    return fallback
  }
}

/** Read one stored numeric UI preference, clamped into a sane range. */
function readSize(key: string, fallback: number, min: number, max: number): number {
  if (typeof localStorage === 'undefined') return fallback
  try {
    const stored = JSON.parse(localStorage.getItem(UI_PREF_KEY) ?? '{}') as Record<string, unknown>
    const value = stored[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.round(value)))
  } catch {
    return fallback
  }
}

/** Store one UI preference. */
function writePref(key: string, value: string | number): void {
  if (typeof localStorage === 'undefined') return
  try {
    const stored = JSON.parse(localStorage.getItem(UI_PREF_KEY) ?? '{}') as Record<string, unknown>
    localStorage.setItem(UI_PREF_KEY, JSON.stringify({ ...stored, [key]: value }))
  } catch {
    // A full or unavailable store must never break the panel.
  }
}

/**
 * Register the travel page tab: its type, its body, and its live title.
 * @param ctx - client root context carrying the slot registry and tab registry.
 */
export function apply(ctx: Context): void {
  const client = ctx as unknown as ClientContext
  const definition: SidebarRightTabDefinitionLike = {
    id: PLUGIN_ID,
    kind: TAB_KIND,
    priority: 'extension',
    title: () => '行程',
    guide: [
      {
        order: 40,
        title: () => '旅行行程',
        description: () => '在地图上查看逐日路线、地点卡片与提醒',
      },
    ],
  }
  ctx.effect(() => client.sidebarRightTabs.register(definition), 'travel-planner: tab type')
  ctx.effect(
    () => client.slots.inject('sidebar.right.pane.tab', () => client.slots.register({ name: 'sidebar.right.pane.tab', key: PLUGIN_ID }, TravelBody)),
    'travel-planner: tab body',
  )
  ctx.effect(
    () => client.slots.inject('sidebar.right.pane.tab.title', () => client.slots.register({ name: 'sidebar.right.pane.tab.title', key: PLUGIN_ID }, TravelTitle)),
    'travel-planner: tab title',
  )
}

/** Required browser services. */
export const inject = ['slots', 'sidebarRightTabs']

/** Resolve the API prefix the host injected. */
function apiPath(): string {
  if (typeof window === 'undefined') return DEFAULT_API_PATH
  const injected = window.__SKILLRE_TRAVEL__?.apiPath
  return typeof injected === 'string' && injected !== '' ? injected : DEFAULT_API_PATH
}

/** Live tab title: the trip name once data arrives, otherwise the static label. */
function TravelTitle(props: BodyProps): ReactElement {
  const state = useTravelState(props, false)
  return createElement('span', null, state.view?.headline?.title ?? '行程')
}

/**
 * The travel panel body: acquire the trip state, then present it.
 * @param props - standard session-scoped body props.
 */
function TravelBody(props: BodyProps): ReactElement {
  const state = useTravelState(props, true)
  const view = state.view

  const onMutate = useCallback(
    async (ops: readonly unknown[]): Promise<void> => {
      if (view === undefined || view.headline === null) return
      const response = await fetch(`${apiPath()}/patch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: props.sessionId,
          tripId: view.headline.tripId,
          expectedRevision: view.headline.revision,
          ops,
        }),
      })
      const payload = (await response.json()) as TravelPatchResponse
      if (payload.ok !== true) throw new Error(payload.error ?? '修改未生效。')
      if (payload.changed !== true) {
        throw new Error(payload.rejected?.[0]?.reason ?? '没有可应用的修改。')
      }
      await state.refresh()
    },
    [props.sessionId, state, view],
  )

  const onFocusDay = useCallback(
    async (dayId: string): Promise<void> => {
      if (view === undefined || view.headline === null) return
      await fetch(`${apiPath()}/focus`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, tripId: view.headline.tripId, dayId }),
      })
    },
    [props.sessionId, view],
  )

  const onAskAgent = useCallback(
    (text: string): void => {
      props.inputActions?.setDraft(text)
    },
    [props.inputActions],
  )

  const onReorder = useCallback(
    async (dayId: string, order: readonly string[]): Promise<void> => {
      if (view === undefined || view.headline === null) return
      const response = await fetch(`${apiPath()}/reflow-day`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: props.sessionId,
          tripId: view.headline.tripId,
          dayId,
          order,
          expectedRevision: view.headline.revision,
        }),
      })
      const payload = (await response.json()) as TravelPatchResponse
      if (payload.ok !== true) throw new Error(payload.error ?? '重排失败。')
      if (payload.changed !== true) {
        throw new Error(payload.rejected?.[0]?.reason ?? '顺序没有变化。')
      }
      await state.refresh()
    },
    [props.sessionId, state, view],
  )

  const onRebuildLegs = useCallback(
    async (dayId: string): Promise<number> => {
      if (view === undefined || view.headline === null) return 0
      const response = await fetch(`${apiPath()}/rebuild-legs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, tripId: view.headline.tripId, dayId }),
      })
      const payload = (await response.json()) as { readonly ok?: boolean; readonly legs?: number; readonly error?: string }
      if (payload.ok !== true) throw new Error(payload.error ?? '重算交通失败。')
      await state.refresh()
      return payload.legs ?? 0
    },
    [props.sessionId, state, view],
  )

  const onFillTransits = useCallback(
    async (dayId?: string): Promise<{ readonly planned: number; readonly skipped: number }> => {
      if (view === undefined || view.headline === null) return { planned: 0, skipped: 0 }
      const response = await fetch(`${apiPath()}/fill-transits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: props.sessionId,
          tripId: view.headline.tripId,
          // 不带 dayId 就是「把所有只有标题的赶路日都补上」，正是面板那一个按钮的意思。
          ...dayId === undefined ? {} : { dayId },
        }),
      })
      // 老宿主没有这条路由，回答的是一页 HTML 而不是 JSON：解析失败会落到下面的
      // `payload.ok !== true`，按钮位置显示一句「补全路线失败。」——页面照常可用，
      // 不会整块报错，也不会假装补全成功。
      const payload = (await response.json().catch(() => ({}))) as {
        readonly ok?: boolean
        readonly planned?: number
        readonly skipped?: number
        readonly error?: string
      }
      if (payload.ok !== true) throw new Error(payload.error ?? '补全路线失败。')
      await state.refresh()
      return { planned: payload.planned ?? 0, skipped: payload.skipped ?? 0 }
    },
    [props.sessionId, state, view],
  )

  const onRefreshPlaces = useCallback(
    async (placeId?: string, start = false): Promise<{ readonly checked: number; readonly updated: number; readonly needsStart: boolean }> => {
      if (view === undefined || view.headline === null) return { checked: 0, updated: 0, needsStart: false }
      const response = await fetch(`${apiPath()}/refresh-places`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: props.sessionId,
          tripId: view.headline.tripId,
          ...placeId === undefined ? {} : { placeId },
          // Only an explicit click asks for the AMap window to be opened.
          ...start ? { start: true } : {},
        }),
      })
      const payload = (await response.json()) as {
        readonly ok?: boolean
        readonly checked?: number
        readonly updated?: number
        readonly needsStart?: boolean
        readonly error?: string
      }
      if (payload.ok !== true) throw new Error(payload.error ?? '补全地点信息失败。')
      await state.refresh()
      return {
        checked: payload.checked ?? 0,
        updated: payload.updated ?? 0,
        needsStart: payload.needsStart === true,
      }
    },
    [props.sessionId, state, view],
  )

  const onSelectTrip = useCallback(
    async (tripId: string, asDefault = false): Promise<void> => {
      const response = await fetch(`${apiPath()}/select`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, tripId, asDefault }),
      })
      const payload = (await response.json()) as TravelSelectResponse
      if (payload.ok !== true) throw new Error(payload.error ?? '切换行程失败。')
      await state.refresh()
    },
    [props.sessionId, state],
  )

  if (state.loading && view === undefined) {
    return panelShell(true, createElement(Skeleton, null))
  }
  if (view === undefined || view.headline === null) {
    return panelShell(
      true,
      createElement(
        'div',
        { className: 'trv-empty' },
        createElement('div', { className: 'trv-empty-title' }, '还没有旅行项目'),
        createElement('div', { className: 'trv-empty-body' }, '在对话中描述你的目的地、日期和偏好，Agent 会建立可编辑的行程。'),
        state.error === undefined ? null : createElement('div', { className: 'trv-error' }, state.error),
      ),
    )
  }

  return createElement(TravelPanel, {
    view,
    sessionId: props.sessionId,
    amapReady: state.amap?.status === 'running' && state.amap.mapReady,
    onMutate,
    onFocusDay,
    onSelectTrip,
    onAskAgent,
    onReorder,
    onRebuildLegs,
    onFillTransits,
    onRefreshPlaces,
    error: state.error,
  })
}

/** Everything the panel needs to present one resolved trip. */
export interface TravelPanelProps {
  /** The resolved trip view; never a live Host object. */
  readonly view: TravelView
  /** Session the actions address, when the slot provided one. */
  readonly sessionId?: string | undefined
  /** Apply one patch batch; rejects with a user-facing message. */
  readonly onMutate: (ops: readonly unknown[]) => Promise<void>
  /** Ask the AMap container to show one day. */
  readonly onFocusDay: (dayId: string) => Promise<void>
  /** Switch the trip this session works on. */
  readonly onSelectTrip: (tripId: string, asDefault?: boolean) => Promise<void>
  /** Seed the composer with an instruction for the Agent; never sends it. */
  readonly onAskAgent: (text: string) => void
  /** Re-order one day; the Host re-times it and persists both. */
  readonly onReorder: (dayId: string, order: readonly string[]) => Promise<void>
  /** Recompute one day's transport through the AMap CLI; resolves with the leg count. */
  readonly onRebuildLegs: (dayId: string) => Promise<number>
  /**
   * 把「只有标题」的赶路日交给高德规划并落盘；不带 `dayId` 就是全部。
   *
   * 可选，因为客户端与宿主的升级不同步：老宿主没有这条路由，此时面板不显示入口，
   * 而不是给出一个必然失败的按钮。
   */
  readonly onFillTransits?: ((dayId?: string) => Promise<{ readonly planned: number; readonly skipped: number }>) | undefined
  /**
   * Look up missing photos and contact details, for the whole library or one
   * place. `start` is the caller's explicit consent to open the AMap window
   * when the container is down; without it a cold container is left alone.
   */
  readonly onRefreshPlaces: (placeId?: string, start?: boolean) => Promise<{
    readonly checked: number
    readonly updated: number
    readonly needsStart: boolean
  }>
  /** Whether the AMap container is already running and able to answer. */
  readonly amapReady: boolean
  /** Last refresh failure, shown inline without discarding loaded data. */
  readonly error?: string | undefined
}

/**
 * Present one resolved trip: header, map, day pager and timeline.
 * Pure data-in/markup-out, so the loaded state is directly renderable.
 * @param props - resolved view plus the host actions.
 */
export function TravelPanel(props: TravelPanelProps): ReactElement {
  const view = props.view
  const [activeDayId, setActiveDayId] = useState<string | undefined>(undefined)
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | undefined>(undefined)
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(undefined)
  const [overlay, setOverlay] = useState<OverlayKey | undefined>(undefined)
  const [menuOpen, setMenuOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [reorder, setReorder] = useState<{ readonly dayId: string; readonly estimated: boolean } | undefined>(undefined)
  const [transportSheet, setTransportSheet] = useState(false)
  const [mapTier, setMapTier] = useState<MapTier>(() => readPref('mapTier', MAP_TIERS, 'compact'))
  const [mapRange, setMapRange] = useState<MapRange>(() => readPref('mapRange', ['day', 'all'], 'day'))
  /** The scrolling itinerary, and the day sections it holds. */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sections = useRef(new Map<string, HTMLElement>())
  const spyFrame = useRef<number | undefined>(undefined)
  /** Mirrors the active day for the scroll listener, which outlives a render. */
  const activeDayRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    activeDayRef.current = activeDayId
  }, [activeDayId])

  useEffect(() => {
    writePref('mapTier', mapTier)
  }, [mapTier])
  useEffect(() => {
    writePref('mapRange', mapRange)
  }, [mapRange])

  const run = useCallback(
    async (action: () => Promise<void>, success?: string): Promise<void> => {
      setBusy(true)
      setNotice(undefined)
      try {
        await action()
        if (success !== undefined) setNotice(success)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  /**
   * One click for every day that only states its hop.
   *
   * 走的是宿主自己的路由，不经过模型：五天就是五次手动操作，那正是这个按钮要省掉的。
   * 结果用面板既有的 notice 机制报出来，进行中则由 busy 挡住第二次点击。
   */
  const fillTransits = useCallback((): void => {
    const fill = props.onFillTransits
    if (fill === undefined) return
    void run(async () => {
      const result = await fill()
      setNotice(fillReport(result.planned, result.skipped))
    })
  }, [props.onFillTransits, run])

  const headline = view.headline
  if (headline === null) return panelShell(true, createElement('div', { className: 'trv-empty' }, '还没有旅行项目'))

  const days = view.days
  const transfers = useMemo(() => buildTransfers(days), [days])
  // 只有标题的赶路日：标题声明了跨城，当天既没有转场也没有一段算数的 leg。它们正是
  // 「补全 N 天路线」要处理的那几天，按钮的 N 就是这里的长度。
  const pendingFillDays = useMemo(
    () => days.filter((day) => hasUnrecordedTransfer(day)).map((day) => day.id),
    [days],
  )
  const activeDay = days.find((day) => day.id === activeDayId) ?? todayIn(days) ?? days[0]

  const selectPlace = (placeId: string | undefined, itemId?: string): void => {
    setSelectedPlaceId(placeId)
    setSelectedItemId(placeId === undefined ? undefined : itemId)
  }
  /** Remember one day's section so the rail can scroll to it. */
  const attachSection = useCallback((dayId: string, node: HTMLElement | null): void => {
    if (node === null) sections.current.delete(dayId)
    else sections.current.set(dayId, node)
  }, [])

  /**
   * Follow the scroll: the day whose head sits at the top of the pane is the
   * current one, which is what the rail highlights and the map emphasises.
   * Throttled to one read per frame, and done by hand rather than with
   * `scrollIntoView`, which would also move the pane itself.
   */
  const onScrollSpy = useCallback((): void => {
    if (spyFrame.current !== undefined) return
    spyFrame.current = window.requestAnimationFrame(() => {
      spyFrame.current = undefined
      const container = scrollRef.current
      if (container === null) return
      const line = container.getBoundingClientRect().top + 18
      let current: string | undefined
      for (const [dayId, node] of sections.current) {
        if (node.getBoundingClientRect().top <= line) current = dayId
      }
      if (current !== undefined && current !== activeDayRef.current) setActiveDayId(current)
    })
  }, [])

  /** Make one day current and bring its section to the top of the pane. */
  const jumpToDay = useCallback((dayId: string): void => {
    setActiveDayId(dayId)
    const container = scrollRef.current
    const node = sections.current.get(dayId)
    if (container === null || node === undefined) return
    const delta = node.getBoundingClientRect().top - container.getBoundingClientRect().top
    container.scrollTo({ top: container.scrollTop + delta - 2, behavior: 'smooth' })
  }, [])

  return panelShell(
    false,
    createElement('style', null, STYLES),
    createElement(
      'div',
      { className: 'trv-root' },
      createElement(Header, {
        view,
        switcherOpen,
        menuOpen,
        busy,
        setSwitcherOpen,
        setMenuOpen,
        onSelectTrip: async (tripId, asDefault) => {
          setSwitcherOpen(false)
          await run(() => props.onSelectTrip(tripId, asDefault), '已切换行程。')
        },
        onFocusMap: () => {
          setMenuOpen(false)
          void run(
            () => (activeDay === undefined ? Promise.resolve() : props.onFocusDay(activeDay.id)),
            '已请求高德地图容器定位到当天行程。',
          )
        },
        onOpenOverlay: (key) => {
          setMenuOpen(false)
          setOverlay(key)
        },
      }),
      switcherOpen || menuOpen
        ? createElement('div', {
            className: 'trv-scrim',
            onClick: () => {
              setSwitcherOpen(false)
              setMenuOpen(false)
            },
          })
        : null,
      createElement(MetaRow, {
        view,
        busy,
        amapReady: props.amapReady,
        refreshPhotos: async (start = false) => {
          let result: { readonly checked: number; readonly updated: number; readonly needsStart: boolean } = {
            checked: 0,
            updated: 0,
            needsStart: false,
          }
          await run(async () => {
            result = await props.onRefreshPlaces(undefined, start)
          })
          return result
        },
        report: setNotice,
      }),
      activeDay === undefined
        ? createElement('div', { className: 'trv-empty' }, '这个方案还没有日期。')
        : createElement(
            'div',
            { className: 'trv-body' },
            // One continuous scroll from the first day to the last: the whole
            // trip is one document, and the day rail is its table of contents.
            createElement(
              'div',
              { className: 'trv-col-main', ref: scrollRef, onScroll: onScrollSpy },
              ...days.flatMap((day, index) => {
                const transfer = transfers[index - 1]
                return [
                  createElement(DaySection, {
                    key: day.id,
                    day,
                    index,
                    total: days.length,
                    transfer,
                    view,
                    busy,
                    selectedItemId: activeDay.id === day.id ? selectedItemId : undefined,
                    reorder,
                    attach: attachSection,
                    mutate: (ops) => run(() => props.onMutate(ops)),
                    select: selectPlace,
                    reorderDay: (order) =>
                      run(async () => {
                        await props.onReorder(day.id, order)
                        setReorder({ dayId: day.id, estimated: true })
                      }),
                    rebuild: () =>
                      run(async () => {
                        await props.onRebuildLegs(day.id)
                        setReorder({ dayId: day.id, estimated: false })
                      }, '已用高德真实路网重算这一天的交通。'),
                    onOpenTransport: () => {
                      setActiveDayId(day.id)
                      setTransportSheet(true)
                    },
                    onOpenAlerts: () => setOverlay('alerts'),
                    onAskAgent: props.onAskAgent,
                    onLater: () => setReorder(undefined),
                  }),
                ]
              }),
            ),
            // The map and the day list share one companion column: above the
            // itinerary while the pane is narrow, beside it once there is room —
            // where it stays put while the itinerary scrolls.
            createElement(
              'div',
              { className: 'trv-side' },
              createElement(TripMap, {
                map: view.map,
                days,
                day: activeDay,
                range: mapRange,
                tier: mapTier,
                activeDayId: activeDay.id,
                onRange: setMapRange,
                onTier: setMapTier,
                selectedPlaceId,
                pendingFillDays,
                fillBusy: busy,
                onFill: props.onFillTransits === undefined ? undefined : fillTransits,
                onSelect: (placeId) => {
                  for (const entry of days) {
                    const item = entry.items.find((candidate) => candidate.placeId === placeId)
                    if (item === undefined) continue
                    // Picking a pin brings the itinerary to that day rather than
                    // silently changing which day the pane claims to show.
                    if (entry.id !== activeDay.id) jumpToDay(entry.id)
                    selectPlace(placeId, item.id)
                    return
                  }
                  selectPlace(placeId)
                },
              }),
              createElement(DayRail, { days, activeDayId: activeDay.id, select: jumpToDay }),
            ),
          ),
      // The detail is a floating window over the pane rather than a column: it
      // resizes from its inner edge and never takes width away from the timeline.
      selectedPlaceId === undefined
        ? null
        : createElement(PlaceSheet, {
            view,
            day: activeDay,
            placeId: selectedPlaceId,
            itemId: selectedItemId,
            busy,
            amapReady: props.amapReady,
            mutate: (ops) => run(() => props.onMutate(ops)),
            refreshPhoto: (placeId, start) => props.onRefreshPlaces(placeId, start),
            close: () => selectPlace(undefined),
          }),
      transportSheet && activeDay !== undefined
        ? createElement(TransportSheet, {
            day: activeDay,
            busy,
            close: () => setTransportSheet(false),
            rebuild: () =>
              run(async () => {
                await props.onRebuildLegs(activeDay.id)
                setTransportSheet(false)
                setReorder(undefined)
              }, '已用高德真实路网重算这一天的交通。'),
            askAgent: () => {
              setTransportSheet(false)
              props.onAskAgent(
                `请复核 ${activeDay.id}（${activeDay.title}）的交通与时间：` +
                  '请用 travel_day_rebuild_legs 按真实路网重算相邻两站的交通，并据此校正当天各站时间；已固定的安排保持不动。',
              )
            },
          })
        : null,
      overlay === undefined
        ? null
        : createElement(Overlay, {
            title: overlay === 'places' ? '地点库' : overlay === 'alerts' ? '提醒与冲突' : '就绪度怎么算的',
            close: () => setOverlay(undefined),
            children: overlay === 'places'
              ? createElement(PlacesList, {
                  view,
                  selectedPlaceId,
                  select: selectPlace,
                  busy,
                  refresh: () =>
                    run(async () => {
                      const result = await props.onRefreshPlaces(undefined, true)
                      setNotice(
                        result.updated === 0
                          ? `已检查 ${String(result.checked)} 个地点，没有可补全的照片。`
                          : `已为 ${String(result.updated)} 个地点补全照片和电话。`,
                      )
                    }),
                })
              : overlay === 'alerts'
                ? createElement(AlertsList, {
                    view,
                    onAskAgent: props.onAskAgent,
                    onJump: (dayId) => {
                      setActiveDayId(dayId)
                      selectPlace(undefined)
                      setOverlay(undefined)
                    },
                  })
                : createElement(AboutPanel, { view, onOpenAlerts: () => setOverlay('alerts') }),
          }),
      props.error === undefined ? null : createElement('div', { className: 'trv-error' }, props.error),
      notice === undefined ? null : createElement('div', { className: 'trv-notice' }, notice),
    ),
  )
}

/** Wrap any body in the panel shell that owns the stylesheet. */
function panelShell(includeStyles: boolean, ...children: (ReactElement | null)[]): ReactElement {
  return createElement(
    'div',
    { className: 'trv-shell' },
    includeStyles ? createElement('style', null, STYLES) : null,
    ...children,
  )
}

/** Trip switcher, readiness ring and the overflow menu. */
function Header(props: {
  readonly view: TravelView
  readonly switcherOpen: boolean
  readonly menuOpen: boolean
  readonly busy: boolean
  readonly setSwitcherOpen: (open: boolean) => void
  readonly setMenuOpen: (open: boolean) => void
  readonly onSelectTrip: (tripId: string, asDefault?: boolean) => Promise<void>
  readonly onFocusMap: () => void
  readonly onOpenOverlay: (key: OverlayKey) => void
}): ReactElement {
  const headline = props.view.headline
  const readiness = Math.round((headline?.readiness ?? 0) * 100)
  return createElement(
    'header',
    { className: 'trv-head' },
    createElement(
      'div',
      { className: 'trv-head-title' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'trv-switcher',
          'aria-expanded': props.switcherOpen,
          onClick: () => props.setSwitcherOpen(!props.switcherOpen),
        },
        createElement('span', { className: 'trv-switcher-name', title: headline?.title ?? '' }, headline?.title ?? '行程'),
        createElement('span', { className: 'trv-chevron' }, '⌄'),
      ),
      createElement(
        'div',
        { className: 'trv-head-sub' },
        `${headline?.startDate ?? ''} → ${headline?.endDate ?? ''}`,
        headline === null || headline.destinations.length === 0 ? '' : ` · ${headline.destinations.join(' / ')}`,
      ),
    ),
    createElement(
      'div',
      { className: 'trv-head-tools' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'trv-ring',
          style: { ['--trv-ready']: String(readiness) },
          title: `就绪度 ${String(readiness)}% · 点开看口径`,
          'aria-label': `就绪度 ${String(readiness)}%，点击查看说明`,
          onClick: () => props.onOpenOverlay('about'),
        },
        createElement('span', null, String(readiness)),
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'trv-icon',
          'aria-label': '更多',
          'aria-expanded': props.menuOpen,
          onClick: () => props.setMenuOpen(!props.menuOpen),
        },
        '⋯',
      ),
    ),
    props.menuOpen
      ? createElement(
          'div',
          { className: 'trv-menu', role: 'menu' },
          menuItem('🗂', '地点库', '候选与已采用的地点，可切换状态', () => props.onOpenOverlay('places')),
          menuItem('⚠', '提醒与冲突', '校验发现的问题，每条都能一键处理', () => props.onOpenOverlay('alerts')),
          menuItem('🧭', '在地图中打开当天', '弹出桌面高德窗口，看精确路网与街景', () => props.onFocusMap()),
          menuItem('📈', '就绪度怎么算的', '口径与当前扣分项', () => props.onOpenOverlay('about')),
        )
      : null,
    props.switcherOpen
      ? createElement(TripSwitcher, {
          trips: props.view.trips,
          activeTripId: props.view.activeTripId,
          selectionSource: props.view.selectionSource,
          busy: props.busy,
          select: props.onSelectTrip,
        })
      : null,
  )
}

/** One overflow-menu row: icon, label and a one-line explanation. */
function menuItem(icon: string, label: string, hint: string, onClick: () => void): ReactElement {
  return createElement(
    'button',
    { type: 'button', className: 'trv-menu-item', role: 'menuitem', key: label, onClick },
    createElement('span', { className: 'trv-menu-icon' }, icon),
    createElement(
      'span',
      { className: 'trv-menu-text' },
      createElement('span', { className: 'trv-menu-title' }, label),
      createElement('span', { className: 'trv-menu-hint' }, hint),
    ),
  )
}

/** The trip list behind the header switcher. */
function TripSwitcher(props: {
  readonly trips: readonly TripSummaryView[]
  readonly activeTripId: string | undefined
  readonly selectionSource: string | undefined
  readonly busy: boolean
  readonly select: (tripId: string, asDefault?: boolean) => Promise<void>
}): ReactElement {
  const active = props.trips.find((trip) => trip.id === props.activeTripId)
  return createElement(
    'div',
    { className: 'trv-sheet trv-sheet-top' },
    createElement('div', { className: 'trv-sheet-head' }, `工作区行程 · ${String(props.trips.length)}`),
    createElement(
      'ul',
      { className: 'trv-trip-list' },
      ...props.trips.map((trip) =>
        createElement(
          'li',
          { key: trip.id, className: `trv-trip${trip.id === props.activeTripId ? ' trv-trip-on' : ''}` },
          createElement(
            'button',
            {
              type: 'button',
              className: 'trv-trip-hit',
              disabled: props.busy,
              onClick: () => void props.select(trip.id),
            },
            createElement(
              'span',
              { className: 'trv-trip-main' },
              createElement('span', { className: 'trv-trip-name' }, trip.title),
              createElement(
                'span',
                { className: 'trv-trip-meta' },
                `${trip.startDate} → ${trip.endDate} · ${String(trip.durationDays)} 天 · ${statusLabel(trip.status)}`,
              ),
            ),
            createElement(
              'span',
              { className: 'trv-trip-side' },
              createElement('span', { className: 'trv-trip-ready' }, `${String(Math.round(trip.readiness * 100))}%`),
              trip.alerts.error + trip.alerts.warning === 0
                ? null
                : createElement('span', { className: 'trv-badge' }, String(trip.alerts.error + trip.alerts.warning)),
            ),
          ),
        ),
      ),
    ),
    active === undefined
      ? null
      : createElement(
          'button',
          {
            type: 'button',
            className: 'trv-sheet-foot',
            disabled: props.busy || props.selectionSource === 'workspace',
            onClick: () => void props.select(active.id, true),
          },
          props.selectionSource === 'workspace' ? '已是工作区默认行程' : '设为工作区默认行程',
        ),
    createElement('div', { className: 'trv-menu-note' }, '需要新行程时，直接对 Agent 说「再规划一个……」。'),
  )
}

/** Trip-level facts in one line, under the header. */
function MetaRow(props: {
  readonly view: TravelView
  readonly busy: boolean
  readonly amapReady: boolean
  readonly refreshPhotos: (start?: boolean) => Promise<{
    readonly checked: number
    readonly updated: number
    readonly needsStart: boolean
  }>
  readonly report: (message: string) => void
}): ReactElement | null {
  const view = props.view
  const headline = view.headline
  if (headline === null) return null
  const parts: string[] = []
  if (headline.travelers.length > 0) parts.push(headline.travelers.join('、'))
  if (headline.budgetLimit !== undefined) {
    parts.push(
      headline.budgetEstimated === undefined
        ? `预算 ${String(headline.budgetLimit)} ${headline.currency}`
        : `${String(headline.budgetEstimated)} / ${String(headline.budgetLimit)} ${headline.currency}`,
    )
  }
  const counts = headline.alerts
  // Photos are looked up on demand through the CLI. The offer lives here as well
  // as in the place library, because a stop's photo is what the timeline needs.
  const missing = view.photos ? view.places.filter((place) => place.photoUrl === undefined).length : 0
  const direct = view.photoLookup === 'direct'
  const label =
    direct || props.amapReady ? `缺 ${String(missing)} 张照片 · 补全` : `缺 ${String(missing)} 张照片 · 启动高德并补全`
  return createElement(
    'div',
    { className: 'trv-meta' },
    createElement('span', { className: 'trv-chip' }, statusLabel(headline.status)),
    parts.length === 0 ? null : createElement('span', null, parts.join(' · ')),
    counts.error > 0 ? createElement('span', { className: 'trv-chip trv-chip-error' }, `${String(counts.error)} 阻塞`) : null,
    counts.warning > 0 ? createElement('span', { className: 'trv-chip trv-chip-warn' }, `${String(counts.warning)} 警告`) : null,
    counts.info > 0 ? createElement('span', { className: 'trv-chip' }, `${String(counts.info)} 提示`) : null,
    missing === 0
      ? null
      : createElement(
          'button',
          {
            type: 'button',
            className: 'trv-chip-button',
            disabled: props.busy,
            title:
              direct || props.amapReady
                ? '按地点名向高德重新检索，补全缺失的照片与电话'
                : '需要先启动高德地图容器（会打开高德地图窗口），然后按地点名重新检索',
            onClick: () => {
              void props
                .refreshPhotos()
                .then((result) => {
                  props.report(
                    result.needsStart
                      ? '高德地图容器未运行；再点一次会启动它（会打开高德地图窗口）。'
                      : result.updated === 0
                        ? `已检查 ${String(result.checked)} 个地点，高德没有返回可用的照片。`
                        : `已为 ${String(result.updated)} 个地点补全照片。`,
                  )
                })
                .catch(() => undefined)
            },
          },
          props.busy ? '补全中…' : label,
        ),
  )
}

/**
 * One day of the trip: a sticky head plus that day's stops.
 *
 * The head carries the day's own numbers, so the itinerary reads as plan *and*
 * time in one place instead of a date in one view and a clock in another.
 */
function DaySection(props: {
  readonly day: DayView
  readonly index: number
  readonly total: number
  /** The hop that arrives at this day, from the previous one. */
  readonly transfer: DayTransfer | undefined
  readonly view: TravelView
  readonly busy: boolean
  readonly selectedItemId: string | undefined
  readonly reorder: { readonly dayId: string; readonly estimated: boolean } | undefined
  readonly attach: (dayId: string, node: HTMLElement | null) => void
  readonly mutate: (ops: readonly unknown[]) => Promise<void>
  readonly select: (placeId: string | undefined, itemId?: string) => void
  readonly reorderDay: (order: readonly string[]) => Promise<void>
  /** Recompute the day's transport for real; the bar awaits it. */
  readonly rebuild: () => Promise<unknown>
  readonly onOpenTransport: () => void
  readonly onOpenAlerts: () => void
  readonly onAskAgent: (text: string) => void
  readonly onLater: () => void
}): ReactElement {
  const day = props.day
  const alerts = props.view.alerts.filter((alert) => day.alertIds.includes(alert.id))
  const worst = alerts.find((alert) => alert.severity === 'error') ?? alerts[0]
  return createElement(
    'section',
    {
      className: 'trv-day',
      'data-day': day.id,
      ref: (node: HTMLElement | null) => props.attach(day.id, node),
    },
    createElement(
      'header',
      { className: 'trv-day-head' },
      // Two levels: the first says which day and which journey, the second only
      // numbers and actions, so neither competes with the other for attention.
      createElement(
        'div',
        { className: 'trv-day-head-main' },
        createElement('span', { className: 'trv-day-id' }, `D${String(props.index + 1)}`),
        createElement('span', { className: 'trv-day-date' }, weekdayLabel(day.date)),
        createElement('span', { className: 'trv-day-title' }, day.title),
      ),
      createElement(
        'div',
        { className: 'trv-day-head-facts' },
        createElement('span', { className: 'trv-day-head-numbers' }, dayHeadNumbers(day)),
        day.areaLabel === undefined ? null : createElement('span', { className: 'trv-day-area' }, day.areaLabel),
        createElement(
          'div',
          { className: 'trv-day-head-actions' },
          // The recompute affordance lives here permanently: the banner after a
          // drag is only a nudge, and dismissing it must not take the ability away.
          needsTransport(day, props.view.alerts)
            ? createElement(
                'button',
                { type: 'button', className: 'trv-chip-button trv-chip-warn', disabled: props.busy, onClick: props.onOpenTransport },
                '重算交通',
              )
            : null,
          worst === undefined
            ? null
            : createElement(
                'button',
                {
                  type: 'button',
                  className: `trv-chip-button trv-chip-${worst.severity === 'error' ? 'error' : 'warn'}`,
                  title: `${worst.message}（点击查看全部）`,
                  onClick: props.onOpenAlerts,
                },
                `${String(alerts.length)} 提醒`,
              ),
        ),
      ),
    ),
    // A recorded transit replaces the derived row: the day no longer needs the
    // panel to guess its journey out of the title.
    ...(day.transits ?? []).map((transit) =>
      createElement(TransitCard, {
        key: transit.id,
        transit,
        busy: props.busy,
        mutate: props.mutate,
        onAskAgent: props.onAskAgent,
        dayId: day.id,
        dayOrder: props.index + 1,
      }),
    ),
    (day.transits ?? []).length > 0 || props.transfer === undefined
      ? null
      : createElement(TransferRow, {
          transfer: props.transfer,
          busy: props.busy,
          onAskAgent: props.onAskAgent,
          onRecord: () => void props.mutate([transitOpFromTransfer(day.id, props.transfer as DayTransfer)]),
        }),
    props.reorder !== undefined && props.reorder.dayId === day.id
      ? createElement(ReflowBar, {
          estimated: props.reorder.estimated,
          busy: props.busy,
          rebuild: props.rebuild,
          later: props.onLater,
          askAgent: () =>
            props.onAskAgent(
              `请复核 ${day.id}（${day.title}）的交通与时间：我刚调整过顺序，` +
                '现在的衔接时长是估算值。请用 travel_day_rebuild_legs 按真实路网重算相邻两站的交通，' +
                '并据此校正当天各站时间；已固定的安排保持不动。',
            ),
        })
      : null,
    day.items.length === 0
      ? (day.transits ?? []).length > 0
        ? null // The transit card is this day's content; there are no stops to show.
        : createElement('div', { className: 'trv-empty' }, '这一天还没有安排。可以让 Agent 加入地点，或在「地点」里挑选。')
      : createElement(Timeline, {
          day,
          busy: props.busy,
          selectedItemId: props.selectedItemId,
          mutate: props.mutate,
          select: props.select,
          reorder: props.reorderDay,
        }),
  )
}

/**
 * How a day changes city, as its own card.
 *
 * A driving trip has days that are nothing but road, and this is what they get
 * instead of a stop card: the two ends, what the road costs, the clocks, and the
 * two things worth doing about it — plan it for real, or drop it.
 */
function TransitCard(props: {
  readonly transit: TransitView
  readonly busy: boolean
  readonly mutate: (ops: readonly unknown[]) => Promise<void>
  readonly onAskAgent: (text: string) => void
  readonly dayId: string
  readonly dayOrder: number
}): ReactElement {
  const transit = props.transit
  const figures = [
    transit.distanceMeters === undefined ? undefined : formatDistance(transit.distanceMeters),
    transit.durationSeconds === undefined ? undefined : formatDuration(transit.durationSeconds),
  ].filter((part): part is string => part !== undefined)
  const clocks =
    transit.departAt === undefined && transit.arriveAt === undefined
      ? undefined
      : `${transit.departAt === undefined ? '—' : clockLabel(transit.departAt)} 出发 → ${
          transit.arriveAt === undefined ? '—' : clockLabel(transit.arriveAt)
        } 抵达`

  return createElement(
    'div',
    { className: `trv-transit${transit.source === 'title' ? ' trv-transit-estimated' : ''}` },
    createElement(
      'div',
      { className: 'trv-transit-head' },
      createElement('span', { className: 'trv-transit-icon' }, modeIcon(transit.mode)),
      createElement('span', { className: 'trv-transit-route' }, `${transit.from.label} → ${transit.to.label}`),
      transit.freshness === 'failed'
        ? createElement('span', { className: 'trv-chip trv-chip-error' }, '路线失败')
        : transit.stale
          ? createElement('span', { className: 'trv-chip trv-chip-warn' }, '路线待更新')
          : transit.source === 'title'
            ? createElement('span', { className: 'trv-chip trv-chip-warn' }, '按标题估算')
            : null,
    ),
    figures.length === 0 && clocks === undefined
      ? null
      : createElement(
          'div',
          { className: 'trv-transit-meta' },
          figures.join(' · '),
          figures.length > 0 && clocks !== undefined ? ' · ' : '',
          clocks,
        ),
    createElement(
      'div',
      { className: 'trv-transit-actions' },
      !props.busy && transit.source === 'title'
        ? createElement(
            'button',
            {
              type: 'button',
              className: 'trv-btn trv-btn-primary',
              onClick: () =>
                props.onAskAgent(
                  `请用 travel_day_set_transit 把第 ${String(props.dayOrder)} 天（${props.dayId}）的转场按真实路网重算：` +
                    `${transit.from.label} → ${transit.to.label}（${
                      transit.distanceMeters === undefined ? '里程未知' : formatDistance(transit.distanceMeters)
                    }），方式 ${modeLabel(transit.mode)}。写回后如需调整当天各站时间请一并处理。`,
                ),
            },
            '用高德重算',
          )
        : null,
      createElement(
        'button',
        {
          type: 'button',
          className: 'trv-btn',
          disabled: props.busy,
          onClick: () => void props.mutate([{ kind: 'remove-day-transit', dayId: props.dayId, transitId: transit.id }]),
        },
        '删除转场',
      ),
    ),
  )
}

/**
 * The hop between two days.
 *
 * It sits inside the day it arrives at, under that day's header, rather than in
 * the gap above it: a driving trip states its substance in the day title
 * (`西安 → 成都｜723km`), and a row that repeats those two cities and that
 * figure immediately above the title that supplied them reads as a duplicate.
 * So the row says what is missing and offers to fill it in.
 */
function TransferRow(props: {
  readonly transfer: DayTransfer
  readonly busy: boolean
  readonly onAskAgent: (text: string) => void
  /** Promote this hop into a real transit, so the day stops guessing. */
  readonly onRecord: () => void
}): ReactElement {
  const transfer = props.transfer
  const lines = transferLines(transfer)
  const warn = transfer.source === 'title'
  return createElement(
    'div',
    { className: `trv-transfer trv-transfer-${transfer.source}` },
    createElement('span', { className: 'trv-transfer-icon' }, warn ? '⚠' : modeIcon(transfer.mode ?? 'driving')),
    createElement('span', { className: 'trv-transfer-text' }, lines.text),
    lines.note === undefined ? null : createElement('span', { className: 'trv-transfer-note' }, lines.note),
    warn
      ? createElement(
          'button',
          {
            type: 'button',
            className: 'trv-btn trv-btn-primary trv-transfer-act',
            disabled: props.busy,
            onClick: props.onRecord,
          },
          '记为转场',
        )
      : null,
    warn
      ? createElement(
          'button',
          {
            type: 'button',
            className: 'trv-btn trv-transfer-act',
            disabled: props.busy,
            onClick: () =>
              props.onAskAgent(
                `请用 travel_day_set_transit 规划并写入这段转场：${transfer.origin} → ${transfer.destination}，` +
                  '用 travel_route_plan 的真实里程与时长，写完据此校正当天各站时间。',
              ),
          },
          '让 Agent 重算',
        )
      : null,
  )
}

/**
 * The trip's table of contents: one row per day, with its driving weight.
 *
 * Visible only in a wide pane. The bar is relative to the busiest day, so the
 * rhythm of a two-week drive reads at a glance — long bars are long days, and a
 * day that changes city without a leg says so instead of showing an empty bar.
 */
function DayRail(props: {
  readonly days: readonly DayView[]
  readonly activeDayId: string
  readonly select: (dayId: string) => void
}): ReactElement | null {
  const rail = useRef<HTMLElement | null>(null)
  const activeRef = useRef<HTMLButtonElement | null>(null)
  const intensity = useMemo(() => dayIntensity(props.days), [props.days])

  // A two-week trip makes the rail taller than the pane, so the current day must
  // be brought into view. Scrolling is done by hand: `scrollIntoView` would also
  // move every scrollable ancestor, including the pane itself.
  useEffect(() => {
    const container = rail.current
    const button = activeRef.current
    if (container === null || button === null) return
    const view = container.getBoundingClientRect()
    const box = button.getBoundingClientRect()
    if (box.top < view.top) container.scrollTop -= view.top - box.top + 4
    else if (box.bottom > view.bottom) container.scrollTop += box.bottom - view.bottom + 4
  }, [props.activeDayId, props.days.length])

  if (props.days.length === 0) return null
  return createElement(
    'aside',
    { className: 'trv-rail', ref: rail },
    ...props.days.map((day, index) => {
      const facts = dayFacts(day)
      const ratio = intensity[index] ?? 0
      const note = dayDistanceText(facts)
      const reasons = [
        day.title,
        facts.unrecorded ? '换了城市但没有交通记录' : undefined,
        day.alertIds.length === 0 ? undefined : `${String(day.alertIds.length)} 条提醒`,
      ].filter((part): part is string => part !== undefined)
      return createElement(
        'button',
        {
          key: day.id,
          type: 'button',
          className: `trv-rail-day${day.id === props.activeDayId ? ' trv-rail-on' : ''}`,
          ref: day.id === props.activeDayId ? activeRef : undefined,
          title: reasons.join(' · '),
          onClick: () => props.select(day.id),
        },
        createElement(
          'span',
          { className: 'trv-rail-head' },
          // The swatch is the map's own colour for the day, so the rail doubles
          // as the map's key now that the in-map legend is gone.
          createElement('i', { className: 'trv-rail-swatch', style: { background: dayColorCss(index) } }),
          createElement('span', { className: 'trv-rail-id' }, `D${String(index + 1)}`),
          createElement('span', { className: 'trv-rail-meta' }, day.date.slice(5)),
          day.alertIds.length === 0 ? null : createElement('span', { className: 'trv-dot trv-dot-inline' }),
          createElement(
            'span',
            {
              className: `trv-rail-gap${facts.unrecorded ? '' : ' trv-rail-gap-off'}`,
              title: facts.unrecorded ? '换了城市但没有交通记录' : '交通已记录',
            },
            facts.unrecorded ? '!' : '',
          ),
        ),
        createElement(
          'span',
          { className: 'trv-rail-foot' },
          createElement(
            'span',
            { className: 'trv-rail-bar' },
            createElement('i', { style: { width: `${String(Math.round(ratio * 100))}%` } }),
          ),
          createElement('span', { className: 'trv-rail-note' }, note),
        ),
      )
    }),
  )
}

/** Where the category tone of a stop comes from. */
const CATEGORY_TONES: readonly { readonly match: RegExp; readonly token: string }[] = [
  { match: /餐|食|咖啡|小吃|酒吧|美食/, token: '--dsw-alias-state-warn-primary' },
  { match: /交通|车站|机场|地铁|码头/, token: '--dsw-alias-brand-primary' },
  { match: /住宿|酒店|民宿|旅馆/, token: '--dsw-alias-state-success-primary' },
  { match: /购物|商场|市场|商店|免税/, token: '--dsw-alias-state-error-primary' },
  { match: /风景|公园|古迹|博物馆|寺院|寺|宫|山|湖/, token: '--dsw-alias-brand-primary' },
]

/** The colour band shown beside one stop. */
function categoryTone(category: string): string {
  for (const entry of CATEGORY_TONES) {
    if (entry.match.test(category)) return `var(${entry.token})`
  }
  return 'var(--dsw-alias-border-l2)'
}

/** The transport leg under one stop's unit. */
function LegRow({ leg }: { readonly leg: LegView }): ReactElement {
  const flagged = leg.freshness === 'failed' || leg.stale
  return createElement(
    'div',
    { className: `trv-leg${leg.freshness === 'failed' ? ' trv-leg-failed' : ''}${leg.stale ? ' trv-leg-stale' : ''}` },
    createElement('span', { className: 'trv-leg-icon' }, modeIcon(leg.mode)),
    createElement('span', null, `${modeLabel(leg.mode)} ${formatDistance(leg.distanceMeters)} · ${formatDuration(leg.durationSeconds)}`),
    flagged ? createElement('span', { className: 'trv-inline trv-inline-warning' }, '路线待更新') : null,
  )
}

/** The action bar shown after the order changed by hand. */
function ReflowBar(props: {
  readonly estimated: boolean
  readonly busy: boolean
  readonly rebuild: () => Promise<unknown>
  readonly askAgent: () => void
  readonly later: () => void
}): ReactElement {
  return createElement(
    'div',
    { className: 'trv-reflow' },
    createElement(
      'div',
      { className: 'trv-reflow-text' },
      props.estimated ? '已按停留时长重排 · 衔接时长为估算值' : '已用高德真实路网重算这一天的交通',
    ),
    createElement(
      'div',
      { className: 'trv-reflow-actions' },
      props.estimated
        ? createElement(
            'button',
            { type: 'button', className: 'trv-btn trv-btn-primary', disabled: props.busy, onClick: () => void props.rebuild() },
            '重算这一天交通',
          )
        : null,
      props.estimated
        ? createElement('button', { type: 'button', className: 'trv-btn', disabled: props.busy, onClick: props.askAgent }, '让 Agent 复核')
        : null,
      createElement('button', { type: 'button', className: 'trv-btn', onClick: props.later }, '稍后'),
    ),
  )
}

/**
 * The day's stops, re-orderable by dragging.
 *
 * The dragged unit follows the pointer while the units it passes slide by one
 * slot, so the list shows where the stop will land instead of only marking it
 * with a line. After the drop the preview is held until the Host's new order
 * reaches the list, so the day settles instead of snapping back and re-sorting.
 * Locked stops cannot be dragged; everything else can.
 */
function Timeline(props: {
  readonly day: DayView
  readonly busy: boolean
  readonly selectedItemId: string | undefined
  readonly mutate: (ops: readonly unknown[]) => Promise<void>
  readonly select: (placeId: string | undefined, itemId?: string) => void
  readonly reorder: (order: readonly string[]) => Promise<void>
}): ReactElement {
  const [drag, setDrag] = useState<{ readonly id: string; readonly index: number; readonly height: number; readonly dy: number } | undefined>(undefined)
  const [dropIndex, setDropIndex] = useState<number | undefined>(undefined)
  const [expected, setExpected] = useState<string | undefined>(undefined)
  const list = useRef<HTMLOListElement | null>(null)
  /** Unit geometry captured when the drag starts; live rects move as units slide
   * and reading them mid-flight makes the target flip back and forth. */
  const metrics = useRef<readonly { readonly top: number; readonly height: number }[]>([])
  const ids = props.day.items.map((item) => item.id)
  const orderKey = ids.join('|')

  /** Leave the preview state behind, at the current layout. */
  const settle = useCallback((): void => {
    setExpected(undefined)
    setDrag(undefined)
    setDropIndex(undefined)
  }, [])

  // Once the Host's order reaches the list the units already sit where they
  // belong, so dropping the transforms changes nothing on screen. The timer is
  // the guard for a reorder that never arrives (rejected, or a lost session).
  useEffect(() => {
    if (expected === undefined) return undefined
    if (orderKey === expected) {
      settle()
      return undefined
    }
    const timer = setTimeout(settle, 2500)
    return () => clearTimeout(timer)
  }, [expected, orderKey, settle])

  /** Commit one move, expressed as the full order the Host expects. */
  const commit = (from: number, to: number): readonly string[] | undefined => {
    if (from === to || from < 0 || to < 0 || from >= ids.length) return undefined
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    if (moved === undefined) return undefined
    next.splice(from < to ? to - 1 : to, 0, moved)
    if (next.every((id, index) => id === ids[index])) return undefined
    void props.reorder(next)
    return next
  }

  /** Index the pointer currently sits before, measured against the pre-drag layout. */
  const indexAt = (clientY: number): number => {
    const rects = metrics.current
    if (rects.length === 0) return 0
    for (const [index, rect] of rects.entries()) {
      if (clientY < rect.top + rect.height / 2) return index
    }
    return rects.length
  }

  const begin = (itemId: string, index: number, event: React.PointerEvent<HTMLButtonElement>): void => {
    if (props.busy) return
    event.preventDefault()
    // A new drag abandons whatever the previous one was still waiting for.
    setExpected(undefined)
    const unit = event.currentTarget.closest('[data-item-row]')
    const startY = event.clientY
    const height = unit?.getBoundingClientRect().height ?? 56
    metrics.current = [...(list.current?.querySelectorAll('[data-item-row]') ?? [])].map((row) => {
      const rect = row.getBoundingClientRect()
      return { top: rect.top, height: rect.height }
    })
    let active = false
    let frame: number | undefined
    let latest = startY
    const apply = (): void => {
      frame = undefined
      setDrag({ id: itemId, index, height, dy: latest - startY })
      setDropIndex(indexAt(latest))
    }
    const move = (moveEvent: PointerEvent): void => {
      latest = moveEvent.clientY
      if (!active) {
        if (Math.abs(latest - startY) < 4) return
        active = true
      }
      // One update per frame: pointermove can fire far faster than the panel paints.
      frame ??= window.requestAnimationFrame(apply)
      const container = list.current?.parentElement
      if (container !== null && container !== undefined) {
        const rect = container.getBoundingClientRect()
        if (latest < rect.top + 48) container.scrollTop -= 10
        else if (latest > rect.bottom - 48) container.scrollTop += 10
      }
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', onKey)
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
    const finish = (upEvent: PointerEvent): void => {
      stop()
      if (!active) {
        settle()
        return
      }
      const target = indexAt(upEvent.clientY)
      const next = commit(index, target)
      if (next === undefined) {
        settle()
        return
      }
      // Hold the preview, with the lifted stop easing into the slot it opened.
      setDrag({ id: itemId, index, height, dy: landingOffset(index, target) })
      setDropIndex(target)
      setExpected(next.join('|'))
    }
    const cancel = (): void => {
      stop()
      settle()
    }
    const onKey = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key === 'Escape') cancel()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', onKey)
  }

  /** How far one unit slides to open a slot for the dragged stop. */
  const shiftFor = (index: number): number => {
    if (drag === undefined || dropIndex === undefined) return 0
    if (index === drag.index) return drag.dy
    if (drag.index < dropIndex && index > drag.index && index < dropIndex) return -drag.height
    if (dropIndex <= drag.index && index >= dropIndex && index < drag.index) return drag.height
    return 0
  }

  /**
   * The offset that puts the dragged unit exactly into its landing slot.
   *
   * Releasing the pointer leaves the stop wherever the hand stopped, up to a
   * unit away from the slot the list opened; measuring the landing from the
   * pre-drag geometry instead makes the arrival render a no-op, so nothing
   * shifts when the Host's order lands.
   */
  const landingOffset = (from: number, to: number): number => {
    const rects = metrics.current
    const origin = rects[from]
    if (origin === undefined) return 0
    if (to <= from) {
      // Moving up: the stop takes the slot line the target unit sits on.
      return (rects[to]?.top ?? origin.top) - origin.top
    }
    // Moving down: dropping the stop out of the stack lifts everything after it
    // by its own height, so the line it lands on is that much higher.
    const last = rects[rects.length - 1]
    const edge = rects[to] === undefined ? (last === undefined ? origin.top : last.top + last.height) : rects[to].top
    return edge - origin.height - origin.top
  }

  const showThumbs = props.day.items.some((item) => item.photoUrl !== undefined)
  // The render that carries the Host's new order: the units already occupy their
  // final slots there, so their preview offsets must drop in that same paint.
  const arrived = expected !== undefined && orderKey === expected
  const classes = `trv-timeline${drag === undefined ? '' : ' trv-timeline-dragging'}${expected === undefined ? '' : ' trv-timeline-committing'}`
  return createElement(
    'ol',
    { className: classes, ref: list },
    ...props.day.items.map((item, index) => {
      const shift = arrived ? 0 : shiftFor(index)
      const leg = props.day.legs.find((entry) => entry.fromItemId === item.id)
      // A drive that runs past midnight stores the next day's clock, which read
      // like a step backwards until it was labelled.
      const previous = props.day.items[index - 1]?.startAt?.slice(11, 16)
      const clock = item.startAt?.slice(11, 16)
      const overnight = previous !== undefined && clock !== undefined && clock < previous
      return createElement(
        'li',
        {
          key: item.id,
          'data-item-row': item.id,
          className: `trv-unit${drag?.id === item.id && !arrived ? ' trv-unit-dragging' : ''}`,
          style: shift === 0 ? undefined : { transform: `translateY(${String(shift)}px)` },
        },
        createElement(StopRow, {
          item,
          index,
          overnight,
          showThumbs,
          selected: item.id === props.selectedItemId,
          busy: props.busy,
          select: props.select,
          onHandle: (event) => begin(item.id, index, event),
          onKeyboardMove: (delta) => commit(index, index + delta),
        }),
        leg === undefined ? null : createElement(LegRow, { leg }),
      )
    }),
  )
}

/** One stop: time rail, card, thumbnail and drag handle. */
function StopRow(props: {
  readonly item: ItemView
  readonly index: number
  /** True when this stop's clock lands after midnight of its own day. */
  readonly overnight: boolean
  readonly showThumbs: boolean
  readonly selected: boolean
  readonly busy: boolean
  readonly select: (placeId: string | undefined, itemId?: string) => void
  readonly onHandle: (event: React.PointerEvent<HTMLButtonElement>) => void
  readonly onKeyboardMove: (delta: number) => void
}): ReactElement {
  const { item } = props
  return createElement(
    'div',
    {
      className: `trv-row${props.selected ? ' trv-row-on' : ''}`,
      style: { ['--trv-tone']: categoryTone(item.category) },
    },
    createElement(
      'div',
      { className: 'trv-tick' },
      // `次日` is its own line rather than a prefix that wrapped the clock onto a
      // second line in a 46px gutter.
      createElement(
        'span',
        { className: 'trv-tick-time' },
        props.overnight ? createElement('i', { className: 'trv-tick-next' }, '次日') : null,
        createElement('span', { className: 'trv-tick-clock' }, clockLabel(item.startAt)),
      ),
      createElement('span', { className: 'trv-tick-node' }),
    ),
    createElement(
      'button',
      {
        type: 'button',
        className: 'trv-card',
        onClick: () => props.select(props.selected ? undefined : item.placeId, item.id),
      },
      createElement(
        'span',
        { className: 'trv-card-head' },
        createElement('span', { className: 'trv-card-name' }, item.name),
        item.locked ? createElement('span', { className: 'trv-fixed', title: '已固定：Agent 不会移动或改时间' }, '固定') : null,
        item.plannedDurationMinutes === undefined
          ? null
          : createElement('span', { className: 'trv-card-dwell' }, formatMinutes(item.plannedDurationMinutes)),
      ),
      createElement(
        'span',
        { className: 'trv-card-meta' },
        item.category,
        item.address === '' ? '' : ` · ${item.address}`,
      ),
    ),
    props.showThumbs
      ? item.photoUrl === undefined
        ? createElement('span', { className: 'trv-thumb trv-thumb-blank' }, item.category.slice(0, 1))
        : createElement(Thumb, { src: item.photoUrl, alt: item.name })
      : null,
    createElement(
      'button',
      {
        type: 'button',
        className: 'trv-grip',
        'aria-label': item.locked ? '已固定，不能拖动' : `拖动调整「${item.name}」的顺序`,
        title: item.locked ? '已固定：先取消固定才能拖动' : '拖动调整顺序（⌥↑/⌥↓ 也可）',
        disabled: item.locked || props.busy,
        onPointerDown: item.locked ? undefined : props.onHandle,
        onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
          if (!event.altKey) return
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          event.preventDefault()
          props.onKeyboardMove(event.key === 'ArrowUp' ? -1 : 1)
        },
      },
      item.locked ? '🔒' : '⠿',
    ),
  )
}

/** A place photo that quietly disappears when the CDN cannot serve it. */
function Thumb(props: { readonly src: string; readonly alt: string }): ReactElement | null {
  const [broken, setBroken] = useState(false)
  if (broken) return null
  return createElement('img', {
    className: 'trv-thumb',
    src: props.src,
    alt: props.alt,
    loading: 'lazy',
    referrerPolicy: 'no-referrer',
    onError: () => setBroken(true),
  })
}

/** The selected place, as a sheet anchored to the bottom of the pane. */
/**
 * One stop's details.
 *
 * It takes part in the pane's layout instead of floating over the timeline, so
 * a stop being read is never hidden behind its own card: a bottom panel when the
 * pane is narrow, a right-hand column once there is room. Its edge is a drag
 * handle, and the chosen size is remembered per browser.
 */
export function PlaceSheet(props: {
  readonly view: TravelView
  readonly day: DayView | undefined
  readonly placeId: string
  readonly itemId: string | undefined
  readonly busy: boolean
  readonly amapReady: boolean
  readonly mutate: (ops: readonly unknown[]) => Promise<void>
  readonly refreshPhoto: (placeId: string, start?: boolean) => Promise<{ readonly checked: number; readonly updated: number; readonly needsStart: boolean }>
  readonly close: () => void
}): ReactElement {
  const place: PlaceView | undefined = props.view.places.find((entry) => entry.id === props.placeId)
  const item: ItemView | undefined = props.day?.items.find((entry) => entry.placeId === props.placeId)
  const dayId = props.day?.id
  const index = props.day === undefined || item === undefined ? -1 : props.day.items.indexOf(item)
  const photo = item?.photoUrl ?? place?.photoUrl
  const [width, setWidth] = useState(() => readSize('detailSize', 0, 0, 720))
  /** Height: zero until the user drags the top edge or the corner. */
  const [height, setHeight] = useState(() => readSize('detailHeight', 0, 0, 900))
  /** One automatic lookup per place; a failure offers the button instead of looping. */
  const asked = useRef<string | undefined>(undefined)
  /** A direct source (Web-service API) can be asked without any container. */
  const direct = props.view.photoLookup === 'direct'
  const canLookup = direct || props.amapReady
  const [photoNote, setPhotoNote] = useState<{ readonly text: string; readonly retry: boolean; readonly start?: boolean }>(() => ({
    text: canLookup ? '正在向高德补全照片…' : '高德地图容器未运行；补全照片要先启动它（会打开高德地图窗口）。',
    retry: false,
    ...canLookup ? {} : { start: true },
  }))

  const look = useCallback(
    (start = false): void => {
      asked.current = props.placeId
      setPhotoNote({ text: '正在向高德补全照片…', retry: false })
      void props
        .refreshPhoto(props.placeId, start)
        .then((result) => {
          // A hit arrives with the next view; only the misses need a message.
          if (result.updated > 0) return
          setPhotoNote(
            result.needsStart
              ? { text: '高德地图容器未运行；补全照片要先启动它（会打开高德地图窗口）。', retry: false, start: true }
              : { text: '高德没有返回这个地点的照片。', retry: true },
          )
        })
        .catch((error: unknown) => {
          setPhotoNote({ text: error instanceof Error ? error.message : '补全照片失败。', retry: true })
        })
    },
    [props.placeId, props.refreshPhoto],
  )

  // A background lookup never opens the AMap window: it runs when the answer
  // comes over the Web-service API, or when the container already answers.
  // Otherwise the card offers an explicit button instead.
  useEffect(() => {
    if (!props.view.photos || !canLookup) return
    if (photo !== undefined || asked.current === props.placeId) return
    look()
  }, [canLookup, look, photo, props.placeId, props.view.photos])

  /**
   * Drag one edge or corner of the window.
   *
   * The panel is anchored to the bottom right, so left and up both mean bigger.
   * A corner handle drives both axes at once, which is the only way to resize
   * diagonally; each axis keeps its own remembered size.
   */
  const grip =
    (axes: { readonly x: boolean; readonly y: boolean }) =>
    (event: React.PointerEvent<HTMLDivElement>): void => {
      event.preventDefault()
      const panel = event.currentTarget.parentElement?.getBoundingClientRect()
      const pane = event.currentTarget.closest('.trv-root')?.getBoundingClientRect()
      if (panel === undefined || panel === null) return
      const startX = event.clientX
      const startY = event.clientY
      // An untouched axis is sized by its own CSS default (the panel hugs its
      // content when wide), so the drag starts from what is on screen.
      const fromWidth = width > 0 ? width : panel.width
      const fromHeight = height > 0 ? height : panel.height
      // A bottom sheet already spans the pane, and its own CSS caps it at the
      // pane width; the side window caps it at 70%. Which one is on screen is
      // read from the panel rather than guessed from a breakpoint.
      const paneWidth = pane?.width ?? 900
      const maxWidth = Math.max(240, panel.width > paneWidth * 0.8 ? paneWidth - 24 : paneWidth * 0.7)
      const maxHeight = Math.max(160, (pane?.height ?? 800) * 0.82)
      const move = (moveEvent: PointerEvent): void => {
        if (axes.y) {
          const raw = fromHeight + (startY - moveEvent.clientY)
          const next = Math.round(Math.min(Math.max(raw, 160), maxHeight))
          setHeight(next)
          writePref('detailHeight', next)
        }
        if (axes.x) {
          const raw = fromWidth + (startX - moveEvent.clientX)
          const next = Math.round(Math.min(Math.max(raw, 240), maxWidth))
          setWidth(next)
          writePref('detailSize', next)
        }
      }
      const stop = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
    }

  return createElement(
    'section',
    {
      className: 'trv-detail',
      style: {
        // Only the axes the user has actually dragged are set, so an untouched
        // window keeps hugging its content.
        ...(width > 0 ? { ['--trv-detail-w']: `${String(width)}px` } : {}),
        ...(height > 0 ? { ['--trv-detail-h']: `${String(height)}px` } : {}),
      },
    },
    createElement('div', {
      className: 'trv-detail-grip trv-detail-grip-top',
      role: 'separator',
      'aria-orientation': 'horizontal',
      title: '拖动调整详情高度',
      onPointerDown: grip({ x: false, y: true }),
    }),
    createElement('div', {
      className: 'trv-detail-grip trv-detail-grip-side',
      role: 'separator',
      'aria-orientation': 'vertical',
      title: '拖动调整详情宽度',
      onPointerDown: grip({ x: true, y: false }),
    }),
    createElement('div', {
      className: 'trv-detail-grip trv-detail-grip-corner',
      role: 'separator',
      title: '拖动调整详情大小（对角）',
      onPointerDown: grip({ x: true, y: true }),
    }),
    createElement(
      'div',
      { className: 'trv-detail-body' },
      photo === undefined
        ? !props.view.photos
          ? null
          : createElement(
              'div',
              {
                className: 'trv-photo-empty',
                // The way out of the container entirely, for whoever wants it.
                title: direct
                  ? undefined
                  : '照片也可以不走高德容器：在凭据里放一个高德 Web 服务 Key（默认引用名 AMAP_REST_KEY），插件就会用 HTTPS 直接查询。',
              },
              createElement('span', null, photoNote.text),
              photoNote.retry
                ? createElement(
                    'button',
                    { type: 'button', className: 'trv-btn', disabled: props.busy, onClick: () => look(false) },
                    '再查一次',
                  )
                : null,
              photoNote.start === true
                ? createElement(
                    'button',
                    { type: 'button', className: 'trv-btn trv-btn-primary', disabled: props.busy, onClick: () => look(true) },
                    '启动高德并补全',
                  )
                : null,
            )
        : createElement('img', {
            className: 'trv-banner',
            src: photo,
            alt: item?.name ?? place?.name ?? '',
            loading: 'lazy',
            referrerPolicy: 'no-referrer',
            onError: (event: React.SyntheticEvent<HTMLImageElement>) => {
              event.currentTarget.style.display = 'none'
            },
          }),
      createElement(
        'div',
        { className: 'trv-sheet-head' },
        createElement('span', { className: 'trv-sheet-title' }, item?.name ?? place?.name ?? props.placeId),
        createElement('button', { type: 'button', className: 'trv-icon', 'aria-label': '收起', onClick: props.close }, '✕'),
      ),
      createElement('div', { className: 'trv-sheet-kind' }, item?.category ?? place?.categories[0] ?? '未分类'),
      createElement(
        'dl',
        { className: 'trv-grid' },
        row('地址', place?.address === undefined || place.address === '' ? '—' : place.address),
        row('电话', place?.telephone ?? '—'),
        row('坐标', place === undefined ? '—' : `${place.point.longitude.toFixed(5)}, ${place.point.latitude.toFixed(5)}`),
        row('来源', place === undefined ? '—' : `${place.providerPlaceId === undefined ? '手工录入' : '高德'} · ${place.fetchedAt.slice(0, 16).replace('T', ' ')}`),
        row('停留', item?.plannedDurationMinutes === undefined ? '待定' : formatMinutes(item.plannedDurationMinutes)),
        row('时间', item?.startAt === undefined ? '待定' : `${item.startAt.slice(11, 16)}${item.endAt === undefined ? '' : `–${item.endAt.slice(11, 16)}`}`),
      ),
      item === undefined || item.notes.length === 0
        ? null
        : createElement('ul', { className: 'trv-notes' }, ...item.notes.map((note, position) => createElement('li', { key: String(position) }, note))),
      item === undefined || dayId === undefined
        ? null
        : createElement(
            'div',
            { className: 'trv-actions' },
            createElement(
              'button',
              {
                type: 'button',
                className: 'trv-btn',
                disabled: props.busy,
                title: item.locked
                  ? '取消固定后，Agent 与自动重排就可以调整这一站'
                  : '固定后 Agent 不会移动它或改时间，也不能拖动',
                onClick: () => void props.mutate([{ kind: 'set-item-lock', dayId, itemId: item.id, locked: !item.locked }]),
              },
              item.locked ? '取消固定' : '固定',
            ),
            createElement(
              'button',
              {
                type: 'button',
                className: 'trv-btn trv-btn-danger',
                disabled: props.busy || item.locked,
                title: item.locked ? '固定中的安排不能移除，先取消固定' : '把这一站从当天移除',
                onClick: () => void props.mutate([{ kind: 'remove-item', dayId, itemId: item.id }]),
              },
              '移除',
            ),
          ),
    ),
  )
}

/**
 * The permanent transport-recompute sheet.
 *
 * Reachable from the day header at any time, so dismissing a nudge never loses
 * the ability to recompute.
 */
function TransportSheet(props: {
  readonly day: DayView
  readonly busy: boolean
  readonly close: () => void
  readonly rebuild: () => Promise<void>
  readonly askAgent: () => void
}): ReactElement {
  return createElement(
    'section',
    { className: 'trv-sheet trv-sheet-bottom' },
    createElement(
      'div',
      { className: 'trv-sheet-head' },
      createElement('span', { className: 'trv-sheet-title' }, '这一天的交通'),
      createElement('button', { type: 'button', className: 'trv-icon', 'aria-label': '收起', onClick: props.close }, '✕'),
    ),
    createElement(
      'p',
      { className: 'trv-sheet-kind' },
      `${String(props.day.legs.length)} 段交通，其中 ${String(props.day.legs.filter((leg) => leg.stale || leg.freshness !== 'fresh').length)} 段需要重算。`,
    ),
    createElement(
      'ul',
      { className: 'trv-about-list' },
      createElement('li', null, '「重算」直接调用高德路网，几秒钟就能好，不消耗对话额度。'),
      createElement('li', null, '顺序改动后，未测量过的衔接不会编造数据，所以会显示为待重算。'),
      createElement('li', null, '需要顺带调整行程安排时，再交给 Agent。'),
    ),
    createElement(
      'div',
      { className: 'trv-actions' },
      createElement(
        'button',
        { type: 'button', className: 'trv-btn trv-btn-primary', disabled: props.busy, onClick: () => void props.rebuild() },
        '用高德重算这一天',
      ),
      createElement('button', { type: 'button', className: 'trv-btn', disabled: props.busy, onClick: props.askAgent }, '让 Agent 复核'),
    ),
  )
}

/**
 * Whether a day still needs its transport recomputed.
 *
 * @param day - day to inspect.
 * @param alerts - the trip's alerts.
 * @returns true when a leg is stale or failed, or an adjacent pair has no leg.
 */
function needsTransport(day: DayView, alerts: readonly { readonly code: string; readonly relatedIds: readonly string[] }[]): boolean {
  if (day.legs.some((leg) => leg.stale || leg.freshness !== 'fresh')) return true
  const missing = alerts.some(
    (alert) => alert.code === 'MISSING_ROUTE' && alert.relatedIds.some((id) => day.items.some((item) => item.id === id)),
  )
  return missing || (day.items.length > 1 && day.legs.length < day.items.length - 1)
}

/** Full-pane overlay for the place library and the alert list. */
function Overlay(props: {
  readonly title: string
  readonly close: () => void
  readonly children: ReactElement
}): ReactElement {
  return createElement(
    'section',
    { className: 'trv-overlay' },
    createElement(
      'div',
      { className: 'trv-sheet-head trv-overlay-head' },
      createElement('button', { type: 'button', className: 'trv-icon', 'aria-label': '返回', onClick: props.close }, '‹'),
      createElement('span', { className: 'trv-sheet-title' }, props.title),
      createElement('span', { className: 'trv-sheet-spacer' }),
    ),
    createElement('div', { className: 'trv-overlay-body' }, props.children),
  )
}

/** The project place library grouped by status. */
export function PlacesList(props: {
  readonly view: TravelView
  readonly selectedPlaceId: string | undefined
  readonly select: (placeId: string) => void
  readonly busy: boolean
  readonly refresh: () => void
}): ReactElement {
  const groups: readonly { readonly status: string; readonly label: string }[] = [
    { status: 'planned', label: '已采用' },
    { status: 'locked', label: '已固定' },
    { status: 'candidate', label: '候选' },
    { status: 'excluded', label: '已排除' },
  ]
  const rendered = groups
    .map((group) => ({ group, places: props.view.places.filter((place) => place.status === group.status) }))
    .filter((entry) => entry.places.length > 0)
  if (rendered.length === 0) return createElement('div', { className: 'trv-empty' }, '地点库还是空的。')
  // Photos are backfilled on demand: a trip planned before the photo pass, or a
  // place added by hand, can still have none while others already do.
  const missing = props.view.places.filter((place) => place.photoUrl === undefined).length
  const head =
    missing === 0
      ? null
      : createElement(
          'div',
          { className: 'trv-wall-head' },
          createElement('span', { className: 'trv-wall-note' }, `还有 ${String(missing)} 个地点没有照片`),
          createElement(
            'button',
            { type: 'button', className: 'trv-btn trv-btn-primary', disabled: props.busy, onClick: props.refresh },
            props.busy ? '补全中…' : '补全照片',
          ),
        )
  if (props.view.places.some((place) => place.photoUrl !== undefined)) {
    return createElement(
      'div',
      null,
      head,
      createElement(PhotoWall, { view: props.view, selectedPlaceId: props.selectedPlaceId, select: props.select }),
    )
  }
  return createElement(
    'div',
    null,
    head,
    ...rendered.map(({ group, places }) =>
      createElement(
        'section',
        { key: group.status, className: 'trv-group' },
        createElement('h3', { className: 'trv-group-head' }, `${group.label} · ${String(places.length)}`),
        createElement(
          'ul',
          { className: 'trv-place-list' },
          ...places.map((place) =>
            createElement(
              'li',
              { key: place.id, className: `trv-place-row${place.id === props.selectedPlaceId ? ' trv-place-on' : ''}` },
              createElement(
                'button',
                { type: 'button', className: 'trv-place-hit', onClick: () => props.select(place.id) },
                createElement('span', { className: 'trv-place-name' }, place.name),
                createElement('span', { className: 'trv-place-addr' }, place.address === '' ? '（无地址）' : place.address),
                createElement(
                  'span',
                  { className: 'trv-place-meta' },
                  place.categories.slice(0, 2).join(' / '),
                  place.telephone === undefined ? '' : ` · ${place.telephone}`,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )
}

/** Every place as a card with its photo, shown once at least one photo exists. */
function PhotoWall(props: {
  readonly view: TravelView
  readonly selectedPlaceId: string | undefined
  readonly select: (placeId: string) => void
}): ReactElement {
  return createElement(
    'div',
    { className: 'trv-wall' },
    ...props.view.places.map((place) =>
      createElement(
        'button',
        {
          key: place.id,
          type: 'button',
          className: `trv-wall-card${place.id === props.selectedPlaceId ? ' trv-wall-on' : ''}`,
          onClick: () => props.select(place.id),
        },
        place.photoUrl === undefined
          ? createElement('span', { className: 'trv-wall-blank' }, place.name.slice(0, 2))
          : createElement('img', {
              className: 'trv-wall-img',
              src: place.photoUrl,
              alt: place.name,
              loading: 'lazy',
              referrerPolicy: 'no-referrer',
              onError: (event: React.SyntheticEvent<HTMLImageElement>) => {
                event.currentTarget.style.visibility = 'hidden'
              },
            }),
        createElement('span', { className: 'trv-wall-name' }, place.name),
        createElement('span', { className: 'trv-wall-meta' }, `${place.categories[0] ?? '未分类'} · ${placeStatusLabel(place.status)}`),
      ),
    ),
  )
}

/**
 * What each alert code means, why it appears, and the action that clears it.
 *
 * `clear` is a bare verb phrase: the button prefixes it with 「让 Agent 」and the
 * seeded instruction prefixes it with 「请」, so neither can double up.
 */
export const ALERT_INFO: Readonly<Record<string, { readonly label: string; readonly what: string; readonly clear: string }>> = {
  MISSING_ROUTE: { label: '缺少交通', what: '相邻两站之间还没有交通记录，时间轴里也看不到这段路。', clear: '补上这一天的交通' },
  ROUTE_STALE: { label: '路线待刷新', what: '交通数据放置太久，线路或路况可能已经变化。', clear: '重算这一天的交通' },
  ROUTE_FAILED: { label: '路线规划失败', what: '上一次查询这段交通没有成功。', clear: '重算这一天的交通' },
  TIME_OVERLAP: { label: '时间冲突', what: '两项安排的时间区间有重叠，实际走不完。', clear: '重排这一天的时间' },
  DAY_OVERLOADED: { label: '当天过载', what: '当天「停留 + 交通」的总时长超过了 10 小时。', clear: '精简这一天' },
  PACE_EXCEEDED: { label: '节奏偏紧', what: '连续行程超过了你设定的节奏。', clear: '放缓这一天的节奏' },
  EMPTY_DAY: { label: '空白天', what: '这一天还没有任何安排。', clear: '给这一天安排几个地点' },
  PLACE_UNKNOWN: { label: '地点缺失', what: '安排引用的地点不在地点库里。', clear: '补全缺失的地点' },
  BUDGET_EXCEEDED: { label: '预算超限', what: '估算总额超过了预算上限。', clear: '调整预算或删减安排' },
  BUDGET_UNKNOWN: { label: '预算未估', what: '还没有填写估算总额，无法判断是否超支。', clear: '估算这趟的费用' },
  PLACE_FACT_STALE: { label: '地点信息待刷新', what: '地点信息放置超过 24 小时，营业时间等可能变了。', clear: '刷新地点信息' },
}

/** Severity-ordered alert cards, each explaining itself and offering its fix. */
function AlertsList(props: {
  readonly view: TravelView
  readonly onAskAgent: (text: string) => void
  readonly onJump: (dayId: string) => void
}): ReactElement {
  const view = props.view
  if (view.alerts.length === 0) {
    return createElement('div', { className: 'trv-empty' }, '当前没有发现问题：路线齐全、时间不冲突、预算也在范围内。')
  }
  const actionable = view.alerts.filter((alert) => alert.severity !== 'info')
  return createElement(
    'div',
    { className: 'trv-alerts' },
    createElement(
      'p',
      { className: 'trv-alerts-intro' },
      `${String(view.alerts.length)} 条提醒，其中 ${String(actionable.length)} 条需要你决定。`,
      '提醒是代码算出来的，不是模型写的：它只告诉你「哪里还不确定」，不代表行程好坏。',
    ),
    ...view.alerts.map((alert) => {
      const info = ALERT_INFO[alert.code]
      const dayId = alert.relatedIds.find((id) => /^d\d+$/.test(id))
      const day = dayId === undefined ? undefined : view.days.find((entry) => entry.id === dayId)
      const action = info?.clear ?? '处理这个问题'
      const instruction = dayId === undefined
        ? `请${action}。原因：${alert.message}`
        : `请${action}。目标是 ${dayId}${day === undefined ? '' : `（${day.title}）`}。原因：${alert.message}。`
          + '如果改动影响到相邻几站，请顺带用 travel_day_rebuild_legs 重新计算真实交通并校正当天时间；已锁定的安排保持不动。'
      return createElement(
        'article',
        { key: alert.id, className: `trv-alert trv-alert-${alert.severity}` },
        createElement(
          'div',
          { className: 'trv-alert-head' },
          createElement('span', { className: 'trv-alert-label' }, info?.label ?? alert.code),
          createElement('span', { className: `trv-alert-sev trv-alert-sev-${alert.severity}` }, severityLabel(alert.severity)),
        ),
        createElement('p', { className: 'trv-alert-msg' }, alert.message),
        info === undefined ? null : createElement('p', { className: 'trv-alert-what' }, info.what),
        createElement(
          'div',
          { className: 'trv-alert-actions-row' },
          createElement(
            'button',
            { type: 'button', className: 'trv-btn', onClick: () => props.onAskAgent(instruction) },
            `让 Agent ${info?.clear ?? '处理'}`,
          ),
          dayId === undefined ? null : createElement('button', { type: 'button', className: 'trv-btn', onClick: () => props.onJump(dayId) }, '定位到这一天'),
          createElement('code', { className: 'trv-alert-code' }, alert.code),
        ),
      )
    }),
    createElement('p', { className: 'trv-alert-foot' }, '「让 Agent …」只会把上面这句话写进输入框，你确认后再发送。'),
  )
}

/** Explains the readiness score, which is otherwise an unexplained number. */
function AboutPanel(props: { readonly view: TravelView; readonly onOpenAlerts: () => void }): ReactElement {
  const headline = props.view.headline
  const counts = headline?.alerts ?? { error: 0, warning: 0, info: 0 }
  const readiness = Math.round((headline?.readiness ?? 0) * 100)
  return createElement(
    'div',
    { className: 'trv-about' },
    createElement(
      'div',
      { className: 'trv-about-head' },
      createElement('div', { className: 'trv-ring trv-ring-big', style: { ['--trv-ready']: String(readiness) } }, createElement('span', null, String(readiness))),
      createElement(
        'div',
        null,
        createElement('div', { className: 'trv-about-title' }, '就绪度'),
        createElement('div', { className: 'trv-about-sub' }, `${String(counts.error)} 条阻塞 · ${String(counts.warning)} 条警告 · ${String(counts.info)} 条提示`),
      ),
    ),
    createElement(
      'ul',
      { className: 'trv-about-list' },
      createElement('li', null, '口径：从 100% 开始，每条阻塞 −25%，每条警告 −5%，最低 0%。'),
      createElement(
        'li',
        null,
        `你当前：100% − 25% × ${String(counts.error)} − 5% × ${String(counts.warning)} = ${String(readiness)}%。`,
      ),
      createElement('li', null, '提示（info）不计分 —— 它们只是说明，不需要你行动。'),
      createElement('li', null, '它衡量的是「这份行程还有多少不确定项」，不是行程好坏：刚建好的行程分数天然偏低。'),
    ),
    createElement(
      'div',
      { className: 'trv-actions' },
      createElement('button', { type: 'button', className: 'trv-btn', onClick: props.onOpenAlerts }, `查看这 ${String(props.view.alerts.length)} 条`),
    ),
  )
}

// Map
// ---------------------------------------------------------------------------

/** One day's located stops, in visit order. */
interface DayStops {
  readonly dayId: string
  readonly date: string
  readonly dayOrder: number
  readonly stops: readonly LocatedStop[]
}

/** Per-day line colours, resolved from theme tokens so light and dark both work. */
const DAY_COLOR_TOKENS: readonly { readonly token: string; readonly fallback: string }[] = [
  { token: '--dsw-alias-brand-primary', fallback: '#3b82f6' },
  { token: '--dsw-alias-state-success-primary', fallback: '#17a34a' },
  { token: '--dsw-alias-state-warn-primary', fallback: '#d97706' },
  { token: '--dsw-alias-state-error-primary', fallback: '#dc2626' },
  { token: '--dsw-alias-label-primary', fallback: '#111827' },
]

/**
 * How each further lap through the palette is shifted, so five hues can name
 * fourteen days.
 *
 * The theme exposes five usable colours, and `index % 5` gave D1, D6 and D11 the
 * same blue — a two-week trip drew the same line colour three times over. Each
 * lap is now blended toward white, then toward black.
 */
const DAY_TONE_STEPS: readonly number[] = [0, 0.4, -0.32]

/** Palette entry for one day index. */
function dayTone(index: number): { readonly token: string; readonly fallback: string } {
  return DAY_COLOR_TOKENS[index % DAY_COLOR_TOKENS.length] as { readonly token: string; readonly fallback: string }
}

/** How far this day's colour is blended: positive toward white, negative toward black. */
function dayShift(index: number): number {
  const lap = Math.floor(index / DAY_COLOR_TOKENS.length)
  return DAY_TONE_STEPS[lap % DAY_TONE_STEPS.length] ?? 0
}

/**
 * A stable name for one day's colour, for tests: two days that share a name are
 * drawn identically.
 *
 * @param index - 0-based day index.
 * @returns the palette token plus the lap's blend.
 */
export function dayColorKey(index: number): string {
  return `${dayTone(index).token}#${String(dayShift(index))}`
}

/** Blend a `#rrggbb` colour toward white (positive) or black (negative). */
export function mixHex(hex: string, amount: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (match?.[1] === undefined || amount === 0) return hex
  const value = Number.parseInt(match[1], 16)
  const target = amount > 0 ? 255 : 0
  const ratio = Math.min(1, Math.abs(amount))
  const channel = (shift: number): string => {
    const part = (value >> shift) & 0xff
    return Math.round(part + (target - part) * ratio)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(16)}${channel(8)}${channel(0)}`
}

/** A concrete colour AMap's canvas accepts. */
function dayColor(index: number): string {
  const tone = dayTone(index)
  return mixHex(themeColor(tone.token, tone.fallback), dayShift(index))
}

/** The same colour as a CSS value, for DOM decorations. */
function dayColorCss(index: number): string {
  const tone = dayTone(index)
  const shift = dayShift(index)
  if (shift === 0) return `var(${tone.token})`
  const percent = Math.round((1 - Math.abs(shift)) * 100)
  return shift > 0
    ? `color-mix(in srgb, var(${tone.token}) ${String(percent)}%, #fff)`
    : `color-mix(in srgb, var(${tone.token}) ${String(percent)}%, #000)`
}

/**
 * The map: a real AMap surface when the host supplied a key, otherwise a
 * coordinate schematic. Both draw the same coordinates, so the panel is never
 * empty when the script, the key or the network is unavailable.
 */
export function TripMap(props: {
  readonly map: MapView
  readonly days: readonly DayView[]
  readonly day: DayView | undefined
  readonly range: MapRange
  readonly tier: MapTier
  /** The day the itinerary is showing; the map emphasises it. */
  readonly activeDayId: string | undefined
  readonly onRange: (range: MapRange) => void
  readonly onTier: (tier: MapTier) => void
  readonly selectedPlaceId: string | undefined
  readonly onSelect: (placeId: string) => void
  /**
   * 只有标题的赶路日，一次点击就能让高德把它们补成真实路线。
   *
   * 面板拿不到这个动作时（老宿主、或只是渲染地图做测试）不显示入口：按钮点不动比
   * 没有按钮更糟。
   */
  readonly pendingFillDays?: readonly string[] | undefined
  readonly onFill?: (() => void) | undefined
  readonly fillBusy?: boolean | undefined
}): ReactElement {
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [dragHeight, setDragHeight] = useState<number | undefined>(undefined)
  /** The canvas box, coarsely: what a fit was computed against. */
  const [box, setBox] = useState('0x0')
  /** Live zoom, so the marker names follow how much room the view has. */
  const [zoom, setZoom] = useState(0)
  /** Flipped once the AMap instance exists, so a pick made while it loaded still lands. */
  const [mapReady, setMapReady] = useState(false)
  /** The place the map has already moved to, so a re-render cannot move it again. */
  const focused = useRef<string | undefined>(undefined)
  const container = useRef<HTMLDivElement | null>(null)
  const instance = useRef<AmapMap | undefined>(undefined)
  const overlays = useRef<readonly unknown[]>([])
  /** Overlays per day, so 「聚焦」 can fit the view to one day. */
  const overlaysByDay = useRef(new Map<string, unknown[]>())
  /** What the view was last fitted to; a re-emphasis must not move the map. */
  const fitted = useRef<string | undefined>(undefined)

  const groups = useMemo(() => buildGroups(props.days, props.day, props.range), [props.days, props.day, props.range])
  // 赶路日的路线，本轮新增的主角。它同时喂给真图、示意图和图例，所以只算一次。
  const routes = useMemo(() => drawnRoutesOf(groups, props.days), [groups, props.days])
  const pendingFill = props.pendingFillDays ?? []
  const key = props.map.key
  const version = props.map.version
  const enabled = props.map.enabled && key !== undefined && failure === undefined
  const onSelect = props.onSelect
  const selectedPlaceId = props.selectedPlaceId

  useEffect(() => {
    if (!enabled || key === undefined) return undefined
    let cancelled = false
    void loadAmap(version, key)
      .then((namespace) => {
        if (cancelled || namespace === undefined || container.current === null || instance.current !== undefined) return
        instance.current = new namespace.Map(container.current, {
          zoom: 12,
          center: [116.397428, 39.90923] as const,
          mapStyle: chooseMapStyle(),
          viewMode: '2D',
          zooms: [3, 20],
          // The map lives in a container query, so its box changes when the pane
          // does; without this the canvas keeps the size it was born with.
          resizeEnable: true,
        })
        const created = instance.current
        if (created !== undefined) {
          created.on('zoomend', () => setZoom(created.getZoom()))
          setZoom(created.getZoom())
          setMapReady(true)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(describeMapError(error))
      })
    return () => {
      cancelled = true
      const map = instance.current
      instance.current = undefined
      overlays.current = []
      // The next instance has never been fitted, whatever the previous one did.
      fitted.current = undefined
      focused.current = undefined
      setMapReady(false)
      map?.destroy()
    }
  }, [enabled, key, version])

  useEffect(() => {
    if (!enabled || key === undefined) return undefined
    const node = container.current
    if (node === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      const rect = node.getBoundingClientRect()
      // Snapped to a 24px grid: dragging a pane edge fires continuously and each
      // step would otherwise rebuild every overlay to re-fit the same route.
      setBox(`${String(Math.round(rect.width / 24) * 24)}x${String(Math.round(rect.height / 24) * 24)}`)
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [enabled, key, version])

  useEffect(() => {
    if (!enabled || key === undefined) return undefined
    let cancelled = false
    void loadAmap(version, key)
      .then((namespace) => {
        const map = instance.current
        if (cancelled || namespace === undefined || map === undefined) return
        map.remove(overlays.current)
        const created: unknown[] = []
        const emphasise = props.range === 'all' && groups.length > 1
        const byDay = new Map<string, unknown[]>()
        for (const [groupIndex, group] of groups.entries()) {
          // The day's own position in the trip, not its position in the drawn
          // set: `buildGroups` skips days without coordinates, and a skipped day
          // must not shift every colour and label — the day list beside the map
          // colours its rows by trip position too.
          const colorIndex = group.dayOrder - 1
          const color = dayColor(colorIndex)
          const current = props.activeDayId === undefined || group.dayId === props.activeDayId
          const dayOverlays: unknown[] = []
          for (const [stopIndex, stop] of group.stops.entries()) {
            const selected = stop.placeId === selectedPlaceId
            // Every stop is a teardrop; the day's first one is the anchor that
            // carries `D3`. The others keep their place in the day, and their
            // name once the view is zoomed in far enough to hold it.
            const anchor = stopIndex === 0
            const label = pinLabel(props.range, group.dayOrder, stopIndex)
            // Other days are dimmed, but only a little: at 0.3 the fourteen days
            // that are not under the cursor were unreadable, which is the whole
            // point of the whole-trip view.
            const opacity = selected ? 1 : emphasise ? (current ? 1 : 0.78) : 1
            const marker = new namespace.Marker({
              position: [stop.point.longitude, stop.point.latitude] as const,
              anchor: 'bottom-center',
              zIndex: selected ? 200 : current ? 100 + stopIndex : 60 + stopIndex,
              content: pinElement(
                label,
                stop.name ?? '',
                selected,
                selected ? themeColor('--dsw-alias-brand-primary', '#3b82f6') : color,
                opacity,
                !anchor && props.range === 'all',
              ),
            })
            marker.on('click', () => onSelect(stop.placeId))
            created.push(marker)
            dayOverlays.push(marker)
          }
          byDay.set(group.dayId, dayOverlays)
        }
        for (const group of groups) {
          const day = props.days.find((entry) => entry.id === group.dayId)
          const colorIndex = group.dayOrder - 1
          const current = props.activeDayId === undefined || group.dayId === props.activeDayId
          for (const transit of day?.transits ?? []) {
            const path = transitPath(transit)
            if (path.length < 2) continue
            // 这条线由下面那条 drive line 画（更粗、还带里程胶囊）：同一条路上再压一条
            // 逐字重合的折线只是重复，fit 集合里也多一份同样的几何。
            if (routeCovers(routes, group.dayId, path)) continue
            // Solid, unlike the dashed stop order: this is the road itself.
            const line = new namespace.Polyline({
              path,
              strokeColor: dayColor(colorIndex),
              strokeWeight: current ? 5 : 3,
              strokeOpacity: emphasise ? (current ? 0.9 : 0.55) : 0.8,
              strokeStyle: 'solid',
              zIndex: current ? 55 : 45,
            })
            created.push(line)
            byDay.set(group.dayId, [...(byDay.get(group.dayId) ?? []), line])
          }
        }
        for (const end of transitEnds(groups, props.days)) {
          const current = props.activeDayId === undefined || end.dayId === props.activeDayId
          const marker = new namespace.Marker({
            position: [end.point.longitude, end.point.latitude] as const,
            anchor: 'center',
            zIndex: current ? 90 : 50,
            content: endElement(`${end.role === 'from' ? '出发' : '抵达'}：${end.label}`, dayColor(end.colorIndex), current ? 0.95 : 0.7),
          })
          created.push(marker)
          byDay.set(end.dayId, [...(byDay.get(end.dayId) ?? []), marker])
        }
        // 赶路日的路线。实线是已经规划过的路，长虚线只是把标题里的里程画出来：两者
        // 都比站点顺序的细虚线粗，一眼能分开。
        for (const route of routes) {
          const current = props.activeDayId === undefined || route.dayId === props.activeDayId
          const estimated = route.kind === 'estimated'
          const line = new namespace.Polyline({
            path: route.path,
            strokeColor: dayColor(route.colorIndex),
            strokeWeight: estimated ? (current ? 4 : 3) : current ? 6 : 4,
            strokeOpacity: emphasise ? (current ? 0.95 : 0.6) : 0.9,
            strokeStyle: estimated ? 'dashed' : 'solid',
            ...estimated ? { strokeDasharray: [14, 9] } : {},
            zIndex: estimated ? (current ? 56 : 46) : current ? 58 : 48,
          })
          created.push(line)
          // 路线进 byDay：当天模式与「聚焦当前天」要连整条路一起框住 —— 单站日过去
          // 一条线都没有，正是这里补上的。
          const routeMid = pathMidpoint(route.path)
          const label = new namespace.Marker({
            position: [routeMid[0], routeMid[1]] as const,
            anchor: 'center',
            zIndex: current ? 92 : 52,
            content: driveLabelElement(route.label, dayColor(route.colorIndex), current ? 1 : 0.78),
          })
          created.push(line, label)
          byDay.set(route.dayId, [...(byDay.get(route.dayId) ?? []), line, label])
        }
        for (const segment of buildRouteSegments(groups)) {
          const owner = groups[segment.dayIndex]
          const current = props.activeDayId === undefined || owner?.dayId === props.activeDayId
          const line = new namespace.Polyline({
            path: segment.points.map((stop) => [stop.point.longitude, stop.point.latitude] as const),
            strokeColor: dayColor((owner?.dayOrder ?? segment.dayIndex + 1) - 1),
            strokeWeight: emphasise ? (current ? 5 : 3) : 3,
            strokeOpacity: emphasise ? (current ? 0.95 : 0.6) : 0.85,
            strokeStyle: 'dashed',
            strokeDasharray: [6, 6],
            zIndex: current ? 50 : 40,
          })
          created.push(line)
          if (owner !== undefined) byDay.set(owner.dayId, [...(byDay.get(owner.dayId) ?? []), line])
        }
        overlaysByDay.current = byDay
        map.add(created)
        overlays.current = created
        // Fit when the drawn set changes or the box does — never on an emphasis
        // change, so emphasising another day while the itinerary scrolls cannot
        // yank the map around.
        const fitKey = fitKeyOf(props.range, groups, props.days, box)
        if (fitted.current !== fitKey) {
          fitted.current = fitKey
          map.setFitView(created, false, [44, 44, 44, 44])
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(describeMapError(error))
      })
    return () => {
      cancelled = true
    }
  }, [enabled, key, version, groups, routes, props.range, props.activeDayId, selectedPlaceId, onSelect, box])

  /**
   * Bring the picked place into view.
   *
   * Selection is what the reader did — clicking a stop card, or a place in the
   * library — so the map answers it. The day emphasis that the scroll spy drives
   * deliberately does not come through here: scrolling the itinerary must not
   * move the map, which is what makes the map worth keeping on screen at all.
   */
  useEffect(() => {
    const map = instance.current
    if (map === undefined) return
    const placeId = props.selectedPlaceId
    if (placeId === undefined) {
      focused.current = undefined
      return
    }
    // One move per pick. The view is re-projected on every poll, so without this
    // a selection would drag the map back to its place every few seconds.
    if (focused.current === placeId) return
    const point = focusPointFor(groups, placeId)
    if (point === undefined) return
    focused.current = placeId
    // Keep a zoom the reader already chose; otherwise come in close enough to
    // see which street the place is on.
    map.setZoomAndCenter(
      Math.max(map.getZoom(), FOCUS_ZOOM),
      [point.longitude, point.latitude] as const,
      false,
    )
  }, [props.selectedPlaceId, groups, mapReady])

  /** Zoom the map to the day the itinerary is showing. */
  const focusActiveDay = useCallback((): void => {
    const id = props.activeDayId
    if (id === undefined || instance.current === undefined) return
    const overlays = overlaysByDay.current.get(id) ?? []
    if (overlays.length === 0) return
    instance.current.setFitView(overlays, false, [64, 64, 64, 64])
  }, [props.activeDayId])

  /** Put every drawn stop back into the frame. */
  const fitAll = useCallback((): void => {
    if (instance.current === undefined || overlays.current.length === 0) return
    instance.current.setFitView(overlays.current, false, [44, 44, 44, 44])
    // A manual fit is the new reference: an automatic one must not undo it for
    // the same drawn set.
    fitted.current = fitKeyOf(props.range, groups, props.days, box)
  }, [props.range, groups, props.days, box])

  const tierIndex = MAP_TIERS.indexOf(props.tier)
  const nextTier = MAP_TIERS[(tierIndex + 1) % MAP_TIERS.length] as MapTier
  const totalStops = groups.reduce((sum, group) => sum + group.stops.length, 0)
  // Names live on the card rather than on the canvas element: AMap owns that
  // element's class list, and React rewriting it would drop what AMap put there.
  const named = enabled && showPinNames(zoom, totalStops)

  return createElement(
    'div',
    {
      className: `trv-map-card trv-map-${props.tier}${props.range === 'all' ? ' trv-map-all' : ''}${named ? ' trv-map-labels' : ''}${dragHeight === undefined ? '' : ' trv-map-dragging'}`,
      style: dragHeight === undefined ? undefined : { height: `${String(dragHeight)}px` },
    },
    enabled
      ? createElement('div', { className: 'trv-amap', ref: container })
      : createElement(MapSketch, {
          groups,
          days: props.days,
          routes,
          range: props.range,
          selectedPlaceId,
          select: props.onSelect,
        }),
    createElement(
      'div',
      { className: 'trv-map-bar' },
      createElement(
        'div',
        { className: 'trv-seg' },
        segment('当天', props.range === 'day', () => props.onRange('day')),
        segment('全程', props.range === 'all', () => props.onRange('all')),
      ),
      createElement('span', { className: 'trv-map-spacer' }),
      props.range === 'all' && props.activeDayId !== undefined
        ? createElement(
            'button',
            { type: 'button', className: 'trv-chip-button', title: '把地图缩放到当前这一天', onClick: focusActiveDay },
            '聚焦当前天',
          )
        : null,
      createElement(
        'button',
        {
          type: 'button',
          className: 'trv-map-btn',
          title: '把整条路线重新装进画面',
          'aria-label': '重置视图',
          onClick: fitAll,
        },
        '⟲',
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'trv-map-btn',
          title: props.tier === 'full' ? '退出大图' : '放大地图',
          'aria-label': props.tier === 'full' ? '退出大图' : '放大地图',
          onClick: () => props.onTier(nextTier),
        },
        props.tier === 'full' ? '✕' : '⤢',
      ),
    ),
    // 图例说明线型，两种模式都留着：全程模式里每一条赶路路线同样需要解释，而
    // 一条线都没有的空白图什么也不必说。
    totalStops === 0 && routes.length === 0
      ? null
      : createElement('div', { className: 'trv-map-note' }, MAP_LEGEND),
    // 只有标题的赶路日：一次点击让高德把这一天补成真实路线，省掉「记为转场」再
    // 「用高德重算」的两次操作。没有可补的日子就不出现。
    pendingFill.length === 0 || props.onFill === undefined
      ? null
      : createElement(
          'div',
          { className: 'trv-map-fill' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'trv-btn trv-btn-primary trv-map-fill-act',
              disabled: props.fillBusy === true,
              title: `只有标题的赶路日：${pendingFill.join('、')}`,
              onClick: props.onFill,
            },
            props.fillBusy === true ? '补全中…' : `补全 ${String(pendingFill.length)} 天路线`,
          ),
        ),
    props.tier === 'full' && props.range === 'day' && props.day !== undefined
      ? createElement(
          'div',
          { className: 'trv-map-strip' },
          ...props.day.items.map((item, index) =>
            createElement(
              'button',
              {
                key: item.id,
                type: 'button',
                className: `trv-chip-button${item.placeId === selectedPlaceId ? ' trv-chip-button-on' : ''}`,
                onClick: () => props.onSelect(item.placeId),
              },
              `${String(index + 1)} ${item.name}`,
            ),
          ),
        )
      : null,
    props.tier === 'full'
      ? null
      : createElement('div', {
          className: 'trv-map-grip',
          title: '拖动调整地图高度',
          onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
            const startY = event.clientY
            const startHeight = event.currentTarget.parentElement?.getBoundingClientRect().height ?? 168
            const target = event.currentTarget
            target.setPointerCapture(event.pointerId)
            const move = (moveEvent: PointerEvent): void => {
              setDragHeight(Math.max(120, Math.min(window.innerHeight * 0.7, startHeight + (moveEvent.clientY - startY))))
            }
            const up = (): void => {
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
              setDragHeight(undefined)
              setDragHeight(undefined)
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          },
        }),
    failure === undefined
      ? null
      : createElement(
          'div',
          { className: 'trv-map-fallback' },
          createElement('span', null, failure),
          createElement('button', { type: 'button', className: 'trv-btn', onClick: () => setFailure(undefined) }, '重试'),
        ),
  )
}

/** One segment of a small two-way switch. */
function segment(label: string, active: boolean, onClick: () => void): ReactElement {
  return createElement(
    'button',
    { type: 'button', className: `trv-seg-item${active ? ' trv-seg-on' : ''}`, onClick },
    label,
  )
}

/**
 * Group the stops to draw.
 *
 * Exported so the day/whole-trip grouping is testable without a DOM.
 *
 * @param days - Every day of the active scenario, in order.
 * @param day - The day currently in focus.
 * @param range - Whether to draw one day or the whole trip.
 * @returns One group per drawn day, in day order; days with nothing to draw are skipped.
 */
export function buildGroups(days: readonly DayView[], day: DayView | undefined, range: MapRange): readonly DayStops[] {
  const source = range === 'all' ? days : day === undefined ? [] : [day]
  // 一天只要有路可画就该进绘制集合：只有标题的赶路日没有站点、也没有转场端点，却是
  // 最该看见的那一天。`driveRoutes` 只返回能画出来的路，所以这里不必再判点数。
  const driven = new Set(driveRoutes(days).map((route) => route.dayId))
  const groups: DayStops[] = []
  for (const entry of source) {
    const stops = locateDay(entry)
    // A day spent driving has no stop of its own and is exactly the day the map
    // must show: its transit ends are what there is to draw.
    const locatedEnds = (entry.transits ?? []).some(
      (transit) => transit.from.point !== undefined || transit.to.point !== undefined,
    )
    if (stops.length === 0 && !locatedEnds && !driven.has(entry.id)) continue
    groups.push({ dayId: entry.id, date: entry.date, dayOrder: days.indexOf(entry) + 1, stops })
  }
  return groups
}

/**
 * One drawn line: a day's own stops, extended to the next day's first stop.
 *
 * A two-week drive has days with a single stop — the day's destination. Drawn
 * per day on its own those days carry no line at all, which is what made the
 * whole-trip map look like it was missing legs. Carrying each day's colour into
 * the next day's first stop makes one continuous route.
 *
 * Exported so the shape is testable without a DOM.
 *
 * @param groups - day groups in day order.
 * @returns one segment per day that has at least two points to connect.
 */
export function buildRouteSegments(groups: readonly DayStops[]): readonly {
  readonly dayIndex: number
  readonly points: readonly LocatedStop[]
}[] {
  const segments: { readonly dayIndex: number; readonly points: readonly LocatedStop[] }[] = []
  for (const [index, group] of groups.entries()) {
    const next = groups[index + 1]
    const first = next?.stops[0]
    const points = first === undefined ? group.stops : [...group.stops, first]
    if (points.length < 2) continue
    segments.push({ dayIndex: index, points })
  }
  return segments
}

/** Coordinate schematic used when the real map is unavailable. */
function MapSketch(props: {
  readonly groups: readonly DayStops[]
  readonly days: readonly DayView[]
  /** 赶路日的路线，与真图上画的是同一批：只有标题的那天在这里也必须看得见。 */
  readonly routes: readonly DriveRoute[]
  readonly range: MapRange
  readonly selectedPlaceId: string | undefined
  readonly select: (placeId: string) => void
}): ReactElement {
  const projected = useMemo(() => projectGroups(props.groups, props.days), [props.groups, props.days])
  const segments = useMemo(() => projectSegments(props.groups, props.days), [props.groups, props.days])
  // Transit ends share the stops' projection, so a journey and the stops it
  // joins are drawn on the same coordinates.
  const ends = useMemo(
    () => (props.groups.length === 0 ? [] : transitEnds(props.groups, props.days)),
    [props.groups, props.days],
  )
  const bounds = useMemo(
    () => (props.groups.length === 0 ? undefined : boundsOf(props.groups, props.days)),
    [props.groups, props.days],
  )
  const stops = props.groups.reduce((total, group) => total + group.stops.length, 0)
  // The sketch has no zoom, so the names follow the same rule with zoom 0: they
  // appear when there are few enough stops to name.
  const labels = showPinNames(0, stops)
  if (projected.length === 0 || (ends.length === 0 && stops === 0 && props.routes.length === 0)) {
    return createElement('div', { className: 'trv-map trv-map-empty' }, '这一天还没有带坐标的地点。')
  }
  return createElement(
    'div',
    { className: `trv-map${labels ? ' trv-map-labels' : ''}` },
    createElement(
      'svg',
      { viewBox: '0 0 100 100', preserveAspectRatio: 'none', role: 'img', 'aria-label': '路线示意图' },
      ...segments.map((segment) => {
        const owner = props.groups[segment.dayIndex]
        return createElement('polyline', {
          key: `segment-${String(segment.dayIndex)}`,
          points: segment.points.map((point) => `${String(point.x)},${String(point.y)}`).join(' '),
          className: 'trv-line',
          style: { stroke: dayColorCss((owner?.dayOrder ?? segment.dayIndex + 1) - 1) },
        })
      }),
      // 转场的折线：现在由下面的赶路路线画（更粗、带里程胶囊），这里只在路线没有覆盖
      // 它的时候兜底，免得将来某条转场因为别的原因画不出来就整条消失。
      ...props.days.flatMap((day) => {
        const group = props.groups.find((entry) => entry.dayId === day.id)
        if (group === undefined || bounds === undefined) return []
        const colorIndex = group.dayOrder - 1
        return (day.transits ?? []).flatMap((transit) => {
          const path = transitPath(transit)
          if (path.length < 2) return []
          // 这条线已经由下面那条 trv-drive-line 画出来了（还有里程胶囊）：再画一条
          // 逐字重合的折线只是重复。
          if (routeCovers(props.routes, day.id, path)) return []
          return [
            createElement('polyline', {
              key: `transit-${transit.id}`,
              points: path
                .map(([longitude, latitude]) => {
                  const spot = bounds.project({ longitude, latitude })
                  return `${String(spot.x)},${String(spot.y)}`
                })
                .join(' '),
              className: 'trv-line trv-transit-line',
              style: { stroke: dayColorCss(colorIndex) },
            }),
          ]
        })
      }),
      // 赶路日的路线：同一套投影，所以一条路和它连着的站点一定对得上。实线是已经
      // 规划过的路，长虚线只是标题里的里程 —— 两种线型在这里也必须一眼可分。
      ...props.routes.flatMap((route) => {
        if (bounds === undefined || route.path.length < 2) return []
        return [
          createElement('polyline', {
            key: `drive-${route.id}`,
            points: route.path
              .map(([longitude, latitude]) => {
                const spot = bounds.project({ longitude, latitude })
                return `${String(spot.x)},${String(spot.y)}`
              })
              .join(' '),
            className:
              route.kind === 'estimated'
                ? 'trv-line trv-drive-line trv-drive-line-estimated'
                : 'trv-line trv-drive-line',
            style: { stroke: dayColorCss(route.colorIndex) },
          }),
        ]
      }),
    ),
    createElement(
      'div',
      { className: 'trv-map-marks' },
      ...projected.flatMap((group, groupIndex) => {
        // The day's position in the trip — the same source the real map surface
        // and the day list use — not its position among the drawn groups.
        const dayOrder = props.groups[groupIndex]?.dayOrder ?? groupIndex + 1
        return group.points.map((point, index) =>
          // The sketch mirrors the real surface: the same teardrops, the same
          // day anchor, the same names.
          createElement(
            'button',
            {
              key: `${group.dayId}-${String(index)}-${point.id}`,
              type: 'button',
              className: `trv-map-pin${index > 0 && props.range === 'all' ? ' trv-map-pin-sm' : ''}${point.id === props.selectedPlaceId ? ' trv-map-pin-on' : ''}`,
              style: {
                left: `${String(point.x)}%`,
                top: `${String(point.y)}%`,
                ['--trv-pin']: dayColorCss(dayOrder - 1),
              },
              title: point.name,
              'aria-label': point.name === '' ? '站点' : point.name,
              onClick: () => props.select(point.id),
            },
            createElement('span', { className: 'trv-map-pin-id' }, pinLabel(props.range, dayOrder, index)),
            createElement('span', { className: 'trv-map-pin-name' }, point.name),
          ),
        )
      }),
      ...ends.flatMap((end) => {
        const spot = bounds?.project(end.point)
        if (spot === undefined) return []
        return [
          createElement('div', {
            key: end.id,
            className: 'trv-map-end',
            style: {
              left: `${String(spot.x)}%`,
              top: `${String(spot.y)}%`,
              ['--trv-pin']: dayColorCss(end.colorIndex),
            },
            title: `${end.role === 'from' ? '出发' : '抵达'}：${end.label}`,
          }),
        ]
      }),
      // 路线胶囊压在路上：多点的路取累计长度的一半，标签才不会落在拐角上。
      ...props.routes.flatMap((route) => {
        const [longitude, latitude] = pathMidpoint(route.path)
        const spot = bounds?.project({ longitude, latitude })
        if (spot === undefined) return []
        return [
          createElement(
            'div',
            {
              key: `drive-label-${route.id}`,
              className: 'trv-drive-label',
              style: {
                left: `${String(spot.x)}%`,
                top: `${String(spot.y)}%`,
                ['--trv-pin']: dayColorCss(route.colorIndex),
              },
              title: route.label,
            },
            route.label,
          ),
        ]
      }),
    ),
  )
}

/**
 * One pin element for the AMap surface: a teardrop whose head carries the stop's
 * number, with the place's name above it.
 *
 * @param label - the number (or `D3`) drawn in the head.
 * @param name - the place name, shown when the view has room for it.
 * @param selected - whether this stop is the one being read.
 * @param color - fill colour, from the day's palette entry.
 * @param opacity - 1 for the day in view, a little less for the other days.
 * @param small - true for the stops after a day's first one.
 * @returns the marker's DOM node.
 */
function pinElement(
  label: string,
  name: string,
  selected: boolean,
  color: string,
  opacity: number,
  small: boolean,
): HTMLElement {
  const element = document.createElement('div')
  element.className = `trv-map-pin trv-amap-pin${small ? ' trv-map-pin-sm' : ''}${selected ? ' trv-map-pin-on' : ''}`
  element.style.setProperty('--trv-pin', color)
  element.style.opacity = String(opacity)
  const id = document.createElement('span')
  id.className = 'trv-map-pin-id'
  id.textContent = label
  const caption = document.createElement('span')
  caption.className = 'trv-map-pin-name'
  caption.textContent = name
  element.append(id, caption)
  return element
}

/**
 * One end of a transit on the AMap surface: a square, so a place the trip
 * merely left from or reached is never mistaken for a stop.
 *
 * @param title - 「出发：西安」 or 「抵达：成都」.
 * @param color - the day's colour.
 * @param opacity - 1 for the day in view, less for the others.
 * @returns the marker's DOM node.
 */
function endElement(title: string, color: string, opacity: number): HTMLElement {
  const element = document.createElement('div')
  element.className = 'trv-map-end trv-amap-pin'
  element.style.setProperty('--trv-pin', color)
  element.style.opacity = String(opacity)
  element.title = title
  return element
}

/**
 * One route's capsule on the AMap surface.
 *
 * 用 Marker 包一个 div（`anchor: 'center'`），路线平移缩放时胶囊自己跟着路走；显隐
 * 沿用站点名字那一套（`.trv-map-labels .trv-drive-label`），所以缩放不需要重建覆盖物。
 *
 * @param text - the route's own line, e.g. `驾车 · ≈723 km · 按标题估算`.
 * @param color - the day's colour, as the capsule's border.
 * @param opacity - 1 for the day in view, less for the others.
 * @returns the marker's DOM node.
 */
function driveLabelElement(text: string, color: string, opacity: number): HTMLElement {
  const element = document.createElement('div')
  element.className = 'trv-drive-label'
  element.style.setProperty('--trv-pin', color)
  element.style.opacity = String(opacity)
  element.textContent = text
  return element
}

/**
 * What the current fit describes: the drawn set and the box it is drawn in.
 *
 * The box belongs in the key because a 2.8:1 canvas and an 0.8:1 canvas fitted
 * to the same route are different pictures — this is the axis the whole-trip map
 * was wrong on.
 *
 * @param range - whether one day or the whole trip is drawn.
 * @param groups - the drawn groups, in day order.
 * @param days - every day of the trip, for the transits among them.
 * @param box - the canvas box, as `WxH`.
 * @returns a key that changes exactly when a re-fit is needed.
 */
export function fitKeyOf(range: MapRange, groups: readonly DayStops[], days: readonly DayView[], box: string): string {
  // Stops alone are not what is drawn: a transit whose ends gained coordinates
  // (a refreshed place, say) changes the picture without changing a stop count.
  // 路线也一样：给一条 stale 转场补上真实 polyline（或「补全 N 天路线」之后）会把这条
  // 路整个改写，而站点数、端点数都不变 —— 那时地图必须把新的路重新装进画面。
  const routes = drawnRoutesOf(groups, days)
    .map((route) => `${route.id}:${route.kind}:${routeSpan(route)}`)
    .join(',')
  return `${range}|${groups
    .map((group) => `${group.dayId}:${String(group.stops.length)}`)
    .join(',')}|${String(transitEnds(groups, days).length)}|${routes}|${box}`
}

/**
 * A route's geometry, small enough for a comparison key.
 *
 * 点数抓「两点直连变成了真实路径」，首尾点抓「点数一样但路改了」——这两种都要求
 * 重新 fit，而任何一种都不会改变站点数量。
 *
 * @param route - the drawn route.
 * @returns point count plus the rounded first and last coordinate.
 */
function routeSpan(route: DriveRoute): string {
  const spot = (point: readonly [number, number] | undefined): string =>
    point === undefined ? '' : `${point[0].toFixed(3)},${point[1].toFixed(3)}`
  return `${String(route.path.length)}@${spot(route.path[0])}~${spot(route.path[route.path.length - 1])}`
}

/**
 * The ends of a day's transits that no stop marker already covers.
 *
 * An endpoint is often a stop of some day — the place the trip left from, or the
 * place it reached — and drawing a second marker on top of it would just be a
 * doubled pin. What is left is the ends that are only names on the map, and
 * those get a marker of their own so a driving day is visible as a journey
 * rather than a bare line.
 *
 * @param groups - the days being drawn, in day order.
 * @param days - every day of the trip, for their transits.
 * @returns one entry per uncovered end, in day order.
 */
export function transitEnds(
  groups: readonly DayStops[],
  days: readonly DayView[],
): readonly {
  readonly id: string
  readonly dayId: string
  readonly colorIndex: number
  readonly label: string
  readonly role: 'from' | 'to'
  readonly point: { readonly longitude: number; readonly latitude: number }
}[] {
  const ends: {
    id: string
    dayId: string
    colorIndex: number
    label: string
    role: 'from' | 'to'
    point: { readonly longitude: number; readonly latitude: number }
  }[] = []
  // Any drawn stop covers an end, on any day: a drive usually starts at where
  // yesterday finished, and a second marker there would sit on top of that pin.
  const drawnStops = groups.flatMap((group) => group.stops.map((stop) => stop.point))
  for (const group of groups) {
    const day = days.find((entry) => entry.id === group.dayId)
    for (const transit of day?.transits ?? []) {
      for (const [role, end] of [['from', transit.from], ['to', transit.to]] as const) {
        if (end.point === undefined) continue
        const covered = drawnStops.some(
          (point) =>
            Math.abs(point.longitude - end.point!.longitude) < 1e-6 &&
            Math.abs(point.latitude - end.point!.latitude) < 1e-6,
        )
        if (covered) continue
        ends.push({
          id: `${transit.id}-${role}`,
          dayId: group.dayId,
          colorIndex: group.dayOrder - 1,
          label: end.label,
          role,
          point: end.point,
        })
      }
    }
  }
  return ends
}

/**
 * Where the map should look to show one place.
 *
 * Only places the map is actually drawing are returned: a stop of another day
 * while a single day is on screen has no marker to move to, and centring on a
 * coordinate nothing is drawn at is just a jump into empty country.
 *
 * @param groups - the days being drawn, in day order.
 * @param placeId - the place the reader picked.
 * @returns its coordinate, or undefined when it is not on the map.
 */
export function focusPointFor(
  groups: readonly DayStops[],
  placeId: string | undefined,
): { readonly longitude: number; readonly latitude: number } | undefined {
  if (placeId === undefined) return undefined
  for (const group of groups) {
    const stop = group.stops.find((entry) => entry.placeId === placeId)
    if (stop !== undefined) return stop.point
  }
  return undefined
}

/**
 * One transit as a drawable path.
 *
 * The provider's own path when the Web-service API answered, otherwise the two
 * ends: a straight line is honest about being a straight line, and it still
 * tells the reader which way the day went.
 *
 * @param transit - the day's transit.
 * @returns ordered coordinates, or an empty list when neither end is located.
 */
function transitPath(transit: TransitView): readonly (readonly [number, number])[] {
  if (transit.polyline !== undefined && transit.polyline !== '') {
    const points: (readonly [number, number])[] = []
    for (const pair of transit.polyline.split(';')) {
      const [lng, lat] = pair.split(',')
      const longitude = Number.parseFloat(lng ?? '')
      const latitude = Number.parseFloat(lat ?? '')
      if (Number.isFinite(longitude) && Number.isFinite(latitude)) points.push([longitude, latitude])
    }
    if (points.length >= 2) return points
  }
  const from = transit.from.point
  const to = transit.to.point
  return from === undefined || to === undefined
    ? []
    : [
        [from.longitude, from.latitude],
        [to.longitude, to.latitude],
      ]
}

/** Coordinates of one day's items, in visit order. */
function locateDay(day: DayView | undefined): readonly LocatedStop[] {
  const located: LocatedStop[] = []
  for (const item of day?.items ?? []) {
    if (item.point === undefined) continue
    located.push({ placeId: item.placeId, name: item.name, point: item.point })
  }
  return located
}

/** Loader promises by `version:key`, so the script is fetched once per page. */
const loaderPromises = new Map<string, Promise<AmapNamespace | undefined>>()

/**
 * Load the AMap JS API once per page.
 * @param version - JS API version.
 * @param key - Web (JS API) key.
 * @returns the namespace, or undefined when the loader never arrived in time.
 */
function loadAmap(version: string, key: string): Promise<AmapNamespace | undefined> {
  const cacheKey = `${version}:${key}`
  const cached = loaderPromises.get(cacheKey)
  if (cached !== undefined) return cached
  const pending = new Promise<AmapNamespace | undefined>((resolve, reject) => {
    if (typeof document === 'undefined') {
      resolve(undefined)
      return
    }
    const timeout = window.setTimeout(() => {
      reject(new Error('地图组件加载超时，已退回示意图'))
    }, AMAP_LOAD_TIMEOUT_MS)
    const start = (): void => {
      const loader = window.AMapLoader
      if (loader === undefined) {
        window.clearTimeout(timeout)
        reject(new Error('地图组件未就绪'))
        return
      }
      loader
        .load({ key, version, plugins: [] })
        .then((namespace) => {
          window.clearTimeout(timeout)
          resolve(namespace)
        })
        .catch((error: unknown) => {
          window.clearTimeout(timeout)
          reject(error)
        })
    }
    if (window.AMapLoader !== undefined) {
      start()
      return
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-skillre-amap]')
    if (existing !== null) {
      existing.addEventListener('load', start, { once: true })
      existing.addEventListener('error', () => {
        window.clearTimeout(timeout)
        reject(new Error('地图组件下载失败'))
      }, { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = AMAP_LOADER_SRC
    script.async = true
    script.dataset['skillreAmap'] = 'true'
    script.addEventListener('load', start, { once: true })
    script.addEventListener('error', () => {
      window.clearTimeout(timeout)
      reject(new Error('地图组件下载失败，检查网络后重试'))
    }, { once: true })
    document.head.appendChild(script)
  })
  // A rejected promise must not be cached, or the retry button can never succeed.
  pending.catch(() => {
    loaderPromises.delete(cacheKey)
  })
  loaderPromises.set(cacheKey, pending)
  return pending
}

/** Turn an AMap or loader failure into an actionable sentence. */
function describeMapError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/INVALID_USER_KEY|USERKEY|无效|INVALID/i.test(message)) {
    return '当前 Key 未授权浏览器端使用：需要「Web 端(JS API)」类型的 Key，并放开来源限制'
  }
  return message
}

/** Pick a base map style from the current DSH surface colour. */
function chooseMapStyle(): string {
  if (typeof document === 'undefined') return 'normal'
  const surface = getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim()
  const rgb = parseColor(surface)
  if (rgb === undefined) return 'normal'
  const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
  return luminance < 0.5 ? 'darkblue' : 'normal'
}

/**
 * Read one theme token as a canvas-compatible colour.
 *
 * AMap draws its overlays on a canvas, where a CSS variable cannot resolve, so
 * the token has to be read back into a concrete value first.
 * @param token - CSS custom property name.
 * @param fallback - value used when the token is missing or is not a colour.
 * @returns a colour string the canvas accepts.
 */
function themeColor(token: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  return parseColor(value) === undefined ? fallback : value
}

/** Parse `#rgb`, `#rrggbb` or `rgb(...)` into channel values. */
function parseColor(value: string): readonly [number, number, number] | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
  if (hex?.[1] !== undefined) {
    const digits = hex[1].length === 3 ? hex[1].split('').map((digit) => digit + digit).join('') : hex[1]
    return [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
    ]
  }
  const functional = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(value)
  if (functional !== null) {
    return [Number(functional[1]), Number(functional[2]), Number(functional[3])]
  }
  return undefined
}

/**
 * Project every group into shared percentage coordinates.
 * @param groups - Groups to project together, so days stay comparable.
 * @returns One projected group per input group that has stops.
 */
/** The band a sketch draws in; also the room a pin needs above its anchor. */
interface SketchBounds {
  readonly project: (point: { readonly longitude: number; readonly latitude: number }) => { readonly x: number; readonly y: number }
}

/** Fit every stop of every group into the 0-100 box once, so days stay comparable. */
function boundsOf(groups: readonly DayStops[], days: readonly DayView[]): SketchBounds {
  // A driving day is often the widest thing in the drawing, and it has no stop
  // of its own: its transit ends belong in the frame or the sketch would crop
  // the journey it exists to show.
  const all = [
    ...groups.flatMap((group) => group.stops).map((stop) => stop.point),
    ...transitEnds(groups, days).map((end) => end.point),
    // 借相邻天的站点估出来的那条路，端点不一定在任何被画出的站点上：包围盒自己
    // 把它算进去，否则线会被裁在框外。
    ...drawnRoutesOf(groups, days).flatMap((route) =>
      route.path.map(([longitude, latitude]) => ({ longitude, latitude })),
    ),
  ]
  const first = all[0] ?? { longitude: 0, latitude: 0 }
  const longitudes = all.map((point) => point.longitude)
  const latitudes = all.map((point) => point.latitude)
  const minLng = longitudes.length === 0 ? first.longitude : Math.min(...longitudes)
  const maxLng = longitudes.length === 0 ? first.longitude : Math.max(...longitudes)
  const minLat = latitudes.length === 0 ? first.latitude : Math.min(...latitudes)
  const maxLat = latitudes.length === 0 ? first.latitude : Math.max(...latitudes)
  const spanLng = Math.max(maxLng - minLng, 0.004)
  const spanLat = Math.max(maxLat - minLat, 0.004)
  // A pin is drawn above its anchor, so the band keeps room for the label: a
  // 35px pin must not be clipped by the card's top edge.
  const padX = 14
  const top = 30
  const bottom = 88
  return {
    project: (point) => ({
      x: padX + ((point.longitude - minLng) / spanLng) * (100 - padX * 2),
      y: bottom - ((point.latitude - minLat) / spanLat) * (bottom - top),
    }),
  }
}

function projectGroups(groups: readonly DayStops[], days: readonly DayView[]): readonly { readonly dayId: string; readonly points: readonly { readonly id: string; readonly name: string; readonly x: number; readonly y: number }[] }[] {
  const all = groups.flatMap((group) => group.stops)
  const bounds = boundsOf(groups, days)
  return groups.map((group) => ({
    dayId: group.dayId,
    points: group.stops.map((stop) => ({ id: stop.placeId, name: stop.name ?? '', ...bounds.project(stop.point) })),
  }))
}

/** Projected polylines of every route segment, for the schematic fallback. */
function projectSegments(
  groups: readonly DayStops[],
  days: readonly DayView[],
): readonly { readonly dayIndex: number; readonly points: readonly { readonly x: number; readonly y: number }[] }[] {
  if (groups.length === 0) return []
  const bounds = boundsOf(groups, days)
  return buildRouteSegments(groups).map((segment) => ({
    dayIndex: segment.dayIndex,
    points: segment.points.map((stop) => bounds.project(stop.point)),
  }))
}

// Loading skeleton and state
// ---------------------------------------------------------------------------

/** Placeholder rows while the first state read is in flight. */
function Skeleton(): ReactElement {
  return createElement(
    'div',
    { className: 'trv-skeleton' },
    createElement('div', { className: 'trv-skeleton-row trv-skeleton-title' }),
    createElement('div', { className: 'trv-skeleton-row' }),
    createElement('div', { className: 'trv-skeleton-map' }),
    createElement('div', { className: 'trv-skeleton-row' }),
    createElement('div', { className: 'trv-skeleton-row trv-skeleton-short' }),
  )
}

/** Load and refresh the travel state from the host API. */
function useTravelState(props: BodyProps, poll: boolean): {
  readonly view: TravelView | undefined
  readonly amap: AmapRuntimeView | undefined
  readonly loading: boolean
  readonly error: string | undefined
  readonly refresh: () => Promise<void>
} {
  const [view, setView] = useState<TravelView | undefined>(undefined)
  const [amap, setAmap] = useState<AmapRuntimeView | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    const controller = new AbortController()
    try {
      const query = props.sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(props.sessionId)}`
      const response = await fetch(`${apiPath()}/state${query}`, { signal: controller.signal })
      const payload = (await response.json()) as TravelStateResponse
      if (payload.ok !== true) {
        setError(payload.error ?? `请求失败（HTTP ${String(response.status)}）`)
      } else {
        setView(payload.view)
        setAmap(payload.amap)
        setError(undefined)
      }
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      setLoading(false)
    }
  }, [props.sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!poll || typeof window === 'undefined') return undefined
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 20_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [poll, refresh])

  return { view, amap, loading, error, refresh }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** The day whose date is today, when the trip is under way. */
function todayIn(days: readonly DayView[]): DayView | undefined {
  const today = new Date()
  const iso = `${String(today.getFullYear())}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return days.find((day) => day.date === iso)
}

/** One cross-day hop: how the trip gets from the end of a day to the start of the next. */
export interface DayTransfer {
  readonly id: string
  readonly fromDayId: string
  readonly toDayId: string
  readonly origin: string
  readonly destination: string
  /**
   * The stops the hop leaves from and arrives at, when the trip has them.
   *
   * The names above usually come from the day's title (`西安 → 成都`), while these
   * are the places the traveller was actually at: promoted into a transit, they
   * are what gives the road a coordinate to be drawn between.
   */
  readonly fromPlaceId?: string
  readonly toPlaceId?: string
  /** Travel mode of a recorded leg, when there is one. */
  readonly mode: LegView['mode'] | undefined
  readonly distanceMeters: number | undefined
  readonly durationSeconds: number | undefined
  /**
   * Where the numbers came from.
   *
   * A day that changes city but carries no leg for it is the common shape of a
   * driving trip: the distance only exists in the day's own title. Saying so is
   * better than inventing a duration.
   */
  readonly source: 'recorded' | 'title'
}

/** Read `A → B` and a kilometre figure out of a day title, e.g. `西安 → 成都｜翻秦岭 723km`. */
export function parseTransferTitle(title: string): {
  readonly origin?: string
  readonly destination?: string
  readonly distanceMeters?: number
} {
  const arrow = /^\s*([^→]+?)\s*(?:→|->|—>)\s*([^｜|·，,（(]+)/.exec(title)
  const km = /(\d[\d,]*(?:\.\d+)?)\s*(?:km|公里)/i.exec(title)
  const origin = arrow?.[1]?.trim()
  const destination = arrow?.[2]?.trim()
  const amount = km?.[1]
  return {
    ...origin === undefined || origin === '' ? {} : { origin },
    ...destination === undefined || destination === '' ? {} : { destination },
    ...amount === undefined ? {} : { distanceMeters: Math.round(Number(amount.replace(/,/g, '')) * 1000) },
  }
}

/**
 * Whether one leg describes a journey rather than two stops at the same place.
 *
 * A hop crosses a city boundary, so a leg that stays under a kilometre and under
 * ten minutes is a placeholder: `travel_day_rebuild_legs` produces them when two
 * stops resolve to the same point.
 *
 * @param leg - leg to judge.
 * @returns true when the leg carries a real journey.
 */
export function usableLeg(leg: LegView): boolean {
  return leg.distanceMeters >= 1_000 || leg.durationSeconds >= 600
}

/**
 * Whether a day changes city without recording how.
 *
 * @param day - day to inspect.
 * @returns true when its title claims a hop the legs do not account for.
 */
export function hasUnrecordedTransfer(day: DayView): boolean {
  // A transit is the record: once the day carries one, nothing is missing even
  // though the title still states the journey.
  if ((day.transits ?? []).length > 0) return false
  return !day.legs.some(usableLeg) && parseTransferTitle(day.title).destination !== undefined
}

/**
 * The cross-day hops of a trip, one between each pair of consecutive days.
 *
 * Exported so the derivation is testable without a DOM.
 *
 * @param days - every day of the active scenario, in order.
 * @returns one transfer per boundary, in day order.
 */
export function buildTransfers(days: readonly DayView[]): readonly DayTransfer[] {
  const transfers: DayTransfer[] = []
  for (const [index, from] of days.entries()) {
    const to = days[index + 1]
    if (to === undefined) continue
    // The day already records its own move: a derived row would be a duplicate.
    if ((to.transits ?? []).length > 0) continue
    const lastFrom = from.items[from.items.length - 1]
    const firstTo = to.items[0]
    // A hop is recorded either as a leg on the arriving day that starts from the
    // previous day's last stop, or as the arriving day's first leg when that leg
    // is its longest — a driving day leaves the city it slept in before touring.
    // Anything else is a day spent inside one city, which is not a hop at all.
    // Placeholder legs must not hide a title's real kilometre figure.
    const explicit = to.legs.find((leg) => lastFrom !== undefined && leg.fromItemId === lastFrom.id && usableLeg(leg))
    const first = firstTo === undefined ? undefined : to.legs.find((leg) => leg.fromItemId === firstTo.id && usableLeg(leg))
    const longest = to.legs.filter(usableLeg).reduce<LegView | undefined>(
      (best, leg) => (best === undefined || leg.distanceMeters > best.distanceMeters ? leg : best),
      undefined,
    )
    const recorded = explicit ?? (first !== undefined && first === longest ? first : undefined)
    const parsed = parseTransferTitle(to.title)
    const claimsHop = parsed.origin !== undefined || parsed.destination !== undefined
    // The title names the cities, so it decides *whether* the trip hopped. A
    // recorded leg is kept only when its distance agrees with that claim: a trip
    // whose legs were rebuilt across days can hold a leg belonging elsewhere, and
    // such a leg must not replace the day's own story with a stranger's journey.
    const agrees =
      recorded !== undefined &&
      (parsed.distanceMeters === undefined ||
        Math.abs(recorded.distanceMeters - parsed.distanceMeters) <= Math.max(parsed.distanceMeters * 0.35, 5_000))
    const chosen = claimsHop ? (agrees ? recorded : undefined) : recorded
    // No leg, no claim: a day spent inside one city is not a hop, and a row would
    // only print 「洱海公园 → 洱海」 between two days of the same stay.
    if (!claimsHop && chosen === undefined) continue
    transfers.push({
      id: `${from.id}->${to.id}`,
      fromDayId: from.id,
      toDayId: to.id,
      origin: parsed.origin ?? lastFrom?.name ?? from.title,
      destination: parsed.destination ?? firstTo?.name ?? to.title,
      ...lastFrom === undefined ? {} : { fromPlaceId: lastFrom.placeId },
      ...firstTo === undefined ? {} : { toPlaceId: firstTo.placeId },
      mode: chosen?.mode,
      distanceMeters: chosen?.distanceMeters ?? parsed.distanceMeters,
      durationSeconds: chosen?.durationSeconds,
      source: chosen !== undefined ? 'recorded' : 'title',
    })
  }
  return transfers
}

/** 从这段里程起，一天算「在路上」而不是在城里逛。 */
const LONG_DRIVE_METERS = 100_000

/** 一段路要占掉当天里程或移动时间的这个比例，才算主导了这一天。 */
const LONG_DRIVE_SHARE = 0.8

/** A point as the map surfaces carry it: plain coordinates, no provider object. */
interface LngLat {
  readonly longitude: number
  readonly latitude: number
}

/**
 * One route the map draws as a road rather than as stop order.
 *
 * 转场、被一段长途主导的一天、以及只在标题里声明了跨城的赶路日，都会变成这样一条
 * 线。`kind` 决定线型与语气：`planned` 是已经规划过的路，`estimated` 只是把标题里
 * 的里程画出来 —— 地图上必须一眼分得开。
 */
export interface DriveRoute {
  readonly id: string
  readonly dayId: string
  /** The day's position in the trip, so the road takes its day's colour. */
  readonly colorIndex: number
  readonly path: readonly (readonly [number, number])[]
  /** Metres the route covers, when anything knows them. */
  readonly meters?: number
  readonly seconds?: number
  readonly kind: 'planned' | 'estimated'
  /** 胶囊上那行字，例如 `驾车 · 723 km · 8 小时 12 分`。 */
  readonly label: string
}

/**
 * The driving routes of a trip, one per day that has something to draw them with.
 *
 * 地图过去把「跨城赶路」和「市内挪窝」画成同一种细虚线，而且端点没有坐标时连那条
 * 线都没有。这里按三级降级为每一天找出一条路：转场（有真实路径就画路径）、一段占
 * 满当天的长途 leg、只剩标题时借相邻两天的站点。三级都无话可说的天不出现在结果里。
 *
 * Exported so the derivation is testable without a DOM.
 *
 * @param days - every day of the active scenario, in order.
 * @returns one route per drawable day, in day order.
 */
export function driveRoutes(days: readonly DayView[]): readonly DriveRoute[] {
  const routes: DriveRoute[] = []
  // 相邻两天的兜底端点：只有真的需要用标题估一条路时才去算它。
  let hops: readonly DayTransfer[] | undefined
  for (const [colorIndex, day] of days.entries()) {
    let count = 0
    const add = (route: Omit<DriveRoute, 'id' | 'dayId' | 'colorIndex'>): void => {
      count += 1
      routes.push({ id: `${day.id}-drive-${String(count)}`, dayId: day.id, colorIndex, ...route })
    }
    let drawn = false
    // 转场就是那天的路：有 polyline 用真实路径，否则两端直连。
    for (const transit of day.transits ?? []) {
      const path = transitPath(transit)
      if (path.length < 2) continue
      drawn = true
      add({
        path,
        kind: 'planned',
        label: driveLabel(transit.mode, transit.distanceMeters, transit.durationSeconds, false),
        ...transit.distanceMeters === undefined ? {} : { meters: transit.distanceMeters },
        ...transit.durationSeconds === undefined ? {} : { seconds: transit.durationSeconds },
      })
    }
    // 转场已经给出这条路时到此为止：再降一级就会把同一条路画第二遍。
    if (drawn) continue
    // 没有转场，但一整天就是一段长途：它该被画成一条路，而不是「市内挪窝」。
    const leg = dominantDriveLeg(day)
    const legPath = leg === undefined ? [] : legPointPath(day, leg)
    if (leg !== undefined && legPath.length >= 2) {
      add({
        path: legPath,
        kind: 'planned',
        label: driveLabel(leg.mode, leg.distanceMeters, leg.durationSeconds, false),
        meters: leg.distanceMeters,
        seconds: leg.durationSeconds,
      })
      continue
    }
    // 只有标题：里程是标题里的数字，坐标借相邻两天的站点 —— 整天在路上的一天本来
    // 就没有站点，这正是它需要这条估算线的原因。
    const stated = parseTransferTitle(day.title ?? '')
    if (stated.origin === undefined && stated.destination === undefined) continue
    if ((day.legs ?? []).some(usableLeg)) continue
    const path = hopPath(days, day, (hops ??= buildTransfers(days)), stated)
    if (path.length < 2) continue
    add({
      path,
      kind: 'estimated',
      label: driveLabel('driving', stated.distanceMeters, undefined, true),
      ...stated.distanceMeters === undefined ? {} : { meters: stated.distanceMeters },
    })
  }
  return routes
}

/**
 * The routes of the days one drawing actually covers.
 *
 * @param groups - the days being drawn, in day order.
 * @param days - every day of the trip, for their routes.
 * @returns the routes whose day is in the drawn set.
 */
function drawnRoutesOf(groups: readonly DayStops[], days: readonly DayView[]): readonly DriveRoute[] {
  return driveRoutes(days).filter((route) => groups.some((group) => group.dayId === route.dayId))
}

/**
 * Whether one of the drawn routes already draws this line.
 *
 * 转场现在由 `driveRoutes` 画成带胶囊的路线，两侧各再画一条旧的转场折线就是同一条路
 * 叠两遍 —— 判断「路径逐点相同」而不是「这一天有路线」，是因为一天可以有多段转场，
 * 而路线是逐段对应的。
 *
 * @param routes - the routes being drawn.
 * @param dayId - the day the polyline belongs to.
 * @param path - the polyline's coordinates.
 * @returns true when a route already covers it, so the old line is a duplicate.
 */
function routeCovers(routes: readonly DriveRoute[], dayId: string, path: readonly (readonly [number, number])[]): boolean {
  return routes.some(
    (route) =>
      route.dayId === dayId &&
      route.path.length === path.length &&
      route.path.every(([longitude, latitude], index) => path[index]?.[0] === longitude && path[index]?.[1] === latitude),
  )
}

/**
 * The leg that makes a day a driving day.
 *
 * 一段路至少 100 km，且占当天**里程**或**移动时长**的 80% 以上，就算它主导了这一天。
 * 两个口径是必须的：真实行程里「丽江 → 大理 175km」那天后面还跟着 13km 的市内挪窝，
 * 175km 占里程 93%、却只占时间 77%，只按时间判就会把这条 175km 的路漏掉；反过来，
 * 市内几站之间的十几公里也永远不会因为「占满了时间」而被当成赶路（里程不到 100km）。
 *
 * @param day - day to judge.
 * @returns the dominant leg, or undefined when no single road owns the day.
 */
function dominantDriveLeg(day: DayView): LegView | undefined {
  const legs = day.legs ?? []
  const moving = legs.reduce((total, leg) => total + leg.durationSeconds, 0)
  const travelled = legs.reduce((total, leg) => total + leg.distanceMeters, 0)
  if (moving <= 0 && travelled <= 0) return undefined
  const longest = legs.reduce<LegView | undefined>(
    (best, leg) => (best === undefined || leg.distanceMeters > best.distanceMeters ? leg : best),
    undefined,
  )
  if (longest === undefined || longest.distanceMeters < LONG_DRIVE_METERS) return undefined
  const byDistance = travelled > 0 && longest.distanceMeters >= travelled * LONG_DRIVE_SHARE
  const byTime = moving > 0 && longest.durationSeconds >= moving * LONG_DRIVE_SHARE
  return byDistance || byTime ? longest : undefined
}

/** The coordinates of a leg's two stops; no coordinate on either end means no line. */
function legPointPath(day: DayView, leg: LegView): readonly (readonly [number, number])[] {
  const from = (day.items ?? []).find((item) => item.id === leg.fromItemId)?.point
  const to = (day.items ?? []).find((item) => item.id === leg.toItemId)?.point
  return from === undefined || to === undefined
    ? []
    : [
        [from.longitude, from.latitude],
        [to.longitude, to.latitude],
      ]
}

/**
 * The two ends of a hop that exists only in a title.
 *
 * 端点按四级降级找：标题里的地名先在整个行程的「有名字的坐标点」里对号入座（同名取
 * 离这一天最近的那个）；对不上就用 `buildTransfers` 已算出的出发地与目的地；再对不上
 * 就借相邻天 —— 出发点向**前**借（该天之前最后一个有坐标的站点），到达点向**后**借
 * （该天之后第一个有坐标的站点）。行程首尾那两天没有邻天可借：这时退回整个行程的第一
 * 个／最后一个有坐标站点，只要两端不重合就算一条估算线 —— 末位那天整天赶路、一个站点
 * 都没有，过去正是在这里返回空，面板于是回答「这一天还没有带坐标的地点」。
 *
 * @param days - every day of the trip, in order.
 * @param day - the day whose title claims the hop.
 * @param hops - the derived cross-day rows of the same trip.
 * @param stated - the two place names and the distance read out of the day's title.
 * @returns the two ends, or nothing when the trip has no second located point.
 */
function hopPath(
  days: readonly DayView[],
  day: DayView,
  hops: readonly DayTransfer[],
  stated: { readonly origin?: string | undefined; readonly destination?: string | undefined },
): readonly (readonly [number, number])[] {
  const index = days.findIndex((entry) => entry.id === day.id)
  const hop = hops.find((entry) => entry.toDayId === day.id)
  const named = namedPoints(days)
  // 两端各按优先级排一列候选：前两个是「说得清」的（标题里的地名、转场记下的地点），
  // 后两个是「借来的」（相邻天、乃至整个行程的首尾）。
  const from =
    matchNamed(named, stated.origin, index) ??
    pointOfPlace(days, hop?.fromPlaceId) ??
    lastLocatedPoint(days, index - 1) ??
    firstLocatedPoint(days, 0)
  if (from === undefined) return []
  // 到达点取第一个「与出发点不同」的候选：两端重合的「路」只是一条看不见的线，
  // 与其画它，不如退到行程另一端 —— 只要行程里还有第二个有坐标的点。
  const to = [
    matchNamed(named, stated.destination, index),
    pointOfPlace(days, hop?.toPlaceId),
    firstLocatedPoint(days, index),
    lastLocatedPoint(days, days.length - 1),
    firstLocatedPoint(days, 0),
  ].find((candidate) => candidate !== undefined && !samePoint(candidate, from))
  if (to === undefined) return []
  return [
    [from.longitude, from.latitude],
    [to.longitude, to.latitude],
  ]
}

/** Whether two coordinates are the same place, at the precision the map works in. */
function samePoint(left: LngLat, right: LngLat): boolean {
  return Math.abs(left.longitude - right.longitude) < 1e-6 && Math.abs(left.latitude - right.latitude) < 1e-6
}

/** One named place the trip knows a coordinate for: a stop, or a transit end. */
interface NamedPoint {
  readonly name: string
  /** The day it belongs to, so a name shared by several days can be matched to the nearest. */
  readonly dayIndex: number
  readonly point: LngLat
}

/**
 * Every named place of the trip, with its coordinate.
 *
 * 标题只写「西安 → 成都」时，这两个名字与行程里的地点名／转场端点名对上，比借相邻天
 * 的站点准得多（相邻天的站点可能只是「回民街」这类中途一站）。转场端点也是名字，
 * 所以一并收进来。
 *
 * @param days - every day of the trip, in order.
 * @returns one entry per located and named stop or transit end.
 */
function namedPoints(days: readonly DayView[]): readonly NamedPoint[] {
  const points: NamedPoint[] = []
  for (const [dayIndex, day] of days.entries()) {
    for (const item of day.items ?? []) {
      if (item.point !== undefined && item.name !== '') points.push({ name: item.name, dayIndex, point: item.point })
    }
    for (const transit of day.transits ?? []) {
      for (const end of [transit.from, transit.to]) {
        if (end.point !== undefined && end.label !== '') points.push({ name: end.label, dayIndex, point: end.point })
      }
    }
  }
  return points
}

/**
 * The coordinate of a place name the day's title states.
 *
 * @param points - the trip's named places.
 * @param name - the name read out of the title.
 * @param index - the day the name was stated on; ties go to the nearest day.
 * @returns the coordinate, or undefined when nothing in the trip is called that.
 */
function matchNamed(points: readonly NamedPoint[], name: string | undefined, index: number): LngLat | undefined {
  if (name === undefined || name === '') return undefined
  let best: NamedPoint | undefined
  for (const entry of points) {
    if (entry.name !== name) continue
    if (best === undefined || Math.abs(entry.dayIndex - index) < Math.abs(best.dayIndex - index)) best = entry
  }
  return best?.point
}

/** One place's coordinate, looked up by id across the whole trip. */
function pointOfPlace(days: readonly DayView[], placeId: string | undefined): LngLat | undefined {
  if (placeId === undefined) return undefined
  for (const day of days) {
    const item = (day.items ?? []).find((entry) => entry.placeId === placeId)
    if (item?.point !== undefined) return item.point
  }
  return undefined
}

/** The first located stop on or after one day, so a driving day can borrow one. */
function firstLocatedPoint(days: readonly DayView[], fromIndex: number): LngLat | undefined {
  for (let index = Math.max(fromIndex, 0); index < days.length; index += 1) {
    const first = locateDay(days[index])[0]
    if (first !== undefined) return first.point
  }
  return undefined
}

/** The last located stop on or before one day. */
function lastLocatedPoint(days: readonly DayView[], fromIndex: number): LngLat | undefined {
  for (let index = Math.min(fromIndex, days.length - 1); index >= 0; index -= 1) {
    const located = locateDay(days[index])
    const last = located[located.length - 1]
    if (last !== undefined) return last.point
  }
  return undefined
}

/**
 * The words on a route's capsule.
 *
 * 已规划的一天报真实数字；只有标题的一天没有时长可报，就用 `≈` 和「按标题估算」把
 * 「这是估算」写清楚，读者不必去猜哪个数字是真的。
 *
 * @param mode - travel mode, absent for a route only a title states.
 * @param meters - distance the route covers.
 * @param seconds - time it takes, when anything measured it.
 * @param estimated - true when the numbers are only the title's claim.
 * @returns one line, e.g. `驾车 · ≈723 km · 按标题估算`.
 */
function driveLabel(
  mode: LegView['mode'] | undefined,
  meters: number | undefined,
  seconds: number | undefined,
  estimated: boolean,
): string {
  const parts = [modeLabel(mode ?? 'driving')]
  if (meters !== undefined) parts.push(`${estimated ? '≈' : ''}${formatDistance(meters)}`)
  if (seconds !== undefined) parts.push(formatDuration(seconds))
  if (estimated) parts.push('按标题估算')
  return parts.join(' · ')
}

/** Euclidean length of one step of a path, in degrees: enough to place a label. */
function pathStep(from: readonly [number, number], to: readonly [number, number]): number {
  return Math.hypot(to[0] - from[0], to[1] - from[1])
}

/**
 * The point halfway along a path, measured by distance rather than by index.
 *
 * 胶囊要压在路上：一条先向南再向东的路，按下标取中点会把标签放到拐角上。
 *
 * @param path - ordered coordinates.
 * @returns the coordinate halfway along the path.
 */
function pathMidpoint(path: readonly (readonly [number, number])[]): readonly [number, number] {
  const first = path[0]
  if (first === undefined) return [0, 0]
  let total = 0
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1]
    const current = path[index]
    if (previous === undefined || current === undefined) continue
    total += pathStep(previous, current)
  }
  let walked = 0
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1]
    const current = path[index]
    if (previous === undefined || current === undefined) continue
    const step = pathStep(previous, current)
    if (walked + step >= total / 2) {
      const ratio = step === 0 ? 0 : (total / 2 - walked) / step
      return [previous[0] + (current[0] - previous[0]) * ratio, previous[1] + (current[1] - previous[1]) * ratio]
    }
    walked += step
  }
  return first
}

/** A day's own numbers, for its sticky header and its row in the day rail. */
export interface DayFacts {
  /** Seconds spent moving, summed over the day's recorded legs. */
  readonly driveSeconds: number
  readonly distanceMeters: number
  /** Kilometres the day's title states, when no leg accounts for them. */
  readonly estimatedDistanceMeters?: number
  /** Stops on the day. */
  readonly stops: number
  /** Planned dwell, in minutes; zero when the trip never recorded any. */
  readonly dwellMinutes: number
  /** True when the day changes city with no leg to show for it. */
  readonly unrecorded: boolean
  /** Transits recorded on the day, and what they add up to. */
  readonly transitCount: number
  readonly transitMeters: number
  readonly transitSeconds: number
}

/**
 * Summarize one day.
 * @param day - day to summarize.
 * @returns the numbers its header and rail row show.
 */
export function dayFacts(day: DayView): DayFacts {
  const unrecorded = hasUnrecordedTransfer(day)
  const stated = unrecorded ? parseTransferTitle(day.title).distanceMeters : undefined
  const transits = day.transits ?? []
  const transitMeters = transits.reduce((total, transit) => total + (transit.distanceMeters ?? 0), 0)
  const transitSeconds = transits.reduce((total, transit) => total + (transit.durationSeconds ?? 0), 0)
  return {
    // A day spent driving: the road is the day's own work, so it counts towards
    // the distance and the hours the header prints.
    transitCount: transits.length,
    transitMeters,
    transitSeconds,
    driveSeconds: day.totalDurationSeconds + transitSeconds,
    distanceMeters: day.totalDistanceMeters + transitMeters,
    // Only a hop with no leg falls back to the title: a day whose legs are real
    // must not have a number from the title quietly stand in for them.
    ...stated === undefined ? {} : { estimatedDistanceMeters: stated },
    stops: day.items.length,
    dwellMinutes: day.items.reduce((total, item) => total + (item.plannedDurationMinutes ?? 0), 0),
    unrecorded,
  }
}

/**
 * The kilometres a day's row is drawn with, recorded or stated.
 * @param facts - one day's numbers.
 * @returns metres: the measured distance, else the one the title claims.
 */
export function dayDistanceMeters(facts: DayFacts): number {
  return facts.distanceMeters >= 1_000 ? facts.distanceMeters : (facts.estimatedDistanceMeters ?? facts.distanceMeters)
}

/**
 * The distance cell of one day in the rail.
 *
 * Every row says something: an approximate figure is marked as such rather than
 * left blank, because the blank rows this replaced — a bar with no label on the
 * days that changed city — read as a rendering fault.
 *
 * @param facts - one day's numbers.
 * @returns the text for the row's distance cell.
 */
export function dayDistanceText(facts: DayFacts): string {
  const meters = dayDistanceMeters(facts)
  if (meters >= 1_000) {
    return facts.distanceMeters >= 1_000 ? formatDistance(meters) : `≈${formatDistance(meters)}`
  }
  if (facts.unrecorded) return '跨城'
  return facts.stops > 0 ? '市内' : '—'
}

/**
 * The second line of a day's header: numbers only, already joined.
 *
 * Built as a list rather than a chain of conditional fragments: the fragments
 * left a leading ` · ` on the days that only have stops, which printed as
 * 「· 1 站」.
 *
 * @param day - day to summarize.
 * @returns one line such as `行驶 12 小时 38 分 · 1077.1 km · 2 站`.
 */
export function dayHeadNumbers(day: DayView): string {
  const facts = dayFacts(day)
  const stated = parseTransferTitle(day.title).distanceMeters
  const parts: string[] = []
  if (facts.driveSeconds > 0) {
    parts.push(`${facts.stops === 0 && facts.transitCount > 0 ? '在路上' : '行驶'} ${formatDuration(facts.driveSeconds)}`)
  }
  // The title usually states the same figure in round numbers; printing both a
  // line apart is what made the header look like it was repeating itself. A
  // routed distance that disagrees with the title is worth saying out loud.
  const agrees = stated !== undefined && Math.abs(stated - facts.distanceMeters) <= Math.max(stated * 0.2, 5_000)
  if (facts.distanceMeters >= 1_000 && !agrees) parts.push(formatDistance(facts.distanceMeters))
  // A day spent driving has no stops, and 「0 站」 would read as a mistake.
  if (facts.stops > 0) parts.push(`${String(facts.stops)} 站`)
  if (facts.dwellMinutes > 0) parts.push(`停留 ${formatMinutes(facts.dwellMinutes)}`)
  // 「转场」 is the word for a day that changes city; the road itself is already
  // in the distance and the hours above it.
  if (facts.transitCount > 0) parts.push('转场')
  return parts.join(' · ')
}

/**
 * The label of one stop on the map.
 *
 * Numbers restart at 1 on every day, which is legible while one day is drawn
 * and meaningless while fourteen are: the whole-trip map showed a dozen
 * overlapping pins all reading 1, 2 or 3. There, a day is labelled once, at its
 * first stop, and its remaining stops are unlabelled dots.
 *
 * @param range - whether one day or the whole trip is drawn.
 * @param dayOrder - the day's 1-based position in the trip.
 * @param stopIndex - the stop's 0-based position in its day.
 * @returns the text on the pin.
 */
export function pinLabel(range: MapRange, dayOrder: number, stopIndex: number): string {
  return range === 'all' && stopIndex === 0 ? `D${String(dayOrder)}` : String(stopIndex + 1)
}

/**
 * Whether the markers carry their place names.
 *
 * Thirty-two names on a country-wide view is a pile, not a map, so a name is
 * drawn once the map is zoomed in far enough to hold it — or straight away when
 * the view only has a handful of stops to name.
 *
 * @param zoom - current map zoom; zero for the coordinate schematic.
 * @param stops - how many stops this view draws.
 * @returns true when each marker should show its name.
 */
export function showPinNames(zoom: number, stops: number): boolean {
  return zoom >= PIN_NAME_ZOOM || stops <= PIN_NAME_MAX_STOPS
}

/**
 * Turn a derived hop into the patch op that records it as a real transit.
 *
 * The numbers are whatever the title states — no duration, no steps — and the
 * transit is marked `stale`, because nothing has planned the road yet. That is
 * exactly what the panel's 「按标题估算」 chip says, and 「用高德重算」 is one click
 * away.
 *
 * @param dayId - the day the move belongs to (the day it arrives at).
 * @param transfer - the derived hop.
 * @returns one `set-day-transit` op.
 */
export function transitOpFromTransfer(dayId: string, transfer: DayTransfer): Record<string, unknown> {
  return {
    kind: 'set-day-transit',
    dayId,
    transit: {
      id: `${dayId}-transit-1`,
      from: { label: transfer.origin, ...transfer.fromPlaceId === undefined ? {} : { placeId: transfer.fromPlaceId } },
      to: { label: transfer.destination, ...transfer.toPlaceId === undefined ? {} : { placeId: transfer.toPlaceId } },
      mode: transfer.mode ?? 'driving',
      ...transfer.distanceMeters === undefined ? {} : { distanceMeters: transfer.distanceMeters },
      ...transfer.durationSeconds === undefined ? {} : { durationSeconds: transfer.durationSeconds },
      steps: [],
      freshness: transfer.source === 'recorded' ? 'fresh' : 'stale',
      source: { provider: transfer.source === 'recorded' ? 'amap-cli' : 'title', fetchedAt: new Date().toISOString() },
    },
  }
}

/**
 * What a cross-day row says.
 *
 * A day whose hop exists only in its title already shows both cities and the
 * distance in that title, so the row must not print them again — it says what
 * is missing and offers to fill it in.
 *
 * @param transfer - the hop to describe.
 * @returns the row's text and its trailing note.
 */
export function transferLines(transfer: DayTransfer): { readonly text: string; readonly note: string | undefined } {
  if (transfer.source === 'title') {
    return { text: '跨城交通未记录', note: '里程按当天标题估算' }
  }
  const parts = [`${transfer.origin} → ${transfer.destination}`]
  if (transfer.distanceMeters !== undefined) parts.push(formatDistance(transfer.distanceMeters))
  if (transfer.durationSeconds !== undefined) parts.push(formatDuration(transfer.durationSeconds))
  return { text: parts.join(' · '), note: undefined }
}

/**
 * What the panel says after a bulk route fill.
 *
 * 「跳过」也要说出来：宿主可能因为端点只有名字、没有可用的高德 Key 而跳过某几天，
 * 一句「已补全 0 天」会让人以为是按钮坏了。
 *
 * @param planned - days the host turned into real routes.
 * @param skipped - days it decided to leave alone.
 * @returns the notice line.
 */
export function fillReport(planned: number, skipped: number): string {
  if (planned === 0) {
    return skipped === 0 ? '没有需要补全的路线。' : `没有补全任何路线，跳过 ${String(skipped)} 天。`
  }
  return skipped === 0
    ? `已补全 ${String(planned)} 天路线。`
    : `已补全 ${String(planned)} 天路线，跳过 ${String(skipped)} 天。`
}

/**
 * How heavy a day is relative to the busiest day of the trip.
 *
 * Measured in the kilometres the row also prints, so the bar and the number
 * beside it always describe the same thing: a day whose hop only exists in its
 * title still gets a bar, which is exactly the day a reader wants to spot.
 *
 * @param days - every day of the trip.
 * @returns one ratio in 0..1 per day, in day order.
 */
export function dayIntensity(days: readonly DayView[]): readonly number[] {
  const metres = days.map((day) => dayDistanceMeters(dayFacts(day)))
  const busiest = Math.max(...metres, 0)
  if (busiest <= 0) return days.map(() => 0)
  return metres.map((value) => Math.min(1, value / busiest))
}

/** `HH:MM` of one clock, or `—` when the stop has none. */
export function clockLabel(startAt: string | undefined): string {
  if (startAt === undefined || startAt.length < 16) return '—'
  return startAt.slice(11, 16)
}

/** Chinese weekday for a `YYYY-MM-DD` date. */
function weekdayLabel(date: string): string {
  if (date.length < 10) return date
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return date
  return `${date.slice(5)} 周${'日一二三四五六'[parsed.getDay()] ?? ''}`
}

/** Format meters for display. */
function formatDistance(meters: number): string {
  return meters >= 1000 ? `${String(Math.round(meters / 100) / 10)} km` : `${String(Math.round(meters))} m`
}

/** Format seconds for display. */
function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)} 分钟`
  return `${String(Math.floor(minutes / 60))} 小时 ${String(minutes % 60)} 分`
}

/** Format a stop length that is already in minutes. */
function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} 分`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${String(hours)} 小时` : `${String(hours)} 小时 ${String(rest)} 分`
}

/** Chinese label for one travel mode. */
function modeLabel(mode: LegView['mode']): string {
  if (mode === 'walking') return '步行'
  if (mode === 'transit') return '公交'
  if (mode === 'riding') return '骑行'
  return '驾车'
}

/** Glyph for one travel mode. */
function modeIcon(mode: LegView['mode']): string {
  if (mode === 'walking') return '🚶'
  if (mode === 'transit') return '🚇'
  if (mode === 'riding') return '🚲'
  return '🚗'
}

/** Chinese label for one trip status. */
function statusLabel(status: string): string {
  if (status === 'idea') return '构想'
  if (status === 'drafting') return '草案'
  if (status === 'checking') return '校验中'
  if (status === 'needs-attention') return '待处理'
  if (status === 'ready') return '已就绪'
  if (status === 'traveling') return '旅途中'
  return '已归档'
}

/** Chinese label for one place-library status. */
function placeStatusLabel(status: string): string {
  if (status === 'planned') return '已采用'
  if (status === 'locked') return '已固定'
  if (status === 'candidate') return '候选'
  if (status === 'excluded') return '已排除'
  return status
}

/** Chinese label for one alert severity. */
function severityLabel(severity: string): string {
  if (severity === 'error') return '阻塞'
  if (severity === 'warning') return '警告'
  return '提示'
}

/** One definition row. */
function row(label: string, value: string): ReactElement {
  return createElement(
    'div',
    { className: 'trv-grid-row', key: label },
    createElement('dt', null, label),
    createElement('dd', null, value),
  )
}

/**
 * Panel stylesheet.
 *
 * Every surface, border and label colour comes from a DSH theme token, so the
 * panel follows light and dark themes without overriding any global token.
 * Exported so a test renderer can inject the same string the client does: a
 * server-rendered `<style>` child is HTML-escaped, and a raw-text style element
 * never decodes those entities, which would silently drop every `content` rule.
 */
export const STYLES = `
.trv-shell { height: 100%; min-height: 0; display: flex; flex-direction: column; container-type: inline-size; background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base)); color: var(--dsw-alias-label-primary); }
.trv-root { position: relative; display: flex; flex-direction: column; min-height: 0; height: 100%; font-size: 13px; line-height: 1.45; }
.trv-head { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
/* Dropdowns anchor to the pane, so their height is a slice of the pane rather
   than of the header; a workspace with many trips then scrolls instead of
   clipping to one row. */
.trv-scrim { position: absolute; inset: 0; z-index: 11; background: transparent; }
.trv-head-title { min-width: 0; flex: 1; }
.trv-head-sub { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin-top: 1px; }
.trv-head-tools { display: flex; align-items: center; gap: 4px; }
.trv-switcher { appearance: none; border: 0; background: transparent; color: inherit; font: inherit; font-weight: 600; padding: 0 3px; display: flex; align-items: center; gap: 4px; max-width: 100%; cursor: pointer; border-radius: 6px; }
.trv-switcher:hover { background: var(--dsw-alias-bg-layer-2); }
.trv-switcher-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trv-chevron { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.trv-icon { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 14px; line-height: 1; padding: 2px 6px; border-radius: 6px; cursor: pointer; }
.trv-icon:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.trv-ring { --trv-ready: 0; appearance: none; border: 0; padding: 0; cursor: pointer; position: relative; width: 26px; height: 26px; border-radius: 999px; display: grid; place-items: center; font-size: 9.5px; font-weight: 600; color: var(--dsw-alias-label-secondary); background: conic-gradient(var(--dsw-alias-state-success-primary) calc(var(--trv-ready) * 1%), var(--dsw-alias-border-l1) 0); }
.trv-ring::after { content: ''; position: absolute; inset: 3px; border-radius: 999px; background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base)); }
.trv-ring > span { position: relative; z-index: 1; }
.trv-menu { position: absolute; top: 40px; right: 10px; z-index: 12; min-width: 210px; padding: 4px; border-radius: 10px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 8px 24px rgb(0 0 0 / 18%); }
.trv-menu-item { display: flex; gap: 9px; align-items: flex-start; width: 100%; text-align: left; appearance: none; border: 0; background: transparent; color: inherit; font: inherit; padding: 7px 9px; border-radius: 7px; cursor: pointer; }
.trv-menu-icon { font-size: 14px; line-height: 1.3; }
.trv-menu-text { display: flex; flex-direction: column; min-width: 0; }
.trv-menu-title { font-weight: 600; }
.trv-menu-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: normal; }
.trv-menu-item:hover { background: var(--dsw-alias-bg-layer-2); }
.trv-menu-note { font-size: 10.5px; color: var(--dsw-alias-label-secondary); padding: 6px 9px 2px; }
.trv-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 12px 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.trv-chip { border-radius: 999px; padding: 1px 7px; background: var(--dsw-alias-bg-layer-2); }
.trv-chip-error { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent); color: var(--dsw-alias-state-error-primary); }
.trv-chip-warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 20%, transparent); color: var(--dsw-alias-state-warn-primary); }
.trv-map-card { position: relative; isolation: isolate; margin: 8px 12px 0; border-radius: 12px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.trv-map-compact { height: 168px; }
.trv-map-comfortable { height: 260px; }
.trv-map-full { position: absolute; inset: 0; margin: 0; border-radius: 0; border: 0; height: auto; z-index: 9; }
.trv-map-dragging { transition: none; }
.trv-amap { width: 100%; height: 100%; }
.trv-map { position: absolute; inset: 0; background: var(--dsw-alias-bg-layer-1); }
.trv-map-empty { display: grid; place-items: center; padding: 12px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.trv-map svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.trv-line { fill: none; stroke-width: .7; stroke-opacity: .55; stroke-dasharray: 2 1.6; }
/* 转场过去在这里另画一条细实线；现在它由下面那条赶路路线来画（更粗、带里程胶囊），
   旧的折线不再出现在任何一个面上，规则也随之删掉，免得留下一条没人用的 class。 */
/* 赶路日的路线：比站点顺序的细虚线粗得多，实线是已经规划过的路。non-scaling-stroke
   让线宽在 100×100 的拉伸坐标系里仍然是像素，横竖都看得清。 */
.trv-line.trv-drive-line { stroke-width: 2.4; stroke-opacity: .92; stroke-dasharray: none; vector-effect: non-scaling-stroke; }
/* 长虚线：只有标题里的那个里程，没有真实道路 —— 与实线一眼可分。 */
.trv-line.trv-drive-line-estimated { stroke-width: 1.8; stroke-opacity: .85; stroke-dasharray: 7 4; vector-effect: non-scaling-stroke; }
/* 路线胶囊：压在路上，跟着路一起缩放平移。真图一侧由 Marker 定位，示意图一侧是
   绝对定位的 div，所以只有后者的位置来自这条规则。 */
.trv-drive-label { display: none; white-space: nowrap; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--trv-pin, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 92%, transparent); color: var(--dsw-alias-label-primary); font-size: 10.5px; font-weight: 600; line-height: 1.6; font-variant-numeric: tabular-nums; box-shadow: 0 1px 3px rgb(0 0 0 / 20%); }
.trv-map-labels .trv-drive-label { display: block; }
.trv-map-marks .trv-drive-label { position: absolute; transform: translate(-50%, -50%); z-index: 3; }
.trv-map-marks { position: absolute; inset: 0; }
/* One marker: a teardrop pin — a coloured head with a tail that ends on the
   spot. The head is round and the tail takes the same colour through
   --trv-pin, which beats a rounded rectangle with a white tip. */
.trv-map-pin { position: relative; display: grid; place-items: center; width: 26px; height: 26px; min-width: 26px; padding: 0; border-radius: 999px; border: 2px solid #fff; background: var(--trv-pin, var(--dsw-alias-brand-primary)); color: #fff; font-size: 12px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; box-shadow: 0 2px 6px rgb(0 0 0 / 35%); }
.trv-map-pin::after { content: ''; position: absolute; bottom: -6px; left: 50%; transform: translateX(-50%); border-left: 5px solid transparent; border-right: 5px solid transparent; border-top: 6px solid var(--trv-pin, var(--dsw-alias-brand-primary)); }
.trv-map-marks .trv-map-pin { position: absolute; transform: translate(-50%, -100%); font: inherit; font-size: 12px; cursor: pointer; }
.trv-map-pin-on { transform: scale(1.18); box-shadow: 0 0 0 4px rgb(255 255 255 / 55%), 0 3px 10px rgb(0 0 0 / 40%); z-index: 4; }
.trv-map-marks .trv-map-pin-on { transform: translate(-50%, -100%) scale(1.18); }
/* A stop after the day's first one: same shape, one size down, so the anchor
   that carries the day number still reads as the head of the day. */
.trv-map-pin-sm { width: 22px; height: 22px; min-width: 22px; font-size: 11px; }
/* The place name. Hidden until the view has room for it: thirty-two names on a
   country-wide map is a pile, not a map. */
.trv-map-pin-id { position: relative; z-index: 1; font-variant-numeric: tabular-nums; }
.trv-map-pin-name { display: none; position: absolute; left: 50%; bottom: calc(100% + 5px); transform: translateX(-50%); max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 5px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 92%, transparent); color: var(--dsw-alias-label-primary); font-size: 11px; font-weight: 600; line-height: 1.5; box-shadow: 0 1px 3px rgb(0 0 0 / 20%); }
.trv-map-labels .trv-map-pin-name { display: block; }
.trv-map-bar { position: absolute; top: 8px; left: 8px; right: 8px; display: flex; align-items: center; gap: 6px; z-index: 2; }
.trv-map-spacer { flex: 1; }
.trv-seg { display: flex; padding: 2px; border-radius: 9px; background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 88%, transparent); border: 1px solid var(--dsw-alias-border-l1); backdrop-filter: blur(6px); }
.trv-seg-item { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11.5px; padding: 3px 10px; border-radius: 7px; cursor: pointer; }
.trv-seg-on { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 600; }
.trv-map-btn { appearance: none; width: 26px; height: 26px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 88%, transparent); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; backdrop-filter: blur(6px); }
.trv-map-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.trv-map-note { position: absolute; left: 8px; bottom: 8px; max-width: calc(100% - 132px); padding: 3px 8px; border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 80%, transparent); font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); z-index: 2; }
/* 只有标题的赶路日：一次点击补全，不必每天点两次「重算」。放在地图右下角，与
   左下的图例各占一边。 */
.trv-map-fill { position: absolute; right: 8px; bottom: 8px; display: flex; align-items: center; gap: 6px; z-index: 3; }
.trv-map-fill-act { padding: 3px 10px; font-size: 11.5px; }
.trv-map-grip { position: absolute; left: 50%; bottom: 0; transform: translateX(-50%); width: 56px; height: 12px; cursor: ns-resize; z-index: 3; }
.trv-map-grip::after { content: ''; position: absolute; left: 50%; top: 4px; transform: translateX(-50%); width: 34px; height: 4px; border-radius: 999px; background: var(--dsw-alias-border-l2); }
.trv-map-strip { position: absolute; left: 0; right: 0; bottom: 0; display: flex; gap: 6px; padding: 8px; overflow-x: auto; background: linear-gradient(to top, color-mix(in srgb, var(--dsw-alias-bg-overlay) 94%, transparent), transparent); z-index: 2; }
.trv-chip-button { appearance: none; white-space: nowrap; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; font-size: 11.5px; padding: 4px 9px; border-radius: 999px; cursor: pointer; }
.trv-chip-button-on { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.trv-map-fallback { position: absolute; inset: auto 8px 26px 8px; display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 8px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); font-size: 11px; z-index: 4; }
/* One continuous itinerary: each day is a section whose head sticks to the top
   of the scrolling pane, so the plan and its clock stay together. */
.trv-day { display: flex; flex-direction: column; gap: 8px; padding-bottom: 4px; }
.trv-day-head { position: sticky; top: 0; z-index: 4; display: flex; flex-direction: column; gap: 3px; margin: 0 -2px; padding: 8px 2px 7px; background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base)); border-bottom: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 6px 10px -8px rgb(0 0 0 / 45%); }
.trv-day-head-main { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.trv-day-id { font-weight: 700; font-size: 14px; color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; }
.trv-day-date { font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.trv-day-head .trv-day-title { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trv-day-head-facts { display: flex; align-items: baseline; gap: 10px; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.trv-day-head-numbers { white-space: nowrap; }
.trv-day-head-facts .trv-day-area { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; }
.trv-day-head-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.trv-day-head-actions .trv-chip-button { font-size: 11px; padding: 2px 8px; }
/* A day's change of city, as its own card: what the road costs, when it leaves
   and lands, and the two ways to act on it. */
.trv-transit { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 0; padding: 8px 10px 8px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); border-left: 3px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); }
.trv-transit-estimated { border-left-color: var(--dsw-alias-state-warn-primary); }
.trv-transit-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
.trv-transit-icon { font-size: 13px; }
.trv-transit-route { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trv-transit-meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.trv-transit-actions { display: flex; align-items: center; gap: 6px; }
.trv-transit-actions .trv-btn { padding: 3px 9px; font-size: 11.5px; }
/* An end of a transit: a square, so a place the trip only left from or reached
   is never read as somewhere it stopped. */
.trv-map-end { width: 12px; height: 12px; min-width: 12px; border-radius: 3px; border: 2px solid #fff; background: var(--trv-pin, var(--dsw-alias-brand-primary)); box-shadow: 0 1px 4px rgb(0 0 0 / 35%); }
.trv-map-marks .trv-map-end { position: absolute; transform: translate(-50%, -50%); }
/* The hop that arrives at a day, under that day's header: the cities belong to
   the header's title, so this row carries only what is missing. */
.trv-transfer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 2px 0 0; padding: 6px 10px 6px 12px; border-left: 2px dashed var(--dsw-alias-border-l2); border-radius: 0 8px 8px 0; background: var(--dsw-alias-bg-layer-1); font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.trv-transfer-icon { font-size: 12px; }
.trv-transfer-text { font-variant-numeric: tabular-nums; }
.trv-transfer-title .trv-transfer-text { color: var(--dsw-alias-label-primary); }
.trv-transfer-title { border-left-color: var(--dsw-alias-state-warn-primary); }
.trv-transfer-recorded { border-left-style: solid; border-left-color: var(--dsw-alias-brand-primary); }
.trv-transfer-note { font-size: 10.5px; opacity: .8; }
.trv-transfer-act { margin-left: 2px; padding: 2px 8px; font-size: 11px; }
/* One day per row in the rail: its date, its colour on the map, its weight. */
.trv-rail-day { display: flex; flex-direction: column; gap: 2px; }
.trv-rail-head { display: flex; align-items: center; gap: 5px; }
.trv-rail-foot { display: flex; align-items: center; gap: 6px; }
.trv-rail-swatch { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 2px; }
.trv-rail-bar { flex: 1 1 auto; height: 4px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.trv-rail-bar > i { display: block; height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); }
.trv-rail-note { flex: 0 0 auto; min-width: 46px; text-align: right; font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.trv-rail-gap { display: inline-grid; place-items: center; width: 13px; height: 13px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 24%, transparent); color: var(--dsw-alias-state-warn-primary); font-size: 9px; font-weight: 700; line-height: 1; }
/* Every row keeps the same height and the same cells: a row whose badge is
   simply absent is what made the list look like it had failed to render. */
.trv-rail-gap-off { background: transparent; color: color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent); }
.trv-day-area { font-size: 11.5px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.trv-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--dsw-alias-state-warn-primary); display: inline-block; }
.trv-dot-inline { margin-left: 4px; }
.trv-body { min-height: 0; flex: 1; overflow: hidden; padding: 0 12px 12px; display: flex; flex-direction: column; gap: 12px; }
.trv-col-main { min-width: 0; flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
/* The map and the day list travel together: a banner above the itinerary while
   the pane is narrow, a fixed companion column once it is wide. */
.trv-side { display: contents; }
.trv-side .trv-map-card { order: -1; }
.trv-rail { display: none; }
/* One stop: a time rail on the left, then the card, thumbnail and handle. The
   dashed connector is drawn per unit so it also runs behind the transport leg
   of the following stop, and every measurement derives from these two values. */
.trv-timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; --trv-rail-w: 64px; --trv-node-x: 58px; }
.trv-unit { position: relative; }
.trv-unit::before { content: ''; position: absolute; left: var(--trv-node-x); top: 0; bottom: 0; border-left: 1px dashed var(--dsw-alias-border-l2); }
.trv-unit:first-child::before { top: 22px; }
.trv-unit:last-child::before { bottom: auto; height: 22px; }
.trv-row { position: relative; display: flex; align-items: flex-start; gap: 8px; padding: 3px 0; }
.trv-row-on .trv-card { background: var(--dsw-alias-bg-layer-2); box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.trv-tick { flex: 0 0 var(--trv-rail-w); position: relative; align-self: stretch; }
/* The clock stops well short of the node: at a 12px inset the node's 3px halo
   reached into the last digit, which read as the dot eating the time. */
.trv-tick-time { display: flex; flex-direction: column; align-items: flex-end; padding: 6px 18px 0 0; font-size: 11.5px; line-height: 16px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
/* 「次日」 sits above the clock rather than inside it: as a prefix it wrapped a
   46px gutter into two ragged lines. */
.trv-tick-next { font-style: normal; font-size: 9.5px; line-height: 11px; opacity: .85; }
.trv-tick-clock { font-variant-numeric: tabular-nums; }
.trv-tick-node { position: absolute; left: calc(var(--trv-node-x) - 4.5px); top: 15px; width: 9px; height: 9px; border-radius: 999px; background: var(--trv-tone, var(--dsw-alias-border-l2)); box-shadow: 0 0 0 3px var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base)); }
.trv-card { appearance: none; flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; text-align: left; font: inherit; color: inherit; cursor: pointer; padding: 7px 9px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); border-left: 3px solid var(--trv-tone, var(--dsw-alias-border-l1)); background: var(--dsw-alias-bg-layer-1); }
.trv-card:hover { background: var(--dsw-alias-bg-layer-2); }
.trv-card-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.trv-card-name { min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trv-card-dwell { margin-left: auto; flex: 0 0 auto; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.trv-fixed { flex: 0 0 auto; font-size: 10px; padding: 0 5px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, transparent); color: var(--dsw-alias-brand-primary); }
.trv-card-meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trv-grip { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 14px; line-height: 1; width: 22px; padding: 0; flex: 0 0 22px; align-self: center; cursor: grab; opacity: .45; touch-action: none; border-radius: 7px; }
.trv-grip:hover:not(:disabled) { opacity: 1; background: var(--dsw-alias-bg-layer-2); }
.trv-grip:active:not(:disabled) { cursor: grabbing; }
.trv-grip:disabled { cursor: default; opacity: .3; }
.trv-thumb { width: 64px; height: 64px; flex: 0 0 64px; border-radius: 10px; object-fit: cover; background: var(--dsw-alias-bg-layer-2); align-self: center; }
.trv-thumb-blank { display: grid; place-items: center; font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
/* While a stop is being dragged it lifts out of the list and the stops it
   passes slide by one slot, so the gap itself shows where it will land. */
.trv-timeline-dragging { cursor: grabbing; user-select: none; }
.trv-unit-dragging { z-index: 3; }
.trv-unit-dragging .trv-card { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 8px 20px rgb(0 0 0 / 20%); }
.trv-unit-dragging .trv-thumb { box-shadow: 0 8px 20px rgb(0 0 0 / 20%); }
.trv-unit-dragging .trv-tick-time { font-weight: 600; color: var(--dsw-alias-brand-primary); }
.trv-banner { width: 100%; max-height: 128px; object-fit: cover; border-radius: 10px; margin-bottom: 8px; }
.trv-hint-inline { font-size: 11px; color: var(--dsw-alias-label-secondary); align-self: center; }
.trv-reflow { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; margin: 0 0 8px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent); }
.trv-reflow-text { font-size: 11.5px; }
.trv-reflow-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.trv-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.trv-btn-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 85%, #000); }
.trv-wall { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.trv-wall-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.trv-wall-note { flex: 1; min-width: 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.trv-wall-card { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: 10px; overflow: hidden; padding: 0 0 6px; display: flex; flex-direction: column; gap: 3px; }
.trv-wall-on { border-color: var(--dsw-alias-brand-primary); }
.trv-wall-img { width: 100%; height: 84px; object-fit: cover; background: var(--dsw-alias-bg-layer-2); }
.trv-wall-blank { height: 84px; display: grid; place-items: center; background: var(--dsw-alias-bg-layer-2); font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.trv-wall-name { font-weight: 600; font-size: 12px; padding: 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trv-wall-meta { font-size: 10.5px; color: var(--dsw-alias-label-secondary); padding: 0 8px; }
.trv-inline { font-size: 11px; }
.trv-inline-error { color: var(--dsw-alias-state-error-primary); }
.trv-inline-warning { color: var(--dsw-alias-state-warn-primary); }
.trv-leg { display: flex; align-items: center; gap: 6px; margin-left: calc(var(--trv-rail-w, 46px) + 8px); padding: 4px 0; font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.trv-leg-failed { color: var(--dsw-alias-state-error-primary); }
.trv-leg-stale .trv-leg-icon { color: var(--dsw-alias-state-warn-primary); }
.trv-leg-icon { font-size: 11px; }
.trv-sheet { position: absolute; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 12px 32px rgb(0 0 0 / 22%); }
.trv-sheet-top { top: 46px; left: 10px; right: 10px; max-height: min(74%, 520px); border-radius: 12px; z-index: 12; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.trv-sheet-top > .trv-trip-list { flex: 1 1 auto; min-height: 0; overflow: auto; }
.trv-sheet-bottom { left: 10px; right: 10px; bottom: 10px; max-height: 70%; overflow: auto; border-radius: 12px; z-index: 12; padding: 10px 12px; }
/* The detail is a floating window: absolutely placed so it never changes the
   timeline's width, resizable from its inner edge, and sized from a preference
   the grip writes. --trv-detail-size is its height when it is a bottom window
   and its width once there is room for a side window. */
.trv-detail { position: absolute; right: 12px; left: auto; bottom: 12px; z-index: 12; display: flex; flex-direction: column; width: clamp(240px, var(--trv-detail-w, calc(100% - 24px)), calc(100% - 24px)); height: clamp(160px, var(--trv-detail-h, 260px), 72%); overflow: hidden; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); box-shadow: 0 12px 32px rgb(0 0 0 / 22%); }
.trv-detail-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 12px 12px; }
/* Three handles: an edge for each axis and a corner for both. The window is
   anchored bottom right, so left and up both mean bigger. */
.trv-detail-grip { position: absolute; touch-action: none; z-index: 2; }
.trv-detail-grip-top { left: 16px; right: 16px; top: 0; height: 12px; cursor: ns-resize; }
.trv-detail-grip-top::after { content: ''; position: absolute; left: 50%; top: 4px; transform: translateX(-50%); width: 36px; height: 4px; border-radius: 999px; background: var(--dsw-alias-border-l2); }
.trv-detail-grip-top:hover::after { background: var(--dsw-alias-brand-primary); }
.trv-detail-grip-side { display: none; }
.trv-detail-grip-corner { left: 0; top: 0; width: 18px; height: 18px; cursor: nwse-resize; }
.trv-detail-grip-corner::after { content: ''; position: absolute; left: 4px; top: 4px; width: 9px; height: 9px; border-left: 2px solid var(--dsw-alias-border-l2); border-top: 2px solid var(--dsw-alias-border-l2); border-radius: 4px 0 0 0; }
.trv-detail-grip-corner:hover::after { border-color: var(--dsw-alias-brand-primary); }
.trv-photo-empty { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding: 8px 10px; border-radius: 10px; border: 1px dashed var(--dsw-alias-border-l2); font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.trv-sheet-head { display: flex; align-items: center; gap: 6px; }
.trv-sheet-title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trv-sheet-spacer { width: 24px; }
.trv-sheet-kind { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.trv-sheet-foot { display: block; width: 100%; margin-top: 6px; appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; font-size: 11.5px; padding: 5px 8px; border-radius: 8px; cursor: pointer; }
.trv-sheet-foot:disabled { opacity: .55; cursor: default; }
.trv-trip-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.trv-trip { border-radius: 9px; }
.trv-trip-on { background: var(--dsw-alias-bg-layer-2); }
.trv-trip-hit { appearance: none; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; width: 100%; cursor: pointer; display: flex; gap: 8px; align-items: center; padding: 7px 8px; border-radius: 9px; }
.trv-trip-hit:hover { background: var(--dsw-alias-bg-layer-2); }
.trv-trip-main { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.trv-trip-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trv-trip-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.trv-trip-side { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.trv-trip-ready { font-weight: 600; }
.trv-badge { font-size: 10px; padding: 0 5px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 22%, transparent); color: var(--dsw-alias-state-warn-primary); }
.trv-overlay { position: absolute; inset: 0; z-index: 20; display: flex; flex-direction: column; background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base)); }
.trv-overlay-head { padding: 10px 12px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.trv-overlay-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px 12px; }
.trv-grid { margin: 8px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; font-size: 12px; }
.trv-grid-row { display: contents; }
.trv-grid dt { color: var(--dsw-alias-label-secondary); }
.trv-grid dd { margin: 0; word-break: break-all; }
.trv-notes { margin: 8px 0 0; padding-left: 16px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.trv-notes li { margin-bottom: 3px; }
.trv-actions { display: flex; gap: 6px; padding-top: 10px; flex-wrap: wrap; }
.trv-btn { appearance: none; font: inherit; color: inherit; cursor: pointer; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 8px; padding: 4px 10px; font-size: 12px; }
.trv-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.trv-btn:disabled { opacity: .45; cursor: default; }
.trv-btn-danger { color: var(--dsw-alias-state-error-primary); }
.trv-group { margin-bottom: 12px; }
.trv-group-head { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-secondary); margin: 8px 0 4px; font-weight: 600; }
.trv-place-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.trv-place-on { background: var(--dsw-alias-bg-layer-2); border-radius: 9px; }
.trv-place-hit { appearance: none; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; width: 100%; cursor: pointer; padding: 6px 8px; border-radius: 9px; display: flex; flex-direction: column; gap: 1px; }
.trv-place-hit:hover { background: var(--dsw-alias-bg-layer-2); }
.trv-place-name { font-weight: 600; }
.trv-place-addr, .trv-place-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.trv-alerts-intro { margin: 2px 0 10px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.trv-alert-label { font-weight: 600; color: var(--dsw-alias-label-primary); }
.trv-alert-sev { border-radius: 999px; padding: 0 6px; }
.trv-alert-sev-error { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent); color: var(--dsw-alias-state-error-primary); }
.trv-alert-sev-warning { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 20%, transparent); color: var(--dsw-alias-state-warn-primary); }
.trv-alert-what { margin: 4px 0 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.trv-alert-actions-row { display: flex; align-items: center; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.trv-alert-code { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-left: auto; opacity: .7; }
.trv-alert-foot { margin: 4px 0 0; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.trv-about-head { display: flex; align-items: center; gap: 12px; }
.trv-ring-big { width: 54px; height: 54px; font-size: 15px; }
.trv-ring-big::after { inset: 6px; }
.trv-about-title { font-size: 15px; font-weight: 600; }
.trv-about-sub { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.trv-about-list { margin: 12px 0 0; padding-left: 18px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.trv-about-list li { margin-bottom: 6px; }
.trv-alert { border-radius: 10px; padding: 8px 10px; margin-bottom: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.trv-alert-error { border-color: var(--dsw-alias-state-error-primary); }
.trv-alert-warning { border-color: var(--dsw-alias-state-warn-primary); }
.trv-alert-head { display: flex; justify-content: space-between; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.trv-alert-msg { margin: 4px 0 0; }
.trv-alert-ids, .trv-alert-actions { font-size: 11px; color: var(--dsw-alias-label-secondary); margin: 4px 0 0; padding-left: 14px; }
.trv-empty { padding: 26px 16px; text-align: center; color: var(--dsw-alias-label-secondary); }
.trv-empty-title { font-weight: 600; color: var(--dsw-alias-label-primary); margin-bottom: 4px; }
.trv-empty-body { font-size: 11.5px; }
.trv-error { margin: 8px 12px; padding: 6px 9px; border-radius: 8px; font-size: 11.5px; color: var(--dsw-alias-state-error-primary); border: 1px solid var(--dsw-alias-state-error-primary); }
.trv-notice { margin: 8px 12px; padding: 6px 9px; border-radius: 8px; font-size: 11.5px; background: var(--dsw-alias-bg-layer-2); }
.trv-skeleton { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.trv-skeleton-row { height: 14px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); animation: trv-pulse 1.4s ease-in-out infinite; }
.trv-skeleton-title { height: 18px; width: 60%; }
.trv-skeleton-short { width: 45%; }
.trv-skeleton-map { height: 168px; border-radius: 12px; background: var(--dsw-alias-bg-layer-2); animation: trv-pulse 1.4s ease-in-out infinite; }
@keyframes trv-pulse { 0%, 100% { opacity: .55 } 50% { opacity: 1 } }
/* A wide pane — an expanded or fullscreen Sidebar — shows every day and a
   taller map beside the timeline. The pane's own width decides, so the body
   needs no tab-information hook and cannot fail on one. */
${WIDE_PANE_QUERY} {
  .trv-map-compact { height: 240px; }
  .trv-map-comfortable { height: 340px; }
  /* Two rows: the map across the top, then the itinerary with the day list
     beside it. A grid rather than a wrapping flex row — with flex the map's
     capped width let the itinerary squeeze onto its line and collapse to a
     sliver, and the itinerary's height was never bounded, so a long trip was
     clipped with nothing to scroll. */
  .trv-body { display: grid; grid-template-columns: minmax(0, 1fr) 132px; grid-template-rows: auto minmax(0, 1fr); gap: 12px; padding-bottom: 16px; }
  .trv-side { display: contents; }
  .trv-side .trv-map-card { grid-column: 1 / -1; grid-row: 1; order: 0; flex: 0 0 auto; margin: 0; }
  /* A whole-trip route is about as tall as it is wide, so a short banner can
     only show it by giving up its scale. While the map is still a banner it
     takes a near-square box of its own, centred on its row — unless it is the
     full-pane tier, whose inset-0 rule this would otherwise out-specify and
     clamp to a 560×46vh block in the corner. */
  .trv-map-card.trv-map-all:not(.trv-map-full) { height: auto; width: 100%; aspect-ratio: 6 / 5; max-width: 560px; max-height: 46vh; justify-self: center; }
  .trv-col-main { grid-column: 1; grid-row: 2; max-width: 680px; }
  /* The rail scrolls on its own: the body no longer scrolls, so a long trip
     would otherwise clip the last days with no way to reach them. */
  .trv-rail { display: flex; flex-direction: column; gap: 2px; grid-column: 2; grid-row: 2; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; padding-right: 2px; }
  /* One line per day: a two-week trip then fits the rail instead of scrolling. */
  .trv-rail-day { appearance: none; border: 1px solid transparent; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: 9px; padding: 4px 7px; flex: 0 0 auto; }
  .trv-rail-on { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
  .trv-rail-id { font-weight: 600; font-size: 12px; }
  .trv-rail-meta { font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
  .trv-sheet-bottom { left: auto; right: 10px; width: 320px; }
  /* A side window: hug the content vertically, take the remembered width, and
     resize from the left edge. */
  .trv-detail { left: auto; right: 12px; bottom: 12px; width: clamp(240px, var(--trv-detail-w, 300px), 70%); height: var(--trv-detail-h, auto); max-height: 82%; }
  .trv-detail-grip-side { display: block; left: 0; top: 18px; bottom: 16px; width: 12px; cursor: ew-resize; }
  .trv-detail-grip-side::after { content: ''; position: absolute; left: 4px; top: 50%; transform: translateY(-50%); width: 4px; height: 36px; border-radius: 999px; background: var(--dsw-alias-border-l2); }
  .trv-detail-grip-side:hover::after { background: var(--dsw-alias-brand-primary); }
}
${SIDE_COLUMN_QUERY} {
  /* A wide pane is two zones: a document to read and a companion column to keep
     in view. The itinerary spans both rows, so it keeps the full height while
     the map sits above the day list beside it. */
  .trv-body { grid-template-columns: minmax(0, 680px) minmax(320px, 380px); grid-template-rows: auto minmax(0, 1fr); justify-content: center; gap: 16px; }
  .trv-col-main { grid-column: 1; grid-row: 1 / -1; }
  .trv-side .trv-map-card { grid-column: 2; grid-row: 1; }
  .trv-side .trv-map-card.trv-map-all { max-width: none; max-height: none; justify-self: stretch; }
  .trv-rail { grid-column: 2; grid-row: 2; }
}
${THREE_COLUMN_QUERY} {
  /* Three zones: the itinerary, a map that fills the height of its own column,
     and the day list as a full-height index. Measured on the user's real 14-day
     trip, the 593×205 banner this replaces fitted a 16° journey into 82° of
     longitude — Iran to Japan with the route a blob in the middle. At 490×684
     the box is 0.72:1, the first shape whose fit shows the route itself. */
  .trv-body { grid-template-columns: minmax(0, 620px) minmax(0, 1fr) 164px; grid-template-rows: minmax(0, 1fr); justify-content: start; gap: 14px; }
  .trv-col-main { grid-column: 1; grid-row: 1; max-width: 620px; }
  .trv-side .trv-map-card,
  .trv-side .trv-map-card.trv-map-all { grid-column: 2; grid-row: 1; height: auto; aspect-ratio: auto; max-width: none; max-height: none; justify-self: stretch; align-self: stretch; }
  .trv-side .trv-rail { grid-column: 3; grid-row: 1; }
  /* Fourteen rows in one screen: the column is tall enough not to scroll. */
  .trv-rail-day { padding: 3px 7px; }
  .trv-rail-foot { gap: 5px; }
  .trv-rail-note { min-width: 44px; }
}
@media (prefers-reduced-motion: no-preference) {
  .trv-card, .trv-mark, .trv-btn, .trv-trip-hit, .trv-grip { transition: background-color .12s ease, border-color .12s ease, opacity .12s ease; }
  /* Only the stops that open a slot animate; the dragged stop itself must
     follow the pointer without lag, so it is excluded from the transition. */
  .trv-timeline-dragging .trv-unit:not(.trv-unit-dragging) { transition: transform 180ms cubic-bezier(.2, .8, .2, 1); }
  /* The arrival render moves every unit by layout at once, where animating the
     offset that is being dropped would slide them the wrong way first. */
  .trv-timeline-committing .trv-unit:not(.trv-unit-dragging) { transition: none; }
  /* The released stop is the one exception: it eases from wherever the hand let
     go into the slot the list opened for it. */
  .trv-timeline-committing .trv-unit.trv-unit-dragging { transition: transform 170ms cubic-bezier(.2, .8, .2, 1); }
}
@media (prefers-reduced-motion: reduce) {
  .trv-skeleton-row, .trv-skeleton-map { animation: none; }
}
`
