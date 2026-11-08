import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { TravelView } from '../src/shared/view.js'

/**
 * Behavior of the SHIPPED browser bundle.
 *
 * The bundle is a lazy-CJS registration for the DSH client module loader, so it
 * cannot be imported like an ordinary module: this suite installs the loader
 * facade, executes the real `lib/client.js`, materializes its factory with a
 * `require` map holding only the baseline `react` module, and then drives the
 * cordis `apply` against a stub context to capture what the bundle registers.
 *
 * Rendering the exported `TravelPanel` with `react-dom/server` proves the view
 * projection reaches markup: the panel takes a resolved view and the two host
 * actions as props, so the loaded state is renderable without a DOM.
 */

interface LoaderRegistration {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

const PLUGIN_ID = '@skillre/dsh-plugin-travel-planner'

const react = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')

/**
 * Execute the built bundle once and keep its loader registration.
 *
 * An ESM import is cached, so the facade is installed before the single import
 * and the factory is materialized separately for each test.
 */
const bundleRegistration = await (async (): Promise<LoaderRegistration> => {
  const registrations: LoaderRegistration[] = []
  const globals = globalThis as unknown as { window?: { __ModuleLoader__?: unknown } }
  globals.window = {
    __ModuleLoader__: {
      load: (registration: LoaderRegistration) => {
        registrations.push(registration)
      },
    },
  }
  // The bundle is a build artifact with no declaration file; the loader facade
  // in this suite is its only consumer and is exercised dynamically.
  // @ts-expect-error -- build artifact has no types
  await import('../lib/client.js')
  const registration = registrations[0]
  if (registration === undefined) throw new Error('the bundle did not register itself with the module loader')
  return registration
})()

/** Module specifiers the last materialization requested. */
const requested: string[] = []

/** Materialize the bundle's exports against the baseline module table. */
function loadBundle(): Record<string, unknown> {
  requested.length = 0
  const require = (specifier: string): unknown => {
    requested.push(specifier)
    if (specifier === 'react') return react
    throw new Error(`the bundle requested an undeclared module: ${specifier}`)
  }
  return bundleRegistration.factory(require)
}

/** What the bundle contributed to the stubbed client registry. */
interface Captured {
  readonly tabDefinition: Record<string, unknown> | undefined
  readonly body: ((props: unknown) => unknown) | undefined
  readonly title: ((props: unknown) => unknown) | undefined
  readonly effectLabels: readonly string[]
}

/** Run the bundle's `apply` against a stub client context. */
function captureRegistrations(): Captured {
  const exports = loadBundle()
  const apply = exports['apply'] as (ctx: Context) => void
  const effectLabels: string[] = []
  let tabDefinition: Record<string, unknown> | undefined
  let body: ((props: unknown) => unknown) | undefined
  let title: ((props: unknown) => unknown) | undefined
  let registrations = 0

  const slots = {
    inject: (_name: string, callback: () => () => void) => callback(),
    register: (_options: { readonly key?: string }, component: (props: unknown) => unknown) => {
      registrations += 1
      if (registrations === 1) body = component
      else title = component
      return () => undefined
    },
  }
  const sidebarRightTabs = {
    register: (definition: Record<string, unknown>) => {
      tabDefinition = definition
      return () => undefined
    },
  }
  const ctx = {
    effect: (callback: () => unknown, label?: string) => {
      effectLabels.push(label ?? '')
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
    get: (name: string) => (name === 'slots' ? slots : name === 'sidebarRightTabs' ? sidebarRightTabs : undefined),
    slots,
    sidebarRightTabs,
  } as unknown as Context

  apply(ctx)
  return { tabDefinition, body, title, effectLabels }
}

/** Render the pure panel for one view. */
function renderPanel(
  view: TravelView,
  overrides: {
    readonly amapReady?: boolean
    /** 只有需要这个入口时才给：缺省就是「老宿主没有这条路由」。 */
    readonly onFillTransits?: (dayId?: string) => Promise<{ readonly planned: number; readonly skipped: number }>
  } = {},
): string {
  const exports = loadBundle()
  const Panel = exports['TravelPanel'] as (props: unknown) => unknown
  return renderToStaticMarkup(
    react.createElement(Panel as never, {
      view,
      sessionId: 'session-1',
      amapReady: overrides.amapReady ?? true,
      onMutate: async () => undefined,
      onFocusDay: async () => undefined,
      ...overrides.onFillTransits === undefined ? {} : { onFillTransits: overrides.onFillTransits },
    }) as never,
  )
}

/** Minimal trip view used as the rendered data. */
function makeView(): TravelView {
  return {
    trips: [
      {
        id: 'kyoto-3d',
        title: '京都 3 日慢游',
        status: 'drafting',
        startDate: '2026-10-02',
        endDate: '2026-10-04',
        durationDays: 3,
        revision: 3,
        updatedAt: '2026-09-15T01:00:00.000Z',
        activeScenarioId: 'main',
        destinations: ['京都'],
        readiness: 0.95,
        alerts: { error: 0, warning: 1, info: 1 },
      },
    ],
    headline: {
      tripId: 'kyoto-3d',
      title: '京都 3 日慢游',
      status: 'drafting',
      revision: 3,
      startDate: '2026-10-02',
      endDate: '2026-10-04',
      destinations: ['京都'],
      travelers: ['我', '伴侣'],
      currency: 'CNY',
      budgetLimit: 20000,
      budgetEstimated: 17400,
      readiness: 0.95,
      alerts: { error: 0, warning: 1, info: 1 },
      updatedAt: '2026-09-15T01:00:00.000Z',
    },
    days: [
      {
        id: 'd1',
        date: '2026-10-02',
        title: '东山与寺庙',
        areaLabel: '东山区',
        items: [
          {
            id: 'd1-i0',
            placeId: 'kiyomizu',
            name: '清水寺',
            category: '风景名胜',
            address: '京都府京都市东山区清水1-294',
            point: { longitude: 135.785, latitude: 34.9949, coordinateSystem: 'gcj02' },
            startAt: '2026-10-02T09:00:00+09:00',
            endAt: '2026-10-02T10:30:00+09:00',
            plannedDurationMinutes: 90,
            locked: true,
            notes: [],
            alertIds: [],
          },
          {
            id: 'd1-i1',
            placeId: 'ginkaku',
            name: '银阁寺',
            category: '风景名胜',
            address: '京都府京都市左京区银阁寺町2',
            point: { longitude: 135.7983, latitude: 35.027, coordinateSystem: 'gcj02' },
            plannedDurationMinutes: 75,
            locked: false,
            notes: [],
            alertIds: ['missing-route:d1'],
          },
        ],
        legs: [
          {
            id: 'd1-leg-1',
            fromItemId: 'd1-i0',
            toItemId: 'd1-i1',
            mode: 'walking',
            distanceMeters: 2100,
            durationSeconds: 1680,
            freshness: 'fresh',
            stale: false,
            steps: [{ instruction: '沿茶碗坂向北步行', distanceMeters: 2100, durationSeconds: 1680 }],
          },
        ],
        totalDistanceMeters: 2100,
        totalDurationSeconds: 1680,
        transits: [],
        alertIds: ['missing-route:d1'],
      },
      {
        id: 'd2',
        date: '2026-10-03',
        title: '咖啡与市场',
        items: [],
        legs: [],
        totalDistanceMeters: 0,
        totalDurationSeconds: 0,
        transits: [],
        alertIds: [],
      },
    ],
    places: [
      {
        id: 'kiyomizu',
        name: '清水寺',
        address: '京都府京都市东山区清水1-294',
        categories: ['风景名胜'],
        point: { longitude: 135.785, latitude: 34.9949, coordinateSystem: 'gcj02' },
        status: 'planned',
        providerPlaceId: 'B0KIYOMIZU',
        fetchedAt: '2026-09-15T01:00:00.000Z',
      },
    ],
    alerts: [
      {
        id: 'missing-route:d1',
        severity: 'warning',
        code: 'MISSING_ROUTE',
        message: 'd1 的相邻安排之间缺少交通信息。',
        relatedIds: ['d1-i1'],
        suggestedActions: ['重建当天交通'],
      },
    ],
    activeTripId: 'kyoto-3d',
    selectionSource: 'recent',
    map: { enabled: false, version: '2.0', style: 'normal' },
    photos: true,
    photoLookup: 'direct',
  }
}

describe('shipped client bundle', () => {
  it('registers one sidebar tab type with the required identity', () => {
    const captured = captureRegistrations()

    expect(bundleRegistration.id).toBe(PLUGIN_ID)
    expect(captured.tabDefinition?.['id']).toBe(PLUGIN_ID)
    expect(captured.tabDefinition?.['kind']).toBe('skillre-travel')
    expect(captured.tabDefinition?.['priority']).toBe('extension')
    const title = captured.tabDefinition?.['title'] as (address: string) => string
    expect(title('sidebar://skillre-travel')).toBe('行程')
    const guide = captured.tabDefinition?.['guide'] as readonly { readonly title: () => string }[]
    expect(guide).toHaveLength(1)
    expect(guide[0]?.title()).toBe('旅行行程')
  })

  it('registers the body and the title into the keyed seats under its own id', () => {
    const captured = captureRegistrations()

    expect(captured.body).toBeTypeOf('function')
    expect(captured.title).toBeTypeOf('function')
    expect(captured.effectLabels).toEqual([
      'travel-planner: tab type',
      'travel-planner: tab body',
      'travel-planner: tab title',
    ])
  })

  it('requests only the baseline react module and declares the two client services', () => {
    const exports = loadBundle()

    expect(requested).toEqual(['react'])
    expect(exports['inject']).toEqual(['slots', 'sidebarRightTabs'])
  })

  it('renders the header, day title, stops and the transit leg', () => {
    const html = renderPanel(makeView())

    expect(html).toContain('京都 3 日慢游')
    expect(html).toContain('2026-10-02 → 2026-10-04')
    expect(html).toContain('东山与寺庙')
    expect(html).toContain('清水寺')
    expect(html).toContain('银阁寺')
    expect(html).toContain('09:00')
    expect(html).toContain('步行 2.1 km')
    // The day head replaced the pager: the whole trip is one scroll now, with
    // the day's own numbers on its sticky header.
    expect(html).toContain('trv-day-head')
    expect(html).toContain('trv-day-head-facts')
    expect(html).toContain('D1')
    expect(html).toContain('trv-rail')
    expect(html).toContain('D2')
  })

  it('shows lock state, readiness and the alert summary', () => {
    const html = renderPanel(makeView())

    expect(html).toContain('95%')
    expect(html).toContain('1 警告')
    expect(html).toContain('1 提示')
    expect(html).toContain('草案')
    expect(html).toContain('--trv-ready:95')
  })

  // The body must not read the Sidebar's presentation mode: that hook is a
  // selector hook, and a body that throws during a render abdicates its slot.
  // The pane's own width decides the layout instead.
  it('renders one map card and leaves the wide layout to a container query', () => {
    const html = renderPanel(makeView())

    expect(html).toContain('trv-map-card')
    // Two stops in the fixture, so two teardrops — and no day anchors, because a
    // single day is drawn.
    expect(html.match(/class="trv-map-pin"/g) ?? []).toHaveLength(2)
    expect(html.match(/class="trv-map-pin-id"/g) ?? []).toHaveLength(2)
    expect(html.match(/class="trv-map-pin-name"/g) ?? []).toHaveLength(2)
    expect(html).toContain('trv-rail')
    expect(html).toContain('@container (min-width: 560px)')
    expect(html).toContain('.trv-rail { display: none; }')
  })

  it('numbers every stop instead of labelling a 起 and a 终 per day', () => {
    const html = renderPanel(makeView())

    // A two-week trip has fourteen days, so per-day 起/终 labels were dozens of
    // identical markers. Each stop carries its own order number now.
    expect(html).toContain('>1<')
    expect(html).toContain('>2<')
    expect(html).not.toContain('>起<')
    expect(html).not.toContain('>终<')
    // The pin is a teardrop whose tail takes the marker's own colour.
    expect(html).toContain('--trv-pin')
  })

  it('connects single-stop days into one continuous route', () => {
    const buildRouteSegments = loadBundle()['buildRouteSegments'] as (groups: readonly unknown[]) => readonly {
      readonly dayIndex: number
      readonly points: readonly unknown[]
    }[]
    const stop = (id: string) => ({ placeId: id, point: { longitude: 100, latitude: 30, coordinateSystem: 'gcj02' } })
    const groups = [
      { dayId: 'd1', date: '2026-09-24', dayOrder: 1, stops: [stop('a'), stop('b')] },
      { dayId: 'd2', date: '2026-09-25', dayOrder: 2, stops: [stop('c')] },
      { dayId: 'd3', date: '2026-09-26', dayOrder: 3, stops: [stop('d')] },
    ]

    const segments = buildRouteSegments(groups)

    // d2 owns a single stop, so on its own it would draw nothing; it reaches
    // into d3 instead, and every segment is at least a line.
    expect(segments.map((segment) => segment.points.length)).toEqual([3, 2, 1].filter((size) => size > 1))
    expect(segments.map((segment) => segment.dayIndex)).toEqual([0, 1])

    // The schematic draws those segments too, so a one-stop day is never a gap.
    const TripMap = loadBundle()['TripMap'] as (props: unknown) => unknown
    const view = makeView()
    const first = view.days[0]
    const firstItem = first?.items[0]
    if (first === undefined || firstItem === undefined) throw new Error('fixture is missing its first day')
    const days = [first, { ...first, id: 'd2', items: [firstItem] }]
    const html = renderToStaticMarkup(
      react.createElement(TripMap as never, {
        map: { enabled: false, version: '2.0', style: 'normal' },
        days,
        day: days[0],
        range: 'all',
        tier: 'compact',
        onRange: () => undefined,
        onTier: () => undefined,
        selectedPlaceId: undefined,
        onSelect: () => undefined,
      }) as never,
    )

    expect(html.match(/class="trv-line"/g) ?? []).toHaveLength(1)
  })

  it('lets the day rail scroll so a long trip cannot hide its last days', () => {
    const styles = (loadBundle()['STYLES'] as string).replace(/\n\s*/g, ' ')
    // The rail is hidden while narrow and laid out as a column once wide, so the
    // scrolling rule lives in the container query rather than the base rule.
    const rails = [...styles.matchAll(/\.trv-rail \{[^}]*\}/g)].map((match) => match[0])
    const wide = rails.filter((rule) => rule.includes('display: flex'))

    expect(wide).toHaveLength(1)
    expect(wide[0]).toContain('overflow-y: auto')
    expect(wide[0]).toContain('min-height: 0')
    // …and every row states its date, its colour on the map and how far.
    expect(styles).toContain('.trv-rail-bar')
    expect(styles).toContain('.trv-rail-note')
    expect(styles).toContain('.trv-rail-swatch')
    // A row with nothing to warn about keeps the badge cell, quietly: rows whose
    // badge simply vanished looked like a rendering fault.
    expect(styles).toContain('.trv-rail-gap-off')
  })

  it('derives the day-to-day hops a driving trip only states in its titles', () => {
    const parseTransferTitle = loadBundle()['parseTransferTitle'] as (title: string) => {
      readonly origin?: string
      readonly destination?: string
      readonly distanceMeters?: number
    }
    const buildTransfers = loadBundle()['buildTransfers'] as (days: readonly unknown[]) => readonly {
      readonly origin: string
      readonly destination: string
      readonly source: string
      readonly distanceMeters?: number
      readonly durationSeconds?: number
    }[]

    expect(parseTransferTitle('北京 → 西安｜赶路 1,077km')).toEqual({
      origin: '北京',
      destination: '西安',
      distanceMeters: 1_077_000,
    })
    expect(parseTransferTitle('丽江｜婚纱照拍摄日')).toEqual({})

    const view = makeView()
    const first = view.days[0]
    if (first === undefined) throw new Error('fixture is missing its first day')
    const stop = { ...(first.items[0] as object), id: 'x1', placeId: 'p-x', name: '西安', point: { longitude: 108.9, latitude: 34.2, coordinateSystem: 'gcj02' } }
    const titleDay = (id: string, title: string, legs: readonly unknown[] = []) => ({
      ...first,
      id,
      title,
      items: [stop],
      legs,
      totalDistanceMeters: 0,
      totalDurationSeconds: 0,
      alertIds: [],
    })

    // A recorded leg wins over the title…
    const recorded = buildTransfers([
      first,
      titleDay('d2', '西安 → 成都｜翻秦岭 723km', [
        {
          id: 'l1',
          // A cross-day hop is recorded on the day it arrives, starting from the
          // previous day's last stop.
          fromItemId: first.items[first.items.length - 1]?.id ?? 'd1-i1',
          toItemId: 'x1',
          mode: 'driving',
          distanceMeters: 710_000,
          durationSeconds: 28_800,
          freshness: 'fresh',
          stale: false,
          steps: [],
        },
      ]),
    ])
    expect(recorded[0]).toMatchObject({ origin: '西安', destination: '成都', source: 'recorded', distanceMeters: 710_000, durationSeconds: 28_800 })

    // …a title alone is reported as such, without inventing a duration…
    const fromTitle = buildTransfers([first, titleDay('d3', '西安 → 成都｜翻秦岭 723km')])
    expect(fromTitle[0]).toMatchObject({ origin: '西安', destination: '成都', source: 'title', distanceMeters: 723_000 })
    expect(fromTitle[0]?.durationSeconds).toBeUndefined()

    // …a first leg that is the day's longest is the city change itself…
    const inbound = buildTransfers([
      first,
      {
        ...titleDay('d5', '丽江 → 大理｜洱海 175km', [
          {
            id: 'l2',
            fromItemId: 'x1',
            toItemId: 'x2',
            mode: 'driving',
            distanceMeters: 175_000,
            durationSeconds: 10_800,
            freshness: 'fresh',
            stale: false,
            steps: [],
          },
        ]),
        items: [stop, { ...stop, id: 'x2', placeId: 'p-y', name: '大理' }],
      },
    ])
    expect(inbound[0]).toMatchObject({
      origin: '丽江',
      destination: '大理',
      source: 'recorded',
      distanceMeters: 175_000,
      // The stops at each end travel with the hop — the previous day's last stop
      // and the arriving day's first — so promoting it into a transit gives the
      // road coordinates to be drawn between.
      fromPlaceId: 'ginkaku',
      toPlaceId: 'p-x',
    })

    // …and a stay day is not a hop at all: no 「丽江古城 → 丽江古城」 row. The
    // stay-day fixture keeps its stop in the city the previous day ended in.
    const lastStop = first.items[first.items.length - 1]
    if (lastStop === undefined) throw new Error('fixture is missing its last stop')
    const stay = buildTransfers([first, { ...titleDay('d4', '西安｜休整'), items: [lastStop] }])
    expect(stay).toEqual([])
  })

  it('scales each day against the busiest one, and labels a post-midnight clock', () => {
    const view = makeView()
    const dayIntensity = loadBundle()['dayIntensity'] as (days: readonly unknown[]) => readonly number[]
    const clockLabel = loadBundle()['clockLabel'] as (startAt: string | undefined) => string
    const first = view.days[0]
    if (first === undefined) throw new Error('fixture is missing its first day')

    // The bar and the number in the same row describe the same kilometres, so a
    // day whose hop only exists in its title still gets a bar.
    const light = { ...first, id: 'light', totalDistanceMeters: 36_000 }
    const busy = { ...first, id: 'busy', totalDistanceMeters: 360_000 }
    expect(dayIntensity([light, busy])).toEqual([0.1, 1])
    expect(dayIntensity([{ ...light, totalDistanceMeters: 0 }, { ...busy, totalDistanceMeters: 0 }])).toEqual([0, 0])

    expect(clockLabel('2026-09-24T00:30:00+08:00')).toBe('00:30')
    expect(clockLabel('2026-09-24T12:00:00+08:00')).toBe('12:00')
    expect(clockLabel(undefined)).toBe('—')
  })

  it('puts the whole trip in one scroll: every day is a section with a sticky head', () => {
    const html = renderPanel(makeView())

    // Two fixture days, two sections, each with a sticky head. Neither fixture
    // day states a hop its legs do not cover, so there is no transfer row here —
    // matched on the element rather than on the string, which the inlined
    // stylesheet would satisfy on its own.
    expect(html.match(/class="trv-day"/g) ?? []).toHaveLength(2)
    expect(html.match(/class="trv-day-head"/g) ?? []).toHaveLength(2)
    expect(html).not.toContain('class="trv-transfer')
    expect(html).toContain('.trv-day-head { position: sticky')
  })

  it('puts a cross-day row under the day it arrives at, not in the gap above it', () => {
    const view = makeView()
    const first = view.days[0]
    const second = view.days[1]
    if (first === undefined || second === undefined) throw new Error('fixture is missing its days')

    const html = renderPanel({ ...view, days: [first, { ...second, title: '京都 → 奈良｜45km' }] })
    const secondHead = html.indexOf('trv-day-head', html.indexOf('trv-day-head') + 1)

    expect(html).toContain('class="trv-transfer trv-transfer-title"')
    expect(html.indexOf('class="trv-transfer')).toBeGreaterThan(secondHead)
  })

  it('keeps a skipped day from shifting the labels and colours of the rest', () => {
    const view = makeView()
    const first = view.days[0]
    const second = view.days[1]
    if (first === undefined || second === undefined) throw new Error('fixture is missing its days')

    // The first day has no located stop, so the map draws the second day alone —
    // it must still be D2, exactly as the day list and the real map call it. The
    // whole-trip range is a stored preference, so it is fed in like the browser
    // would.
    const store = { 'skillre-travel:ui': JSON.stringify({ mapRange: 'all', mapTier: 'compact' }) }
    const previous = (globalThis as { localStorage?: unknown }).localStorage
    ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: (key: string) => store[key as keyof typeof store] ?? null }
    let markup = ''
    try {
      markup = renderPanel({ ...view, days: [{ ...first, items: [] }, { ...second, items: first.items }] })
    } finally {
      ;(globalThis as { localStorage?: unknown }).localStorage = previous
    }
    // Anchored on the elements: the inlined stylesheet also names these classes.
    const marks = markup.slice(markup.indexOf('class="trv-map-marks"'), markup.indexOf('class="trv-map-bar"'))
    const rail = markup.slice(markup.indexOf('class="trv-rail"'))
    const located = makeView().days[0]?.items[0]

    expect(marks).toContain('>D2<')
    expect(marks).not.toContain('>D1<')
    // The day list colours that row with its position in the trip, so the map's
    // marker for the same day must use the same entry: the second one.
    expect(rail).toContain('var(--dsw-alias-state-success-primary)')
    expect(marks).toContain('var(--dsw-alias-state-success-primary)')
    // A dot carries no text, so it needs a name of its own.
    expect(marks).toContain(`aria-label="${located?.name ?? ''}"`)
  })

  it('refits when the drawn set or the box changes, and never on emphasis alone', () => {
    const fitKeyOf = loadBundle()['fitKeyOf'] as (
      range: string,
      groups: readonly unknown[],
      days: readonly unknown[],
      box: string,
    ) => string
    const group = (dayId: string, stops: number): unknown => ({
      dayId,
      date: '2026-10-02',
      dayOrder: 1,
      stops: Array.from({ length: stops }, () => ({ placeId: 'p', point: { longitude: 120, latitude: 30 } })),
    })
    const day = (id: string, transits: readonly unknown[]): unknown => ({ id, transits })

    const days = [day('d1', []), day('d2', [])]
    const base = fitKeyOf('all', [group('d1', 2), group('d2', 1)], days, '480x648')
    // Same drawn set, same box: nothing to re-fit.
    expect(fitKeyOf('all', [group('d1', 2), group('d2', 1)], days, '480x648')).toBe(base)
    // The box is the axis the whole-trip map was wrong on, so it is in the key.
    expect(fitKeyOf('all', [group('d1', 2), group('d2', 1)], days, '480x672')).not.toBe(base)
    expect(fitKeyOf('all', [group('d1', 2), group('d2', 1)], days, '384x648')).not.toBe(base)
    expect(fitKeyOf('day', [group('d1', 2)], days, '480x648')).not.toBe(base)
    expect(fitKeyOf('all', [group('d1', 3)], days, '480x648')).not.toBe(base)

    // A transit end that gains coordinates is a new thing on the map, even
    // though no stop count changed: a refreshed place must be framed too.
    const withEnd = [day('d1', []), day('d2', [{ id: 't1', from: { label: '西安', point: { longitude: 108.9, latitude: 34.2 } }, to: { label: '成都' } }])]
    expect(fitKeyOf('all', [group('d1', 2), group('d2', 1)], withEnd, '480x648')).not.toBe(base)
  })

  it('names fourteen days with five theme colours', () => {
    const dayColorKey = loadBundle()['dayColorKey'] as (index: number) => string
    const mixHex = loadBundle()['mixHex'] as (hex: string, amount: number) => string

    // The palette cycles every five days, so D1, D6 and D11 used to be one blue.
    const keys = Array.from({ length: 14 }, (_, index) => dayColorKey(index))
    expect(new Set(keys).size).toBe(14)

    expect(mixHex('#3b82f6', 0)).toBe('#3b82f6')
    expect(mixHex('#000000', 0.5)).toBe('#808080')
    expect(mixHex('#ffffff', -0.5)).toBe('#808080')
    expect(mixHex('rgb(1, 2, 3)', 0.4)).toBe('rgb(1, 2, 3)')
  })

  it('lays a maximised pane out as itinerary, map and day list', () => {
    const styles = (loadBundle()['STYLES'] as string).replace(/\n\s*/g, ' ')
    const body = /\.trv-body \{[^}]*\}/g
    const rules = [...styles.matchAll(body)].map((match) => match[0])

    // Narrow: one column, the map a banner in the flow.
    expect(styles).toContain('.trv-side { display: contents; }')
    expect(rules.some((rule) => rule.includes('flex-direction: column'))).toBe(true)
    // Wider: two rows on a grid — map across the top, itinerary with the day
    // list beside it. A wrapping flex row let the itinerary collapse to a
    // 156px sliver and clipped it with nothing to scroll.
    expect(rules.some((rule) => rule.includes('grid-template-columns: minmax(0, 1fr) 132px'))).toBe(true)
    expect(styles).toContain('.trv-col-main { grid-column: 1; grid-row: 2; max-width: 680px; }')
    // Wide: the itinerary spans both rows, the map above the day list beside it.
    expect(styles).toContain('@container (min-width: 1080px)')
    expect(rules.some((rule) => rule.includes('grid-template-columns: minmax(0, 680px) minmax(320px, 380px)'))).toBe(true)
    expect(styles).toContain('.trv-col-main { grid-column: 1; grid-row: 1 / -1; }')
    // Widest: three zones, and the map fills the height of its own column — a
    // whole-trip route is about square, so the box decides whether the route or
    // half of Asia fills the frame.
    expect(styles).toContain('@container (min-width: 1240px)')
    expect(rules.some((rule) => rule.includes('grid-template-columns: minmax(0, 620px) minmax(0, 1fr) 164px'))).toBe(true)
    expect(styles).toContain('.trv-side .trv-rail { grid-column: 3; grid-row: 1; }')
    // Nothing may pin the map back to a fixed banner height once it has a column.
    expect(styles).toContain('.trv-side .trv-map-card.trv-map-all { grid-column: 2; grid-row: 1; height: auto; aspect-ratio: auto; max-width: none; max-height: none; justify-self: stretch; align-self: stretch; }')
  })

  it('says an unrecorded hop with a dot instead of repeating it in words', () => {
    const view = makeView()
    const second = view.days[1]
    if (second === undefined) throw new Error('fixture is missing its second day')
    // A day that changes city in its title while recording no leg for it.
    const html = renderPanel({ ...view, days: [view.days[0] as never, { ...second, title: '京都 → 奈良｜45km' }] })

    expect(html).toContain('trv-rail-gap')
    expect(html).toContain('换了城市但没有交通记录')
  })

  it('stacks the day head into a route line and a facts line', () => {
    const html = renderPanel(makeView())

    expect(html).toContain('trv-day-head-main')
    expect(html).toContain('trv-day-head-numbers')
    expect(html).toContain('trv-day-head-actions')
    // The position in the trip is the day list's job, not the header's.
    expect(html).not.toContain('trv-day-head-index')
    expect(html).not.toContain('1/2')
  })

  it('lets the map follow the itinerary with a focus control', () => {
    const TripMap = loadBundle()['TripMap'] as (props: unknown) => unknown
    const view = makeView()
    const render = (range: string, activeDayId: string | undefined): string =>
      renderToStaticMarkup(
        react.createElement(TripMap as never, {
          map: { enabled: false, version: '2.0', style: 'normal' },
          days: view.days,
          day: view.days[0],
          range,
          tier: 'comfortable',
          activeDayId,
          onRange: () => undefined,
          onTier: () => undefined,
          selectedPlaceId: undefined,
          onSelect: () => undefined,
        }) as never,
      )

    // The whole-trip map offers to zoom to the day the itinerary is showing…
    const all = render('all', 'd1')
    expect(all).toContain('聚焦当前天')
    // …while the single-day map has nothing to focus.
    expect(render('day', 'd1')).not.toContain('聚焦当前天')
  })

  it('hides the place strip while the whole trip is on the map', () => {
    const TripMap = loadBundle()['TripMap'] as (props: unknown) => unknown
    const view = makeView()
    const render = (range: string): string =>
      renderToStaticMarkup(
        react.createElement(TripMap as never, {
          map: { enabled: false, version: '2.0', style: 'normal' },
          days: view.days,
          day: view.days[0],
          range,
          tier: 'full',
          onRange: () => undefined,
          onTier: () => undefined,
          selectedPlaceId: undefined,
          onSelect: () => undefined,
        }) as never,
      )

    // The strip belongs to one day, and the whole-trip view has no legend to
    // keep: it covered the AMap attribution and repeated the day list beside it.
    expect(render('day')).toContain('trv-map-strip')
    expect(render('all')).not.toContain('trv-map-strip')
    expect(render('all')).not.toContain('trv-legend')
    // The note is the map's key. It used to explain only the single-day dashed
    // line, but the whole-trip view now draws driving routes of its own, so the
    // key travels with both ranges.
    expect(render('day')).toContain('trv-map-note')
    expect(render('all')).toContain('trv-map-note')
    expect(render('all')).toContain('实线=已规划路线 · 长虚线=按标题估算')
  })

  it('anchors each day at its first stop and numbers the rest', () => {
    const pinLabel = loadBundle()['pinLabel'] as (range: string, dayOrder: number, stopIndex: number) => string

    // One day on its own: every stop is numbered 1..n.
    expect(pinLabel('day', 3, 0)).toBe('1')
    expect(pinLabel('day', 3, 4)).toBe('5')
    // Fourteen days at once: the day's first stop is the anchor that says which
    // day it is, and the stops after it keep their place in that day.
    expect(pinLabel('all', 3, 0)).toBe('D3')
    expect(pinLabel('all', 3, 4)).toBe('5')
    // Every stop is a teardrop: the pin model has no dots left.
    expect(loadBundle()['pinIsDot']).toBeUndefined()
    expect((loadBundle()['STYLES'] as string)).not.toContain('.trv-map-dot')
  })

  it('names the markers when the view has room for the names', () => {
    const showPinNames = loadBundle()['showPinNames'] as (zoom: number, stops: number) => boolean

    // A country-wide whole-trip view: no names, they would be a pile.
    expect(showPinNames(5, 32)).toBe(false)
    // Zoomed in past the threshold, or a view with only a handful of stops.
    expect(showPinNames(6, 32)).toBe(true)
    expect(showPinNames(4, 4)).toBe(true)
    // The schematic has no zoom at all, so it falls back to the stop count.
    expect(showPinNames(0, 32)).toBe(false)
    expect(showPinNames(0, 8)).toBe(true)

    // The name is on every marker and hidden by CSS until the view earns it.
    const html = renderPanel(makeView())
    expect(html).toContain('class="trv-map-pin-name"')
    expect(html).toContain('.trv-map-labels .trv-map-pin-name { display: block; }')
    // The fixture draws four stops, so the sketch names them.
    expect(html).toContain('class="trv-map trv-map-labels"')
  })

  it('prints a day distance once, and says when it is only an estimate', () => {
    const view = makeView()
    const dayFacts = loadBundle()['dayFacts'] as (day: unknown) => Record<string, unknown>
    const dayDistanceText = loadBundle()['dayDistanceText'] as (facts: Record<string, unknown>) => string
    const dayDistanceMeters = loadBundle()['dayDistanceMeters'] as (facts: Record<string, unknown>) => number
    const first = view.days[0]
    const second = view.days[1]
    if (first === undefined || second === undefined) throw new Error('fixture is missing its days')

    // A measured day prints its own figure…
    const measured = dayFacts({ ...first, totalDistanceMeters: 723_000 })
    expect(dayDistanceText(measured)).toBe('723 km')
    expect(dayDistanceMeters(measured)).toBe(723_000)
    // …while a day that only states its hop in the title prints the claim as one.
    const stated = dayFacts({ ...second, title: '西安 → 成都｜翻秦岭 723km', legs: [], totalDistanceMeters: 0, items: [] })
    expect(stated['estimatedDistanceMeters']).toBe(723_000)
    expect(dayDistanceText(stated)).toBe('≈723 km')
    expect(dayDistanceMeters(stated)).toBe(723_000)
    // A day with measured legs never borrows the title's number.
    const both = dayFacts({ ...second, title: '西安 → 成都｜翻秦岭 723km', legs: first.legs, totalDistanceMeters: 690_000 })
    expect(both['estimatedDistanceMeters']).toBeUndefined()
    expect(dayDistanceText(both)).toBe('690 km')
    // Nothing to say: a day with no stops at all, and a day inside one city.
    expect(dayDistanceText(dayFacts({ ...first, title: '丽江｜拍照', legs: [], items: [], totalDistanceMeters: 0 }))).toBe('—')
    expect(dayDistanceText(dayFacts({ ...second, title: '大理｜休整', legs: [], items: first.items }))).toBe('市内')
  })

  it('builds the day header numbers without a leading separator and without repeats', () => {
    const view = makeView()
    const dayHeadNumbers = loadBundle()['dayHeadNumbers'] as (day: unknown) => string
    const first = view.days[0]
    const second = view.days[1]
    if (first === undefined || second === undefined) throw new Error('fixture is missing its days')

    // The facts line used to begin with 「· 1 站」 whenever the day had neither a
    // duration nor a measured distance.
    const quiet = dayHeadNumbers({ ...second, title: '丽江｜拍照', legs: [], items: first.items, totalDistanceMeters: 0, totalDurationSeconds: 0 })
    expect(quiet.startsWith('·')).toBe(false)
    expect(quiet).toBe('2 站 · 停留 2 小时 45 分')
    // The title already states 723km, so the header does not say it again…
    const agreed = dayHeadNumbers({ ...second, title: '西安 → 成都｜翻秦岭 723km', items: first.items, totalDistanceMeters: 723_000 })
    expect(agreed).not.toContain('723')
    expect(agreed).toContain('2 站')
    // …but a routed distance that disagrees with the title is worth saying.
    const disagreed = dayHeadNumbers({ ...second, title: '西安 → 成都｜翻秦岭 723km', items: first.items, totalDistanceMeters: 1_050_000 })
    expect(disagreed).toContain('1050 km')
  })

  it('says what a cross-day row is missing instead of repeating the day title', () => {
    const transferLines = loadBundle()['transferLines'] as (transfer: Record<string, unknown>) => {
      readonly text: string
      readonly note: string | undefined
    }

    // A hop that only exists in the title: the header right above it already
    // named both cities and the distance, so the row carries neither.
    const stated = transferLines({ origin: '西安', destination: '成都', distanceMeters: 723_000, source: 'title' })
    expect(stated.text).toBe('跨城交通未记录')
    expect(stated.note).toBe('里程按当天标题估算')
    expect(stated.text).not.toContain('西安')
    expect(stated.note).not.toContain('723')
    // A recorded hop has numbers of its own, so it prints them.
    const recorded = transferLines({ origin: '丽江', destination: '大理', distanceMeters: 175_000, durationSeconds: 9_180, source: 'recorded' })
    expect(recorded.text).toContain('丽江 → 大理')
    expect(recorded.text).toContain('175 km')
    expect(recorded.text).toContain('2 小时 33 分')
    expect(recorded.note).toBeUndefined()
  })

  it('knows where the map should go when a stop is picked', () => {
    const focusPointFor = loadBundle()['focusPointFor'] as (
      groups: readonly unknown[],
      placeId: string | undefined,
    ) => { readonly longitude: number; readonly latitude: number } | undefined
    const point = (longitude: number, latitude: number) => ({ longitude, latitude, coordinateSystem: 'gcj02' })
    const groups = [
      { dayId: 'd1', date: '2026-10-01', dayOrder: 1, stops: [{ placeId: 'p1', point: point(120.1, 30.2) }] },
      { dayId: 'd2', date: '2026-10-02', dayOrder: 2, stops: [{ placeId: 'p2', point: point(108.9, 34.2) }] },
    ]

    expect(focusPointFor(groups, 'p2')).toEqual(point(108.9, 34.2))
    // Nothing picked, nothing to move to.
    expect(focusPointFor(groups, undefined)).toBeUndefined()
    // A place the map is not drawing — another day's stop while one day is on
    // screen — has no marker to travel to.
    expect(focusPointFor([groups[0] as never], 'p2')).toBeUndefined()
  })

  it('draws a day that has nothing but a transit', () => {
    const buildGroups = loadBundle()['buildGroups'] as (
      days: readonly unknown[],
      day: unknown,
      range: string,
    ) => readonly { readonly dayId: string; readonly stops: readonly unknown[] }[]
    const transitEnds = loadBundle()['transitEnds'] as (
      groups: readonly unknown[],
      days: readonly unknown[],
    ) => readonly unknown[]
    const point = (longitude: number, latitude: number) => ({ longitude, latitude, coordinateSystem: 'gcj02' })
    const driveDay = {
      id: 'd2',
      date: '2026-10-02',
      title: '西安 → 成都',
      items: [],
      legs: [],
      totalDistanceMeters: 0,
      totalDurationSeconds: 0,
      transits: [
        {
          id: 't1',
          from: { label: '西安', point: point(108.9, 34.2) },
          to: { label: '成都', point: point(104.1, 30.7) },
          mode: 'driving',
          distanceMeters: 723_000,
          freshness: 'fresh',
          stale: false,
          source: 'amap-cli',
          steps: [],
        },
      ],
      alertIds: [],
    }
    const stopDay = {
      ...driveDay,
      id: 'd1',
      transits: undefined,
      items: [
        {
          id: 'i1',
          placeId: 'p1',
          name: '西湖',
          category: '风景名胜',
          address: '地址',
          point: point(120.1, 30.2),
          locked: false,
          notes: [],
          alertIds: [],
        },
      ],
    }
    const days = [stopDay, driveDay]

    // The whole trip: the driving day is drawn, because its ends are located.
    const all = buildGroups(days, days[0], 'all')
    expect(all.map((group) => group.dayId)).toEqual(['d1', 'd2'])
    expect(all[1]?.stops).toEqual([])
    expect(transitEnds(all, days)).toHaveLength(2)

    // And on its own: this is the day the map used to answer with
    // 「这一天还没有带坐标的地点。」
    const single = buildGroups(days, driveDay, 'day')
    expect(single.map((group) => group.dayId)).toEqual(['d2'])
    expect(transitEnds(single, days)).toHaveLength(2)

    // A day with neither a stop nor a located end is still skipped.
    const empty = buildGroups([{ ...stopDay, id: 'd0', items: [], transits: [] }], days[0], 'all')
    expect(empty).toEqual([])

    // The sketch renders the two ends rather than the empty state.
    const markup = renderToStaticMarkup(
      react.createElement(loadBundle()['TripMap'] as never, {
        map: { enabled: false, version: '2.0', style: 'normal' },
        days,
        day: driveDay,
        range: 'day',
        tier: 'compact',
        activeDayId: 'd2',
        selectedPlaceId: undefined,
        onRange: () => undefined,
        onTier: () => undefined,
        onSelect: () => undefined,
      }) as never,
    )
    expect(markup).toContain('class="trv-map-end"')
    expect(markup).not.toContain('trv-map-empty')
  })

  it('gives a day spent driving its own card instead of a made-up stop', () => {
    const view = makeView()
    const first = view.days[0]
    const second = view.days[1]
    if (first === undefined || second === undefined) throw new Error('fixture is missing its days')

    const transitDay = {
      ...second,
      title: '西安 → 成都｜翻秦岭 723km',
      items: [],
      transits: [
        {
          id: 'd2-transit-1',
          from: { label: '西安' },
          to: { label: '成都' },
          mode: 'driving' as const,
          distanceMeters: 723_000,
          durationSeconds: 8 * 3600,
          departAt: '2026-10-02T08:00:00+08:00',
          arriveAt: '2026-10-02T16:00:00+08:00',
          freshness: 'stale' as const,
          stale: false,
          source: 'title',
          steps: [],
        },
      ],
    }
    const html = renderPanel({ ...view, days: [first, transitDay] as never })

    // The road is the day's content, so the empty-day notice is gone and the
    // transit card takes its place.
    expect(html).toContain('class="trv-transit trv-transit-estimated"')
    expect(html).toContain('西安 → 成都')
    expect(html).toContain('723 km')
    expect(html).toContain('按标题估算')
    expect(html).toContain('用高德重算')
    expect(html).not.toContain('这一天还没有安排')
    // …and the derived cross-day row stands down: the day records its own move.
    expect(html).not.toContain('class="trv-transfer')
    // The header says the day changes city, and the numbers include the road.
    expect(html).toContain('转场')
  })

  it('counts a transit towards the day, and stops calling the hop unrecorded', () => {
    const view = makeView()
    const dayFacts = loadBundle()['dayFacts'] as (day: unknown) => Record<string, number>
    const hasUnrecordedTransfer = loadBundle()['hasUnrecordedTransfer'] as (day: unknown) => boolean
    const transitOpFromTransfer = loadBundle()['transitOpFromTransfer'] as (
      dayId: string,
      transfer: Record<string, unknown>,
    ) => Record<string, unknown>
    const first = view.days[0]
    if (first === undefined) throw new Error('fixture is missing its first day')

    const withTransit = {
      ...first,
      transits: [
        {
          id: 't1',
          from: { label: '西安' },
          to: { label: '成都' },
          mode: 'driving',
          distanceMeters: 723_000,
          durationSeconds: 8 * 3600,
          freshness: 'stale',
          stale: false,
          source: 'title',
          steps: [],
        },
      ],
    }

    const facts = dayFacts(withTransit)
    expect(facts['transitCount']).toBe(1)
    expect(facts['transitMeters']).toBe(723_000)
    expect(facts['transitSeconds']).toBe(28_800)
    // 2.1 km of city legs plus the 723 km drive the day is really about.
    expect(facts['distanceMeters']).toBe(723_000 + 2_100)
    expect(facts['driveSeconds']).toBe(28_800 + 1_680)
    // A recorded transit is the record: nothing is missing any more.
    expect(hasUnrecordedTransfer(withTransit)).toBe(false)

    const op = transitOpFromTransfer('d2', {
      origin: '西安',
      destination: '成都',
      fromPlaceId: 'huimin',
      toPlaceId: 'kuanzhai',
      distanceMeters: 723_000,
      source: 'title',
    })
    expect(op['kind']).toBe('set-day-transit')
    expect(op['dayId']).toBe('d2')
    expect(op['transit']).toMatchObject({
      id: 'd2-transit-1',
      // The city names stay what the reader sees; the stops they left from and
      // reached are what the map draws the road between.
      from: { label: '西安', placeId: 'huimin' },
      to: { label: '成都', placeId: 'kuanzhai' },
      distanceMeters: 723_000,
      // Nothing has planned the road yet, so the day says so.
      freshness: 'stale',
    })
  })

  it('marks a transit end that is not a stop, and leaves the covered ones alone', () => {
    const transitEnds = loadBundle()['transitEnds'] as (
      groups: readonly unknown[],
      days: readonly unknown[],
    ) => readonly { readonly role: string; readonly label: string }[]
    const point = (longitude: number, latitude: number) => ({ longitude, latitude, coordinateSystem: 'gcj02' })
    // The stop the day leaves from belongs to the day before: a drive starts
    // where yesterday finished, and that pin is already on the map.
    const groups = [
      { dayId: 'd0', date: '2026-09-30', dayOrder: 1, stops: [{ placeId: 'p1', point: point(120, 30) }] },
      { dayId: 'd1', date: '2026-10-01', dayOrder: 2, stops: [] },
    ]
    const day = (id: string, date: string, transits: readonly unknown[]) => ({
      id,
      date,
      title: id,
      items: [],
      legs: [],
      totalDistanceMeters: 0,
      totalDurationSeconds: 0,
      transits,
      alertIds: [],
    })
    const days = [
      day('d0', '2026-09-30', []),
      day('d1', '2026-10-01', [
        {
          id: 't1',
          // The stop the day leaves from is already drawn, on the day before…
          from: { placeId: 'p1', label: '杭州', point: point(120, 30) },
          // …the far end is only a name the map has not drawn.
          to: { label: '西安', point: point(108.9, 34.2) },
          mode: 'driving',
          freshness: 'fresh',
          stale: false,
          source: 'amap-cli',
          steps: [],
        },
      ]),
    ]

    const ends = transitEnds(groups, days)

    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ role: 'to', label: '西安' })
  })

  it('renders a view from an older host, which has no transits at all', () => {
    const view = makeView()
    const first = view.days[0]
    if (first === undefined) throw new Error('fixture is missing its first day')

    // A page can reload before the Host restarts, so every day field the panel
    // reads has to survive being absent.
    const { transits: _dropped, ...day } = first
    const html = renderPanel({ ...view, days: [day as never] })

    expect(html).toContain('class="trv-day"')
    expect(html).not.toContain('class="trv-transit')
  })

  it('keeps one alert per day, in the day header rather than on every stop', () => {
    const view = makeView()
    const html = renderPanel(view)
    const message = view.alerts[0]?.message ?? ''

    // The Host emits one alert per day whose related ids cover every affected
    // stop, so attaching it to each stop printed the same sentence on each card.
    expect(message).not.toBe('')
    expect(html.split(message).length - 1).toBe(1)
    expect(html).not.toContain('trv-card-alert')
    expect(html).toContain('重算交通')
  })

  it('offers the day/whole-trip switch and the map size control', () => {
    const html = renderPanel(makeView())

    expect(html).toContain('当天')
    expect(html).toContain('全程')
    expect(html).toContain('放大地图')
    expect(html).toContain('trv-map-grip')
  })

  // The AMap container injects its own logo and copyright with high z-indexes.
  // Without a stacking context on the card they paint above the panel's own
  // sheets and overlays, which is exactly what hid the alert list once.
  it('isolates the map card and layers the panel surfaces above it', () => {
    const html = renderPanel(makeView())

    expect(html).toContain('isolation: isolate')
    expect(html).toContain('.trv-overlay { position: absolute; inset: 0; z-index: 20;')
    expect(html).toContain('.trv-menu { position: absolute; top: 40px; right: 10px; z-index: 12;')
  })

  // The button label is 「让 Agent 」+ the action, so the action itself must not
  // already carry that prefix (it once rendered 「让 Agent 让 Agent 精简这一天」).
  it('keeps every alert action a bare verb phrase', () => {
    const info = loadBundle()['ALERT_INFO'] as Record<string, { readonly clear: string; readonly label: string; readonly what: string }>

    expect(Object.keys(info).length).toBeGreaterThan(8)
    for (const [code, entry] of Object.entries(info)) {
      expect(entry.clear.startsWith('让 Agent'), code).toBe(false)
      expect(entry.clear.length, code).toBeGreaterThan(0)
      expect(entry.what.length, code).toBeGreaterThan(0)
      expect(entry.label.length, code).toBeGreaterThan(0)
    }
  })

  it('offers a drag handle per stop and fixes the ones that cannot move', () => {
    const html = renderPanel(makeView())

    expect(html).toContain('class="trv-grip"')
    expect(html).toContain('拖动调整顺序')
    // The fixture locks the first stop, so its handle is disabled and says why.
    expect(html).toContain('title="已固定：先取消固定才能拖动"')
    expect(html).toContain('aria-label="已固定，不能拖动"')
    expect(html).toContain('disabled=""')
  })

  it('draws the time rail, the fixed chip and the unit wrapper', () => {
    const html = renderPanel(makeView())

    expect(html).toContain('class="trv-tick-time"')
    expect(html).toContain('09:00')
    expect(html).toContain('class="trv-tick-node"')
    expect(html).toContain('class="trv-unit"')
    expect(html).toContain('data-item-row="d1-i0"')
    // 「锁定」 is an internal term: the row explains it as 「固定」.
    expect(html).toContain('class="trv-fixed"')
    expect(html).not.toContain('>锁定<')
  })

  it('keeps the clock clear of the node that sits beside it', () => {
    const styles = (loadBundle()['STYLES'] as string).replace(/\n\s*/g, ' ')
    const timeline = /\.trv-timeline \{[^}]*\}/.exec(styles)?.[0] ?? ''
    const time = /\.trv-tick-time \{[^}]*\}/.exec(styles)?.[0] ?? ''
    const nodeX = Number(/--trv-node-x: (\d+)px/.exec(timeline)?.[1] ?? '0')
    const railW = Number(/--trv-rail-w: (\d+)px/.exec(timeline)?.[1] ?? '0')
    const inset = Number(/padding: \d+px (\d+)px 0 0/.exec(time)?.[1] ?? '0')

    // The node is 9px wide with a 3px halo, so it reaches 7.5px left of its
    // centre; the digits stop at the padding edge. A 12px inset put the halo on
    // top of the last digit, which read as the dot eating the clock.
    const nodeLeft = nodeX - 4.5
    const inkRight = railW - inset
    expect(nodeLeft - inkRight).toBeGreaterThanOrEqual(4)
  })

  it('tones each stop by its category and shows its photo when there is one', () => {
    const view = makeView()
    const withPhoto = {
      ...view,
      days: view.days.map((day) => ({
        ...day,
        items: day.items.map((entry) => ({ ...entry, photoUrl: 'http://cdn.example/photo.jpg' })),
      })),
    }
    const html = renderPanel(withPhoto)

    expect(html).toContain('--trv-tone:var(--dsw-alias-brand-primary)')
    expect(html).toContain('class="trv-thumb"')
    expect(html).toContain('http://cdn.example/photo.jpg')
  })

  it('offers a photo backfill in the place library only while photos are missing', () => {
    const Places = loadBundle()['PlacesList'] as (props: unknown) => unknown
    const render = (view: TravelView, busy: boolean): string =>
      renderToStaticMarkup(
        react.createElement(Places as never, {
          view,
          selectedPlaceId: undefined,
          select: () => undefined,
          busy,
          refresh: () => undefined,
        }) as never,
      )
    const view = makeView()

    expect(render(view, false)).toContain('还有 1 个地点没有照片')
    expect(render(view, false)).toContain('补全照片')
    // While the lookup runs the button reports it and cannot be pressed again.
    const running = render(view, true)
    expect(running).toContain('补全中…')
    expect(running).toContain('disabled=""')
    // Once every place has a photo the offer disappears and the wall shows.
    const full = { ...view, places: view.places.map((place) => ({ ...place, photoUrl: 'http://cdn.example/p.jpg' })) }
    expect(render(full, false)).not.toContain('补全照片')
    expect(render(full, false)).toContain('class="trv-wall"')
  })

  it('styles every class the panel actually renders', () => {
    const html = renderPanel(makeView())
    const styles = loadBundle()['STYLES'] as string
    const classes = new Set(
      [...html.matchAll(/class="([^"]+)"/g)].flatMap((match) => (match[1] ?? '').split(/\s+/)).filter((name) => name !== ''),
    )

    expect(classes.size).toBeGreaterThan(10)
    for (const name of classes) {
      expect(styles, name).toContain(`.${name}`)
    }
    // The previous timeline markup is gone; its rules must not linger either.
    expect(styles).not.toContain('.trv-item ')
    expect(styles).not.toContain('.trv-drop-line')
    expect(styles).not.toContain('.trv-rail-time')
  })

  it('docks the detail panel with a resize grip and no 固定 lecture', () => {
    const Places = loadBundle()['PlaceSheet'] as (props: unknown) => unknown
    const view = makeView()
    const html = renderToStaticMarkup(
      react.createElement(Places as never, {
        view,
        day: view.days[0],
        placeId: 'kiyomizu',
        itemId: 'd1-i0',
        busy: false,
        amapReady: true,
        mutate: async () => undefined,
        refreshPhoto: async () => ({ checked: 1, updated: 0, needsStart: false }),
        close: () => undefined,
      }) as never,
    )

    expect(html).toContain('class="trv-detail"')
    // Three handles: one edge per axis plus a corner that drives both, because
    // a single edge grip can only ever resize one direction.
    expect(html).toContain('class="trv-detail-grip trv-detail-grip-top"')
    expect(html).toContain('class="trv-detail-grip trv-detail-grip-side"')
    expect(html).toContain('class="trv-detail-grip trv-detail-grip-corner"')
    expect(html).toContain('拖动调整详情大小（对角）')
    // Neither axis is pinned until the user drags it, so the window still hugs
    // its content by default.
    expect(html).not.toContain('--trv-detail-w')
    expect(html).not.toContain('--trv-detail-h')
    // The place has no photo, so the panel offers to look one up…
    expect(html).toContain('正在向高德补全照片…')
    // …and explains 固定 through the button tooltip instead of a paragraph.
    // The fixture's first stop is fixed, so the tooltip offers the way out.
    expect(html).toContain('取消固定后，Agent 与自动重排就可以调整这一站')
    expect(html).not.toContain('固定＝钉住这一站')
  })

  it('shows the stop photo instead of the placeholder once there is one', () => {
    const Places = loadBundle()['PlaceSheet'] as (props: unknown) => unknown
    const view = makeView()
    const withPhoto = {
      ...view,
      days: view.days.map((day) => ({
        ...day,
        items: day.items.map((entry) => ({ ...entry, photoUrl: 'http://cdn.example/photo.jpg' })),
      })),
    }
    const html = renderToStaticMarkup(
      react.createElement(Places as never, {
        view: withPhoto,
        day: withPhoto.days[0],
        placeId: 'kiyomizu',
        itemId: 'd1-i0',
        busy: false,
        amapReady: true,
        mutate: async () => undefined,
        refreshPhoto: async () => ({ checked: 0, updated: 0, needsStart: false }),
        close: () => undefined,
      }) as never,
    )

    expect(html).toContain('class="trv-banner"')
    expect(html).toContain('http://cdn.example/photo.jpg')
    expect(html).not.toContain('trv-photo-empty')
  })

  it('offers the bulk photo backfill in the header meta row', () => {
    const html = renderPanel(makeView())

    expect(html).toContain('缺 1 张照片 · 补全')
    // With only the CLI available and the container down, the same offer says
    // what pressing it will do first.
    const cliView = { ...makeView(), photoLookup: 'container' as const }
    expect(renderPanel(cliView, { amapReady: false })).toContain('缺 1 张照片 · 启动高德并补全')
    // A Web-service lookup needs no container, so the offer stays plain.
    expect(renderPanel(makeView(), { amapReady: false })).toContain('缺 1 张照片 · 补全')
  })

  it('never opens the AMap window on its own: a cold container is offered instead', () => {
    const Places = loadBundle()['PlaceSheet'] as (props: unknown) => unknown
    // Only the CLI can answer, so the container state decides what happens.
    const view = { ...makeView(), photoLookup: 'container' as const }
    const render = (amapReady: boolean): string =>
      renderToStaticMarkup(
        react.createElement(Places as never, {
          view,
          day: view.days[0],
          placeId: 'kiyomizu',
          itemId: 'd1-i0',
          busy: false,
          amapReady,
          mutate: async () => undefined,
          refreshPhoto: async () => ({ checked: 0, updated: 0, needsStart: false }),
          close: () => undefined,
        }) as never,
      )

    // Container up: the lookup runs by itself, so the card shows progress.
    const ready = render(true)
    expect(ready).toContain('正在向高德补全照片…')
    expect(ready).not.toContain('启动高德并补全')

    // Container down: nothing is requested until the button is pressed, and the
    // button says what pressing it does.
    const cold = render(false)
    expect(cold).toContain('高德地图容器未运行')
    expect(cold).toContain('启动高德并补全')
    expect(cold).not.toContain('正在向高德补全照片…')
  })

  it('looks a photo up immediately when the Web-service API can answer', () => {
    const Places = loadBundle()['PlaceSheet'] as (props: unknown) => unknown
    const view = { ...makeView(), photoLookup: 'direct' as const }
    const html = renderToStaticMarkup(
      react.createElement(Places as never, {
        view,
        day: view.days[0],
        placeId: 'kiyomizu',
        itemId: 'd1-i0',
        busy: false,
        // No AMap container is running: a direct lookup needs none.
        amapReady: false,
        mutate: async () => undefined,
        refreshPhoto: async () => ({ checked: 1, updated: 1, needsStart: false }),
        close: () => undefined,
      }) as never,
    )

    expect(html).toContain('正在向高德补全照片…')
    expect(html).not.toContain('启动高德并补全')
    expect(html).not.toContain('高德地图容器未运行')
  })

  it('keeps the timeline free of per-row move buttons', () => {
    const html = renderPanel(makeView())

    // Reordering is a drag (or ⌥↑/⌥↓), so the old up/down buttons are gone.
    expect(html).not.toContain('>上移<')
    expect(html).not.toContain('>下移<')
    // The handle's tooltip is where the keyboard alternative is advertised.
    expect(html).toContain('⌥↑/⌥↓')
  })

  it('groups the whole trip by day and skips days without coordinates', () => {
    const view = makeView()
    const buildGroups = loadBundle()['buildGroups'] as (
      days: unknown,
      day: unknown,
      range: string,
    ) => readonly { readonly dayId: string; readonly dayOrder: number; readonly stops: readonly unknown[] }[]

    const single = buildGroups(view.days, view.days[0], 'day')
    expect(single).toHaveLength(1)
    expect(single[0]?.dayId).toBe('d1')

    // D2 has no located stop in the fixture, so the whole-trip view skips it
    // rather than drawing an empty line.
    const withoutD2 = buildGroups(view.days, view.days[0], 'all')
    expect(withoutD2.map((group) => group.dayId)).toEqual(['d1'])

    // Give the empty D2 one located stop and it joins the whole-trip view, after D1.
    const stop = { ...(view.days[0]?.items[0] ?? {}), id: 'd2-i1', placeId: 'p-d2', name: '市场', point: { longitude: 116.41, latitude: 39.88, coordinateSystem: 'gcj02' } }
    const located = view.days.map((day) => (day.id === 'd2' ? { ...day, items: [stop] } : day))
    const whole = buildGroups(located, located[0], 'all')
    expect(whole.map((group) => group.dayId)).toEqual(['d1', 'd2'])
    expect(whole.map((group) => group.dayOrder)).toEqual([1, 2])
    expect(whole[0]?.stops).toHaveLength(2)
  })

  it('draws the coordinate schematic when the host disabled the browser map', () => {
    const html = renderPanel(makeView())

    expect(html).toContain('trv-map')
    expect(html).toContain('点位为真实坐标')
    // The stylesheet is inlined, so the check is on the element, not the class name.
    expect(html).not.toContain('class="trv-amap"')
  })

  it('never reaches for the slot tab-information hook', () => {
    const registered = captureRegistrations().body as unknown as (props: unknown) => unknown
    // Rendering the body with only a sessionId must not throw: no hook is
    // supplied here, which is exactly the failure this guards against.
    const html = renderToStaticMarkup(
      react.createElement(registered as never, { sessionId: 'session-1' } as never) as never,
    )
    expect(html).toContain('trv-shell')
    expect(html).toContain('trv-skeleton')
  })

  it('renders an empty state when no trip exists', () => {
    const html = renderPanel({ trips: [], headline: null, days: [], places: [], alerts: [], map: { enabled: false, version: '2.0', style: 'normal' }, photos: true, photoLookup: 'direct' })

    expect(html).toContain('还没有旅行项目')
  })

  it('never renders a live host object into markup', () => {
    const html = renderPanel(makeView())

    expect(html).not.toContain('[object Object]')
  })

  it('keeps the registered definition stable across repeated loads', () => {
    const first = captureRegistrations()
    const second = captureRegistrations()

    expect(JSON.stringify(first.tabDefinition)).toBe(JSON.stringify(second.tabDefinition))
    expect(first.effectLabels).toEqual(second.effectLabels)
  })

  // 赶路日在地图上必须有路可画，而且一眼看得出是「已经规划过的路」还是「只有标题
  // 的估算」。下面几组用例沿着 driveRoutes 的三级降级逐级验证。
  it('derives one road per day from a transit, a long leg or a title alone', () => {
    const driveRoutes = loadBundle()['driveRoutes'] as (days: readonly unknown[]) => readonly {
      readonly id: string
      readonly dayId: string
      readonly colorIndex: number
      readonly path: readonly (readonly [number, number])[]
      readonly meters?: number
      readonly seconds?: number
      readonly kind: string
      readonly label: string
    }[]
    const point = (longitude: number, latitude: number) => ({
      longitude,
      latitude,
      coordinateSystem: 'gcj02',
    })
    const stop = (id: string, placeId: string, longitude: number, latitude: number): Record<string, unknown> => ({
      id,
      placeId,
      name: id,
      category: '风景名胜',
      address: '地址',
      point: point(longitude, latitude),
      locked: false,
      notes: [],
      alertIds: [],
    })
    // 旧宿主没有 transits 字段，所以这里默认就不写它：缺字段的日子照样要能算。
    const day = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({
      id,
      date: '2026-10-01',
      title: id,
      items: [],
      legs: [],
      totalDistanceMeters: 0,
      totalDurationSeconds: 0,
      alertIds: [],
      ...extra,
    })

    // ① 有转场：用转场的真实路径与数字，标题里的估算让位。
    const transit = day('d2', {
      title: '西安 → 成都｜翻秦岭 723km',
      transits: [
        {
          id: 'd2-transit-1',
          from: { label: '西安', point: point(108.9, 34.2) },
          to: { label: '成都', point: point(104.1, 30.7) },
          mode: 'driving',
          distanceMeters: 723_000,
          durationSeconds: 29_520,
          freshness: 'fresh',
          stale: false,
          source: 'amap-rest',
          polyline: '108.9,34.2;106.4,32.4;104.1,30.7',
          steps: [],
        },
      ],
    })
    const planned = driveRoutes([transit])

    expect(planned).toHaveLength(1)
    expect(planned[0]).toMatchObject({ dayId: 'd2', colorIndex: 0, kind: 'planned', meters: 723_000, seconds: 29_520 })
    expect(planned[0]?.path).toEqual([
      [108.9, 34.2],
      [106.4, 32.4],
      [104.1, 30.7],
    ])
    expect(planned[0]?.label).toBe('驾车 · 723 km · 8 小时 12 分')

    // 没有 polyline 时两端直连，仍然是「已规划」；也没有时长可写时不编一个。
    const straight = driveRoutes([
      day('d2', {
        transits: [
          {
            id: 't1',
            from: { label: '西安', point: point(108.9, 34.2) },
            to: { label: '成都', point: point(104.1, 30.7) },
            mode: 'driving',
            freshness: 'fresh',
            stale: false,
            source: 'amap-cli',
            steps: [],
          },
        ],
      }),
    ])
    expect(straight[0]?.path).toEqual([
      [108.9, 34.2],
      [104.1, 30.7],
    ])
    expect(straight[0]?.kind).toBe('planned')
    expect(straight[0]?.label).toBe('驾车')

    // ② 没有转场，但一整天就是一段长途 leg：两端站点就是这条路，数字取 leg 的。
    const longLeg = day('d1', {
      title: '北京 → 西安｜赶路 1077km',
      items: [stop('a', 'pa', 116.4, 39.9), stop('b', 'pb', 108.9, 34.2)],
      legs: [
        {
          id: 'l1',
          fromItemId: 'a',
          toItemId: 'b',
          mode: 'driving',
          distanceMeters: 1_077_000,
          durationSeconds: 45_480,
          freshness: 'fresh',
          stale: false,
          steps: [],
        },
      ],
    })
    const road = driveRoutes([longLeg])

    expect(road).toHaveLength(1)
    expect(road[0]).toMatchObject({ kind: 'planned', meters: 1_077_000, seconds: 45_480 })
    expect(road[0]?.path).toEqual([
      [116.4, 39.9],
      [108.9, 34.2],
    ])
    expect(road[0]?.label).toBe('驾车 · 1077 km · 12 小时 38 分')

    // 同一段长途只占当天移动时间的两成时，这一天还是市内游玩，不是赶路日。
    expect(
      driveRoutes([
        day('d1', {
          legs: [
            { id: 'l1', fromItemId: 'a', toItemId: 'b', mode: 'driving', distanceMeters: 200_000, durationSeconds: 7_200, freshness: 'fresh', stale: false, steps: [] },
            { id: 'l2', fromItemId: 'b', toItemId: 'c', mode: 'walking', distanceMeters: 5_000, durationSeconds: 28_800, freshness: 'fresh', stale: false, steps: [] },
          ],
        }),
      ]),
    ).toEqual([])

    // ③ 只剩标题：坐标借相邻两天的站点（前一天最后一站 → 后一天第一站），标签带 ≈。
    const before = day('d1', { items: [stop('a', 'pa', 116.4, 39.9)] })
    const onlyTitle = day('d2', { title: '西安 → 成都｜翻秦岭 723km' })
    const after = day('d3', { items: [stop('b', 'pb', 104.1, 30.7)] })
    const estimated = driveRoutes([before, onlyTitle, after])

    expect(estimated).toHaveLength(1)
    expect(estimated[0]).toMatchObject({ dayId: 'd2', colorIndex: 1, kind: 'estimated', meters: 723_000 })
    expect(estimated[0]?.seconds).toBeUndefined()
    expect(estimated[0]?.path).toEqual([
      [116.4, 39.9],
      [104.1, 30.7],
    ])
    expect(estimated[0]?.label).toBe('驾车 · ≈723 km · 按标题估算')

    // ④ 什么都说不出的一天：不凭空编一条路，也不因为缺字段而崩。
    expect(driveRoutes([before])).toEqual([])
    expect(driveRoutes([day('d9', { title: '丽江｜拍照', items: [stop('a', 'pa', 100.2, 25.1)] })])).toEqual([])
  })

  it('draws a driving day that has no located stop of its own', () => {
    const buildGroups = loadBundle()['buildGroups'] as (
      days: readonly unknown[],
      day: unknown,
      range: string,
    ) => readonly { readonly dayId: string; readonly dayOrder: number; readonly stops: readonly unknown[] }[]
    const TripMap = loadBundle()['TripMap'] as (props: unknown) => unknown
    const view = makeView()
    const first = view.days[0]
    const second = view.days[1]
    if (first === undefined || second === undefined) throw new Error('fixture is missing its days')
    const point = (longitude: number, latitude: number) => ({ longitude, latitude, coordinateSystem: 'gcj02' })
    const stop = (id: string, placeId: string, name: string, longitude: number, latitude: number) => ({
      id,
      placeId,
      name,
      category: '风景名胜',
      address: '地址',
      point: point(longitude, latitude),
      locked: false,
      notes: [],
      alertIds: [],
    })
    // D1 游玩、D2 只有标题（整天在路上、一个站点都没有）、D3 到达丽江。
    const days = [
      { ...first, items: [stop('d1-i0', 'p1', '清水寺', 116.4, 39.9), stop('d1-i1', 'p2', '银阁寺', 117.1, 39.2)] },
      { ...second, title: '西安 → 成都｜翻秦岭 723km', items: [], transits: [] },
      { ...second, id: 'd3', date: '2026-10-04', title: '成都 → 丽江｜到站 821km', items: [stop('d3-i0', 'p3', '丽江古城', 100.2, 26.9)] },
    ]

    const whole = buildGroups(days, days[0], 'all')
    expect(whole.map((group) => group.dayId)).toEqual(['d1', 'd2', 'd3'])
    // 它没有站点，但有一条路：这正是过去被整组跳过的那个「整天赶路」的日子。
    expect(whole[1]?.stops).toEqual([])

    const single = buildGroups(days, days[1], 'day')
    expect(single.map((group) => group.dayId)).toEqual(['d2'])

    // 当天模式打开这个赶路日：示意图不再回答「这一天还没有带坐标的地点」。
    const html = renderToStaticMarkup(
      react.createElement(TripMap as never, {
        map: { enabled: false, version: '2.0', style: 'normal' },
        days,
        day: days[1],
        range: 'day',
        tier: 'comfortable',
        activeDayId: 'd2',
        selectedPlaceId: undefined,
        onRange: () => undefined,
        onTier: () => undefined,
        onSelect: () => undefined,
      }) as never,
    )
    expect(html).not.toContain('trv-map-empty')
    expect(html).toContain('class="trv-line trv-drive-line trv-drive-line-estimated"')
  })

  it('separates a planned road from a title-only estimate, with a capsule on each', () => {
    const TripMap = loadBundle()['TripMap'] as (props: unknown) => unknown
    const view = makeView()
    const first = view.days[0]
    const second = view.days[1]
    if (first === undefined || second === undefined) throw new Error('fixture is missing its days')
    const point = (longitude: number, latitude: number) => ({ longitude, latitude, coordinateSystem: 'gcj02' })
    const stop = (id: string, placeId: string, name: string, longitude: number, latitude: number) => ({
      id,
      placeId,
      name,
      category: '风景名胜',
      address: '地址',
      point: point(longitude, latitude),
      locked: false,
      notes: [],
      alertIds: [],
    })
    const days = [
      { ...first, items: [stop('d1-i0', 'p1', '清水寺', 116.4, 39.9), stop('d1-i1', 'p2', '银阁寺', 117.1, 39.2)] },
      // 只有标题：这一天的线只能是长虚线。
      { ...second, title: '西安 → 成都｜翻秦岭 723km', items: [], transits: [] },
      {
        ...second,
        id: 'd3',
        date: '2026-10-04',
        title: '成都 → 丽江｜到站 821km',
        items: [stop('d3-i0', 'p3', '丽江古城', 100.2, 26.9)],
        // 有转场：这一天的线是已经规划过的实线。
        transits: [
          {
            id: 'd3-transit-1',
            from: { label: '成都', point: point(104.1, 30.7) },
            to: { label: '丽江', point: point(100.2, 26.9) },
            mode: 'driving',
            distanceMeters: 821_000,
            durationSeconds: 40_800,
            freshness: 'fresh',
            stale: false,
            source: 'amap-rest',
            steps: [],
          },
        ],
      },
    ]

    const html = renderToStaticMarkup(
      react.createElement(TripMap as never, {
        map: { enabled: false, version: '2.0', style: 'normal' },
        days,
        day: days[0],
        range: 'all',
        tier: 'comfortable',
        activeDayId: 'd2',
        selectedPlaceId: undefined,
        onRange: () => undefined,
        onTier: () => undefined,
        onSelect: () => undefined,
      }) as never,
    )

    // 站点顺序还是那条细虚线，路线各用各的 class：实线一条、长虚线一条。
    expect(html).toContain('class="trv-line"')
    expect((html.match(/class="trv-line trv-drive-line"/g) ?? [])).toHaveLength(1)
    expect((html.match(/class="trv-line trv-drive-line trv-drive-line-estimated"/g) ?? [])).toHaveLength(1)
    // 胶囊压在路的中点上，估算的那条把「这是标题里的数字」写在脸上。
    expect((html.match(/class="trv-drive-label"/g) ?? [])).toHaveLength(2)
    expect(html).toContain('驾车 · 821 km · 11 小时 20 分')
    expect(html).toContain('驾车 · ≈723 km · 按标题估算')
    // 图例说明两种线型，全程模式也带着。
    expect(html).toContain('实线=已规划路线 · 长虚线=按标题估算')
  })

  it('offers one click for the days that only state their hop', () => {
    const fillReport = loadBundle()['fillReport'] as (planned: number, skipped: number) => string
    const view = makeView()
    const first = view.days[0]
    const second = view.days[1]
    if (first === undefined || second === undefined) throw new Error('fixture is missing its days')
    const withHop = { ...view, days: [first, { ...second, title: '京都 → 奈良｜45km' }] }
    const fill = async (): Promise<{ readonly planned: number; readonly skipped: number }> => ({ planned: 1, skipped: 0 })

    // 元素本身，不是内联样式表里的那条规则 —— 样式表里同样有这个名字。
    const html = renderPanel(withHop, { onFillTransits: fill })
    expect(html).toContain('class="trv-map-fill"')
    expect(html).toContain('补全 1 天路线')

    // 没有「只有标题」的日子，就没有入口。
    expect(renderPanel(makeView(), { onFillTransits: fill })).not.toContain('class="trv-map-fill"')
    // 老宿主没有这条路由时同样不给按钮：点不出结果的按钮比没有按钮更糟。
    expect(renderPanel(withHop)).not.toContain('class="trv-map-fill"')

    // 结果要说清楚补上了几天、又跳过了几天。
    expect(fillReport(2, 0)).toBe('已补全 2 天路线。')
    expect(fillReport(2, 1)).toBe('已补全 2 天路线，跳过 1 天。')
    expect(fillReport(0, 3)).toBe('没有补全任何路线，跳过 3 天。')
    expect(fillReport(0, 0)).toBe('没有需要补全的路线。')
  })

  // 真实行程（14 天）里「丽江 → 大理 175km」那天后面还跟着 13km 的市内挪窝：175km 占
  // 里程 93%，却只占移动时长 77%，只按时间判就会把这条 175km 的路整条漏掉。
  it('draws the long hop of a day that also carries short city legs', () => {
    const driveRoutes = loadBundle()['driveRoutes'] as (days: readonly unknown[]) => readonly {
      readonly dayId: string
      readonly kind: string
      readonly meters?: number
      readonly seconds?: number
      readonly label: string
      readonly path: readonly (readonly [number, number])[]
    }[]
    const point = (longitude: number, latitude: number) => ({ longitude, latitude, coordinateSystem: 'gcj02' })
    const stop = (id: string, placeId: string, name: string, longitude: number, latitude: number) => ({
      id,
      placeId,
      name,
      category: '风景名胜',
      address: '地址',
      point: point(longitude, latitude),
      locked: false,
      notes: [],
      alertIds: [],
    })
    const leg = (id: string, fromItemId: string, toItemId: string, distanceMeters: number, durationSeconds: number) => ({
      id,
      fromItemId,
      toItemId,
      mode: 'driving',
      distanceMeters,
      durationSeconds,
      freshness: 'fresh',
      stale: false,
      steps: [],
    })
    const day = (id: string, title: string, items: readonly unknown[], legs: readonly unknown[]) => ({
      id,
      date: '2026-10-01',
      title,
      items,
      legs,
      totalDistanceMeters: 0,
      totalDurationSeconds: 0,
      alertIds: [],
    })

    // 丽江 → 大理：175.1 km / 153 min，加上洱海边 7 km、6 km 两段。
    const moving = day(
      'd5',
      '丽江 → 大理｜175km，洱海第一晚',
      [
        stop('d5-i1', 'p1', '丽江古城', 100.24, 26.87),
        stop('d5-i2', 'p2', '洱海公园', 100.25, 25.6),
        stop('d5-i3', 'p3', '洱海', 100.19, 25.79),
        stop('d5-i4', 'p4', '洱海公园', 100.25, 25.6),
      ],
      [
        leg('l1', 'd5-i1', 'd5-i2', 175_100, 9_180),
        leg('l2', 'd5-i2', 'd5-i3', 7_000, 1_380),
        leg('l3', 'd5-i3', 'd5-i4', 6_000, 1_320),
      ],
    )
    const routes = driveRoutes([moving])

    expect(routes).toHaveLength(1)
    // 它是「已经算过的路」，不是「按标题估算」：数字来自那段 leg。
    expect(routes[0]).toMatchObject({ dayId: 'd5', kind: 'planned', meters: 175_100, seconds: 9_180 })
    expect(routes[0]?.label).toBe('驾车 · 175.1 km · 2 小时 33 分')
    expect(routes[0]?.path).toEqual([
      [100.24, 26.87],
      [100.25, 25.6],
    ])

    // 一整天只在洱海边挪窝（6 km + 7 km）：没有 100 km 的路，就没有路线。
    expect(
      driveRoutes([
        day(
          'd6',
          '大理｜洱海完整一天',
          [stop('a', 'pa', 'A', 100.1, 25.7), stop('b', 'pb', 'B', 100.2, 25.8)],
          [leg('l1', 'a', 'b', 7_000, 1_380), leg('l2', 'b', 'a', 6_000, 1_320)],
        ),
      ]),
    ).toEqual([])

    // 一段 200 km 的路，但当天还爬了 120 km／200 min 的山：里程占 62%、时间占 9%，
    // 两个口径都说不上「主导」，这一天仍然不是赶路日。
    expect(
      driveRoutes([
        day(
          'd9',
          '某天',
          [stop('a', 'pa', 'A', 100.1, 25.7), stop('b', 'pb', 'B', 103.1, 26.7)],
          [leg('l1', 'a', 'b', 200_000, 1_200), leg('l2', 'b', 'a', 120_000, 12_000)],
        ),
      ]),
    ).toEqual([])
  })

  // 只有标题的赶路日落在行程首尾时，没有「相邻两天」可以借端点：过去这种日子在图上
  // 是空的，面板于是回答「这一天还没有带坐标的地点」。
  it('draws a title-only drive day at either end of the trip', () => {
    const driveRoutes = loadBundle()['driveRoutes'] as (days: readonly unknown[]) => readonly {
      readonly dayId: string
      readonly kind: string
      readonly label: string
      readonly path: readonly (readonly [number, number])[]
    }[]
    const buildGroups = loadBundle()['buildGroups'] as (
      days: readonly unknown[],
      day: unknown,
      range: string,
    ) => readonly { readonly dayId: string }[]
    const TripMap = loadBundle()['TripMap'] as (props: unknown) => unknown
    const point = (longitude: number, latitude: number) => ({ longitude, latitude, coordinateSystem: 'gcj02' })
    const stop = (id: string, placeId: string, name: string, longitude: number, latitude: number) => ({
      id,
      placeId,
      name,
      category: '风景名胜',
      address: '地址',
      point: point(longitude, latitude),
      locked: false,
      notes: [],
      alertIds: [],
    })
    const day = (id: string, date: string, title: string, items: readonly unknown[]) => ({
      id,
      date,
      title,
      items,
      legs: [],
      totalDistanceMeters: 0,
      totalDurationSeconds: 0,
      alertIds: [],
    })

    // 末位：最后一天整天在赶路、一个站点都没有；标题里的两个地名与行程里两个站点同名。
    const endingWithDrive = [
      day('d1', '2026-10-01', '丽江｜婚纱照', [stop('d1-i1', 'p1', '丽江古城', 100.23, 26.87)]),
      day('d2', '2026-10-02', '大理｜洱海一天', [stop('d2-i1', 'p2', '大理古城', 100.16, 25.69)]),
      day('d3', '2026-10-03', '丽江古城 → 昆明南站｜还车赶飞机 340km', []),
    ]
    const last = driveRoutes(endingWithDrive)

    expect(last).toHaveLength(1)
    expect(last[0]).toMatchObject({ dayId: 'd3', kind: 'estimated' })
    expect(last[0]?.label).toBe('驾车 · ≈340 km · 按标题估算')
    // from 用与标题同名的那个站点（丽江古城），to 借不到后面的站点时退回行程里最后一个
    // 有坐标的站点（大理古城）—— 两端都说得出来，这条线就画得出来。
    expect(last[0]?.path).toEqual([
      [100.23, 26.87],
      [100.16, 25.69],
    ])
    // 它不再被绘制集合跳过，当天模式打开也能画。
    expect(buildGroups(endingWithDrive, endingWithDrive[2], 'all').map((group) => group.dayId)).toEqual(['d1', 'd2', 'd3'])
    expect(buildGroups(endingWithDrive, endingWithDrive[2], 'day').map((group) => group.dayId)).toEqual(['d3'])

    const single = renderToStaticMarkup(
      react.createElement(TripMap as never, {
        map: { enabled: false, version: '2.0', style: 'normal' },
        days: endingWithDrive,
        day: endingWithDrive[2],
        range: 'day',
        tier: 'comfortable',
        activeDayId: 'd3',
        selectedPlaceId: undefined,
        onRange: () => undefined,
        onTier: () => undefined,
        onSelect: () => undefined,
      }) as never,
    )
    expect(single).not.toContain('trv-map-empty')
    expect(single).toContain('class="trv-line trv-drive-line trv-drive-line-estimated"')

    // 两天两站、末位那天只有标题：借不到「后面第一个站点」，就退回整个行程最后一个有
    // 坐标的站点（洱海公园），它和出发点不同，于是仍然有一条估算线。
    const twoDays = [
      day('d1', '2026-10-01', '大理｜洱海一天', [
        stop('d1-i1', 'p1', '大理古城', 100.16, 25.69),
        stop('d1-i2', 'p2', '洱海公园', 100.25, 25.6),
      ]),
      day('d2', '2026-10-02', '大理 → 昆明｜赶飞机 340km', []),
    ]
    const two = driveRoutes(twoDays)
    expect(two).toHaveLength(1)
    expect(two[0]?.path).toEqual([
      [100.25, 25.6],
      [100.16, 25.69],
    ])

    // 首位：第一天空着，端点只能向后借。
    const startingWithDrive = [
      day('d1', '2026-10-01', '丽江 → 大理｜175km', []),
      day('d2', '2026-10-02', '大理｜洱海一天', [stop('d2-i1', 'p1', '大理古城', 100.16, 25.69)]),
      day('d3', '2026-10-03', '双廊｜拍照', [stop('d3-i1', 'p2', '双廊古镇', 100.18, 25.86)]),
    ]
    const first = driveRoutes(startingWithDrive)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ dayId: 'd1', kind: 'estimated' })
    expect(first[0]?.path).toEqual([
      [100.16, 25.69],
      [100.18, 25.86],
    ])

    // 整个行程只有一个有坐标的点：首尾只能重合，那种「线」不该画。
    expect(
      driveRoutes([
        day('d1', '2026-10-01', '大理｜洱海一天', [stop('d1-i1', 'p1', '大理古城', 100.16, 25.69)]),
        day('d2', '2026-10-02', '大理 → 昆明｜赶飞机 340km', []),
      ]),
    ).toEqual([])
  })

  // 给一条已有转场补上真实 polyline（「用高德重算」或「补全 N 天路线」之后）不会改变
  // 站点数，也不会改变未被覆盖的端点数：只有把路线自己也放进 key，地图才会重新 fit。
  it('refits when a road is replanned under the same stops', () => {
    const fitKeyOf = loadBundle()['fitKeyOf'] as (
      range: string,
      groups: readonly unknown[],
      days: readonly unknown[],
      box: string,
    ) => string
    const buildGroups = loadBundle()['buildGroups'] as (days: readonly unknown[], day: unknown, range: string) => readonly unknown[]
    const point = (longitude: number, latitude: number) => ({ longitude, latitude, coordinateSystem: 'gcj02' })
    const stop = (id: string, placeId: string, name: string, longitude: number, latitude: number) => ({
      id,
      placeId,
      name,
      category: '风景名胜',
      address: '地址',
      point: point(longitude, latitude),
      locked: false,
      notes: [],
      alertIds: [],
    })
    const transit = (polyline?: string) => ({
      id: 'd1-transit-1',
      // 两端就是当天的两个站点，所以端点数不会因为这条路而改变。
      from: { label: 'A', point: point(116.4, 39.9) },
      to: { label: 'B', point: point(108.9, 34.2) },
      mode: 'driving',
      distanceMeters: 1_077_000,
      durationSeconds: 45_480,
      freshness: 'stale',
      stale: true,
      source: 'title',
      steps: [],
      ...polyline === undefined ? {} : { polyline },
    })
    const days = (polyline?: string) => [
      {
        id: 'd1',
        date: '2026-10-01',
        title: '北京 → 西安｜赶路 1077km',
        items: [stop('d1-i1', 'p1', 'A', 116.4, 39.9), stop('d1-i2', 'p2', 'B', 108.9, 34.2)],
        legs: [],
        totalDistanceMeters: 0,
        totalDurationSeconds: 0,
        transits: [transit(polyline)],
        alertIds: [],
      },
    ]

    const straight = days(undefined)
    const routed = days('116.4,39.9;112,37;108.9,34.2')
    const groups = buildGroups(straight, straight[0], 'all')

    // 同样的绘制集合与画布，重画一次不该重新 fit。
    expect(fitKeyOf('all', groups, days(undefined), '480x648')).toBe(fitKeyOf('all', groups, straight, '480x648'))
    // 站点数一样、路线从两点直连变成三点的真实路径：这是新的画面，必须重新 fit。
    expect(fitKeyOf('all', groups, routed, '480x648')).not.toBe(fitKeyOf('all', groups, straight, '480x648'))
  })

  // 有转场的日子过去画两条完全重叠的线（旧的 trv-transit-line 与新的 trv-drive-line）。
  it('draws one line per transit instead of the old one on top of the new one', () => {
    const TripMap = loadBundle()['TripMap'] as (props: unknown) => unknown
    const point = (longitude: number, latitude: number) => ({ longitude, latitude, coordinateSystem: 'gcj02' })
    const days = [
      {
        id: 'd1',
        date: '2026-10-01',
        title: '西安 → 成都｜翻秦岭 723km',
        items: [
          { id: 'd1-i1', placeId: 'p1', name: '西安', category: '风景名胜', address: '地址', point: point(108.9, 34.2), locked: false, notes: [], alertIds: [] },
          { id: 'd1-i2', placeId: 'p2', name: '成都', category: '风景名胜', address: '地址', point: point(104.1, 30.7), locked: false, notes: [], alertIds: [] },
        ],
        legs: [],
        totalDistanceMeters: 0,
        totalDurationSeconds: 0,
        transits: [
          {
            id: 't1',
            from: { label: '西安', point: point(108.9, 34.2) },
            to: { label: '成都', point: point(104.1, 30.7) },
            mode: 'driving',
            distanceMeters: 723_000,
            durationSeconds: 29_520,
            freshness: 'fresh',
            stale: false,
            source: 'amap-rest',
            polyline: '108.9,34.2;106.4,32.4;104.1,30.7',
            steps: [],
          },
        ],
        alertIds: [],
      },
    ]

    const html = renderToStaticMarkup(
      react.createElement(TripMap as never, {
        map: { enabled: false, version: '2.0', style: 'normal' },
        days,
        day: days[0],
        range: 'all',
        tier: 'comfortable',
        activeDayId: 'd1',
        selectedPlaceId: undefined,
        onRange: () => undefined,
        onTier: () => undefined,
        onSelect: () => undefined,
      }) as never,
    )

    expect((html.match(/class="trv-line trv-drive-line"/g) ?? [])).toHaveLength(1)
    expect(html).not.toContain('trv-transit-line')
    expect((html.match(/class="trv-drive-label"/g) ?? [])).toHaveLength(1)
  })
})
