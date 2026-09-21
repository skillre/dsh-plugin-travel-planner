import { describe, expect, it } from 'vitest'
import type { AmapErrorCode, AmapPoi, AmapRouteData } from '../src/host/amap/cli.js'
import {
  AmapCliError,
  formatPoint,
  parseCliEnvelope,
  parsePoint,
  parseRoute,
  parseSearchPoi,
  parseStatus,
  poiCacheKey,
  routeArgs,
  routeCacheKey,
  searchPoiArgs,
  START_ARGS,
  STATUS_ARGS,
  STOP_ARGS,
} from '../src/host/amap/cli.js'
import {
  normalizeCategories,
  normalizePlace,
  normalizeRouteLeg,
  placeCacheId,
  routeSteps,
} from '../src/host/amap/normalize.js'
import type { GeoPoint } from '../src/domain/trip.js'
import { drivingRouteOverRest, getPoiByIdOverRest, searchPoisOverRest } from '../src/host/amap/rest.js'

const WEST_LAKE: GeoPoint = { longitude: 120.15507, latitude: 30.274084, coordinateSystem: 'gcj02' }

const FETCHED_AT = '2026-09-15T00:00:00.000Z'

/** Wrap a data payload in the CLI's `{success, data, error}` envelope. */
function envelope(data: unknown, error: string | null = null): string {
  return JSON.stringify({ success: true, data, error })
}

/** Assert that a callback throws an {@link AmapCliError} with the expected code. */
function expectAmapErrorCode(callback: () => unknown, code: AmapErrorCode): void {
  let thrown: unknown
  try {
    callback()
  } catch (error) {
    thrown = error
  }
  expect(AmapCliError.isAmapCliError(thrown)).toBe(true)
  if (!AmapCliError.isAmapCliError(thrown)) {
    throw new Error(`expected an AmapCliError but received ${String(thrown)}`)
  }
  expect(thrown.code).toBe(code)
}

/** Build a raw POI fixture with JSON payload values as the CLI reports them. */
function poiPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '星巴克(湖滨银泰店)',
    address: '杭州市上城区延安路258号',
    location: [120.168285, 30.252619],
    tel: '0571-87021234',
    type: '餐饮服务;咖啡厅;星巴克',
    distance: 812,
    id: 'B0FFH3L0YM',
    ...overrides,
  }
}

/** Cast a loose fixture into the raw POI shape for negative tests. */
function asPoi(value: Record<string, unknown>): AmapPoi {
  return value as unknown as AmapPoi
}

/** Cast a loose fixture into the raw route shape for negative tests. */
function asRoute(value: Record<string, unknown>): AmapRouteData {
  return value as unknown as AmapRouteData
}

/** The `state` block of the search fixture, for building malformed variants. */
function searchState(): Record<string, unknown> {
  return SEARCH_PAYLOAD['state'] as Record<string, unknown>
}

/**
 * A `searchPOI` payload in the layout `amap-gui` 0.1.1 emits: the echoed
 * request parameters live under `state`, the results stay at the top level.
 */
const SEARCH_PAYLOAD: Record<string, unknown> = {
  state: {
    keyword: '咖啡',
    city: '杭州',
    center: [120.15507, 30.274084],
    radius: 2000,
    resultCount: 132,
    pageSize: 20,
    pageIndex: 1,
  },
  pois: [poiPayload()],
}

/** The same search as an older CLI echoed it, with the parameters at the top level. */
const SEARCH_PAYLOAD_LEGACY: Record<string, unknown> = {
  keyword: '咖啡',
  city: '杭州',
  center: [120.15507, 30.274084],
  radius: 2000,
  total: 132,
  pageSize: 20,
  pageIndex: 1,
  pois: [poiPayload()],
}

/**
 * Verbatim `amap-gui searchPOI --keyword 天安门 --city 北京 --pageSize 2` output
 * captured on 2026-09-15 against CLI 0.1.1, trimmed to the fields this parser reads.
 */
const SEARCH_PAYLOAD_CAPTURED: Record<string, unknown> = {
  state: {
    keyword: '天安门',
    pageSize: 2,
    pageIndex: 1,
    extensions: 'all',
    resultCount: 100,
    city: '北京',
  },
  pois: [
    {
      id: 'B000A60DA1',
      name: '天安门',
      type: '风景名胜;风景名胜;国家级景点',
      location: [116.397463, 39.909187],
      address: '长安街北侧',
      distance: null,
      tel: '010-65016000',
      pname: '北京市',
      cityname: '北京市',
      adname: '东城区',
      photo: 'http://store.is.autonavi.com/showpic/17a36a737908810a310387c7d53e878a',
    },
    {
      id: 'B000A83C1S',
      name: '天安门广场',
      type: '风景名胜;风景名胜;红色景区|风景名胜;公园广场;城市广场',
      location: [116.397755, 39.903182],
      address: '东长安街',
      distance: null,
      tel: '010-63095745',
      pname: '北京市',
      cityname: '北京市',
      adname: '东城区',
      photo: 'http://aos-cdn-image.amap.com/sns/ugccomment/fab72424-5643-4c14-9486-ae1c8475eab7.jpg',
    },
  ],
  total: 100,
  pageIndex: 1,
  pageSize: 2,
}

/** A `route` payload in the layout `amap-gui` 0.1.1 emits: endpoints under `state`, summary on top. */
const ROUTE_PAYLOAD: Record<string, unknown> = {
  state: {
    from: { name: '天安门', position: [116.397428, 39.90923] },
    to: { name: '雍和宫', position: [116.41765, 39.947407] },
    waypoints: [],
    type: 'driving',
  },
  summary: {
    distance: 8234,
    time: 1560,
    tolls: 0,
    steps: [
      { instruction: '沿东长安街向西行驶', road: '东长安街', distance: 320, time: 60, action: '直行' },
      { instruction: '右转进入南河沿大街', road: '南河沿大街', distance: 0, time: -3, action: '右转' },
    ],
  },
}

/** The same route as an older CLI echoed it, with the endpoints at the top level. */
const ROUTE_PAYLOAD_LEGACY: Record<string, unknown> = {
  type: 'driving',
  from: { name: '天安门', position: [116.397428, 39.90923] },
  to: { name: '雍和宫', position: [116.41765, 39.947407] },
  summary: {
    distance: 8234,
    time: 1560,
    tolls: 0,
    steps: [{ instruction: '沿东长安街向西行驶', distance: 320, time: 60 }],
  },
}

/**
 * Verbatim `amap-gui route --type walking` output captured on 2026-09-15 against
 * CLI 0.1.1, trimmed to the first three steps.
 */
const ROUTE_PAYLOAD_CAPTURED: Record<string, unknown> = {
  state: {
    from: { name: '天安门', position: [116.397463, 39.909187] },
    to: { name: '天安门广场', position: [116.397755, 39.903182] },
    waypoints: [],
    type: 'walking',
  },
  summary: {
    distance: 3113,
    time: 2490,
    steps: [
      { instruction: '向北步行396米右转', road: '', distance: 396, time: 317, action: '右转' },
      { instruction: '沿东华门路向东步行79米左转', road: '东华门路', distance: 79, time: 63, action: '左转' },
      { instruction: '沿东华门路向东北步行539米右转', road: '东华门路', distance: 539, time: 431, action: '右转' },
    ],
  },
}

describe('amap command argv', () => {
  it('exposes the lifecycle argv constants', () => {
    expect(STATUS_ARGS).toEqual(['status'])
    expect(START_ARGS).toEqual(['start'])
    expect(STOP_ARGS).toEqual(['stop'])
  })

  it('builds a keyword-only search argv', () => {
    expect(searchPoiArgs({ keyword: '西湖' })).toEqual(['searchPOI', '--keyword', '西湖'])
  })

  it('builds a nearby search argv in a fixed deterministic order', () => {
    expect(
      searchPoiArgs({
        keyword: '  咖啡  ',
        city: ' 杭州 ',
        center: WEST_LAKE,
        radiusMeters: 2000,
        pageSize: 10,
        pageIndex: 2,
      }),
    ).toEqual([
      'searchPOI',
      '--keyword',
      '咖啡',
      '--city',
      '杭州',
      '--center',
      '120.155070,30.274084',
      '--radius',
      '2000',
      '--pageSize',
      '10',
      '--pageIndex',
      '2',
    ])
  })

  it('allows center and city together and never emits an empty city', () => {
    expect(searchPoiArgs({ keyword: '咖啡', center: WEST_LAKE })).toEqual([
      'searchPOI',
      '--keyword',
      '咖啡',
      '--center',
      '120.155070,30.274084',
    ])
    expect(searchPoiArgs({ keyword: '咖啡', city: '   ' })).toEqual(['searchPOI', '--keyword', '咖啡'])
  })

  it('rejects an empty keyword', () => {
    expectAmapErrorCode(() => searchPoiArgs({ keyword: '   ' }), 'AMAP_COMMAND_FAILED')
  })

  it('rejects out-of-range search numbers', () => {
    expectAmapErrorCode(() => searchPoiArgs({ keyword: 'k', radiusMeters: 0 }), 'AMAP_COMMAND_FAILED')
    expectAmapErrorCode(() => searchPoiArgs({ keyword: 'k', radiusMeters: 50001 }), 'AMAP_COMMAND_FAILED')
    expectAmapErrorCode(() => searchPoiArgs({ keyword: 'k', radiusMeters: 1.5 }), 'AMAP_COMMAND_FAILED')
    expectAmapErrorCode(() => searchPoiArgs({ keyword: 'k', pageSize: 0 }), 'AMAP_COMMAND_FAILED')
    expectAmapErrorCode(() => searchPoiArgs({ keyword: 'k', pageSize: 26 }), 'AMAP_COMMAND_FAILED')
    expectAmapErrorCode(() => searchPoiArgs({ keyword: 'k', pageIndex: 0 }), 'AMAP_COMMAND_FAILED')
  })

  it('accepts the inclusive search number bounds', () => {
    expect(searchPoiArgs({ keyword: 'k', radiusMeters: 1, pageSize: 1, pageIndex: 1 })).toEqual([
      'searchPOI',
      '--keyword',
      'k',
      '--radius',
      '1',
      '--pageSize',
      '1',
      '--pageIndex',
      '1',
    ])
    expect(searchPoiArgs({ keyword: 'k', radiusMeters: 50000, pageSize: 25 })).toEqual([
      'searchPOI',
      '--keyword',
      'k',
      '--radius',
      '50000',
      '--pageSize',
      '25',
    ])
  })

  it('builds a walking route argv', () => {
    expect(routeArgs({ from: '西湖', to: '灵隐寺', mode: 'walking' })).toEqual([
      'route',
      '--from',
      '西湖',
      '--to',
      '灵隐寺',
      '--type',
      'walking',
    ])
  })

  it('builds a driving route argv with names, waypoints, policy and city', () => {
    expect(
      routeArgs({
        from: '116.397428,39.909230',
        to: '116.417650,39.947407',
        mode: 'driving',
        fromName: '天安门',
        toName: '雍和宫',
        waypoints: ['116.400000,39.910000', '116.405000,39.915000'],
        policy: 'fastest',
        city: '北京',
      }),
    ).toEqual([
      'route',
      '--from',
      '116.397428,39.909230',
      '--from-name',
      '天安门',
      '--to',
      '116.417650,39.947407',
      '--to-name',
      '雍和宫',
      '--type',
      'driving',
      '--waypoints',
      '116.400000,39.910000,116.405000,39.915000',
      '--policy',
      'fastest',
      '--city',
      '北京',
    ])
  })

  it('builds a transit route argv with city and strategy', () => {
    expect(routeArgs({ from: '西湖', to: '西湖文化广场', mode: 'transit', city: '杭州', strategy: 'least_walk' })).toEqual([
      'route',
      '--from',
      '西湖',
      '--to',
      '西湖文化广场',
      '--type',
      'transit',
      '--strategy',
      'least_walk',
      '--city',
      '杭州',
    ])
  })

  it('trims endpoint values and drops blank names', () => {
    expect(routeArgs({ from: '  西湖 ', to: ' 灵隐寺 ', mode: 'riding', fromName: '   ' })).toEqual([
      'route',
      '--from',
      '西湖',
      '--to',
      '灵隐寺',
      '--type',
      'riding',
    ])
  })

  it('rejects an empty endpoint', () => {
    expectAmapErrorCode(() => routeArgs({ from: '  ', to: 'B', mode: 'walking' }), 'AMAP_COMMAND_FAILED')
    expectAmapErrorCode(() => routeArgs({ from: 'A', to: '', mode: 'walking' }), 'AMAP_COMMAND_FAILED')
  })

  it('requires a city for transit routes', () => {
    expectAmapErrorCode(() => routeArgs({ from: 'A', to: 'B', mode: 'transit' }), 'AMAP_UNSUPPORTED_ROUTE')
    expectAmapErrorCode(() => routeArgs({ from: 'A', to: 'B', mode: 'transit', city: '   ' }), 'AMAP_UNSUPPORTED_ROUTE')
  })

  it('rejects waypoints outside driving', () => {
    expectAmapErrorCode(
      () => routeArgs({ from: 'A', to: 'B', mode: 'walking', waypoints: ['C'] }),
      'AMAP_UNSUPPORTED_ROUTE',
    )
    expectAmapErrorCode(
      () => routeArgs({ from: 'A', to: 'B', mode: 'transit', city: '杭州', waypoints: ['C'] }),
      'AMAP_UNSUPPORTED_ROUTE',
    )
    expectAmapErrorCode(
      () => routeArgs({ from: 'A', to: 'B', mode: 'riding', waypoints: ['C'] }),
      'AMAP_UNSUPPORTED_ROUTE',
    )
  })

  it('accepts sixteen driving waypoints and rejects seventeen', () => {
    const sixteen = Array.from({ length: 16 }, (_, index) => `w${index}`)
    expect(routeArgs({ from: 'A', to: 'B', mode: 'driving', waypoints: sixteen })).toContain('--waypoints')
    expectAmapErrorCode(
      () => routeArgs({ from: 'A', to: 'B', mode: 'driving', waypoints: [...sixteen, 'w16'] }),
      'AMAP_UNSUPPORTED_ROUTE',
    )
  })

  it('rejects policy and strategy on the wrong mode', () => {
    expectAmapErrorCode(
      () => routeArgs({ from: 'A', to: 'B', mode: 'transit', city: '杭州', policy: 'fastest' }),
      'AMAP_UNSUPPORTED_ROUTE',
    )
    expectAmapErrorCode(
      () => routeArgs({ from: 'A', to: 'B', mode: 'driving', strategy: 'least_cost' }),
      'AMAP_UNSUPPORTED_ROUTE',
    )
    expectAmapErrorCode(
      () => routeArgs({ from: 'A', to: 'B', mode: 'walking', policy: 'shortest' }),
      'AMAP_UNSUPPORTED_ROUTE',
    )
  })
})

describe('amap coordinates', () => {
  it('formats a point with six decimals and longitude first', () => {
    expect(formatPoint({ longitude: 116.397428, latitude: 39.90923, coordinateSystem: 'gcj02' })).toBe(
      '116.397428,39.909230',
    )
    expect(formatPoint({ longitude: 116.4, latitude: 39.9, coordinateSystem: 'gcj02' })).toBe('116.400000,39.900000')
  })

  it('round-trips through formatPoint and parsePoint', () => {
    const point: GeoPoint = { longitude: 120.15507, latitude: 30.274084, coordinateSystem: 'gcj02' }
    expect(parsePoint(formatPoint(point))).toEqual(point)
  })

  it('parses longitude first and stamps gcj02', () => {
    const point = parsePoint(' 120.15507 , 30.274084 ')
    expect(point).toEqual({ longitude: 120.15507, latitude: 30.274084, coordinateSystem: 'gcj02' })
  })

  it('rejects malformed coordinate strings', () => {
    for (const input of ['', 'abc', '120.15507', '120.15507,', ',30.274084', '1,2,3', '0x10,30', 'NaN,30']) {
      expectAmapErrorCode(() => parsePoint(input), 'AMAP_INVALID_RESPONSE')
    }
  })

  it('rejects out-of-range longitude and latitude', () => {
    expectAmapErrorCode(() => parsePoint('180.000001,30'), 'AMAP_INVALID_RESPONSE')
    expectAmapErrorCode(() => parsePoint('-180.5,30'), 'AMAP_INVALID_RESPONSE')
    expectAmapErrorCode(() => parsePoint('120,90.5'), 'AMAP_INVALID_RESPONSE')
    expectAmapErrorCode(() => parsePoint('120,-91'), 'AMAP_INVALID_RESPONSE')
    expect(parsePoint('-180,90')).toEqual({ longitude: -180, latitude: 90, coordinateSystem: 'gcj02' })
  })
})

describe('amap cli envelope and payload parsing', () => {
  it('unwraps a successful envelope', () => {
    expect(parseCliEnvelope<{ ok: number }>(envelope({ ok: 1 }))).toEqual({ ok: 1 })
  })

  it('tolerates a leading UTF-8 BOM', () => {
    expect(parseCliEnvelope<{ ok: number }>(`\uFEFF${envelope({ ok: 1 })}`)).toEqual({ ok: 1 })
  })

  it('rejects invalid JSON', () => {
    expectAmapErrorCode(() => parseCliEnvelope('not json'), 'AMAP_INVALID_RESPONSE')
    expectAmapErrorCode(() => parseCliEnvelope(''), 'AMAP_INVALID_RESPONSE')
    expectAmapErrorCode(() => parseCliEnvelope('[1,2]'), 'AMAP_INVALID_RESPONSE')
  })

  it('maps success:false to AMAP_COMMAND_FAILED with the CLI error detail', () => {
    let thrown: unknown
    try {
      parseCliEnvelope(JSON.stringify({ success: false, data: null, error: 'map container is not running' }))
    } catch (error) {
      thrown = error
    }
    expect(AmapCliError.isAmapCliError(thrown)).toBe(true)
    if (!AmapCliError.isAmapCliError(thrown)) {
      throw new Error('expected an AmapCliError')
    }
    expect(thrown.code).toBe('AMAP_COMMAND_FAILED')
    expect(thrown.detail).toBe('map container is not running')
  })

  it('rejects a response without data', () => {
    expectAmapErrorCode(
      () => parseCliEnvelope(JSON.stringify({ success: true, error: null })),
      'AMAP_INVALID_RESPONSE',
    )
    expectAmapErrorCode(
      () => parseCliEnvelope(JSON.stringify({ success: true, data: null, error: null })),
      'AMAP_INVALID_RESPONSE',
    )
  })

  it('parses a searchPOI payload with every optional field', () => {
    const result = parseSearchPoi(envelope(SEARCH_PAYLOAD))
    expect(result.keyword).toBe('咖啡')
    expect(result.city).toBe('杭州')
    expect(result.center).toEqual([120.15507, 30.274084])
    expect(result.radius).toBe(2000)
    expect(result.total).toBe(132)
    expect(result.pageSize).toBe(20)
    expect(result.pageIndex).toBe(1)
    expect(result.pois).toHaveLength(1)
    expect(result.pois[0]).toEqual({
      id: 'B0FFH3L0YM',
      name: '星巴克(湖滨银泰店)',
      address: '杭州市上城区延安路258号',
      location: [120.168285, 30.252619],
      tel: '0571-87021234',
      type: '餐饮服务;咖啡厅;星巴克',
      distanceMeters: 812,
    })
  })

  it('keeps longitude first and omits absent optional POI fields', () => {
    const payload = {
      keyword: 'k',
      total: 1,
      pageSize: 20,
      pageIndex: 1,
      city: '',
      pois: [{ id: 'B1', name: '西湖', address: '', location: [120.15507, 30.274084] }],
    }
    const result = parseSearchPoi(envelope(payload))
    expect(result.pois[0]?.location[0]).toBe(120.15507)
    expect(result.pois[0]?.location[1]).toBe(30.274084)
    expect(result.pois[0] === undefined ? undefined : 'tel' in result.pois[0]).toBe(false)
    expect(result.pois[0] === undefined ? undefined : 'type' in result.pois[0]).toBe(false)
    expect(result.pois[0] === undefined ? undefined : 'distanceMeters' in result.pois[0]).toBe(false)
    expect('city' in result).toBe(false)
    expect('center' in result).toBe(false)
    expect('radius' in result).toBe(false)
  })

  it('rejects malformed searchPOI payloads', () => {
    expectAmapErrorCode(() => parseSearchPoi(envelope({ keyword: 'k', pageSize: 20, pageIndex: 1, pois: [] })), 'AMAP_INVALID_RESPONSE')
    expectAmapErrorCode(() => parseSearchPoi(envelope({ ...SEARCH_PAYLOAD, pois: {} })), 'AMAP_INVALID_RESPONSE')
    expectAmapErrorCode(
      () => parseSearchPoi(envelope({ ...SEARCH_PAYLOAD, pois: [poiPayload({ location: [120.1] })] })),
      'AMAP_INVALID_RESPONSE',
    )
    expectAmapErrorCode(
      () => parseSearchPoi(envelope({ ...SEARCH_PAYLOAD, pois: [poiPayload({ id: '   ' })] })),
      'AMAP_INVALID_RESPONSE',
    )
    expectAmapErrorCode(
      () => parseSearchPoi(envelope({ ...SEARCH_PAYLOAD, pois: [poiPayload({ name: '' })] })),
      'AMAP_INVALID_RESPONSE',
    )
    expectAmapErrorCode(
      () => parseSearchPoi(envelope({ ...SEARCH_PAYLOAD, state: { ...searchState(), center: '120,30' } })),
      'AMAP_INVALID_RESPONSE',
    )
  })

  it('reads a captured searchPOI payload whose parameters live under state', () => {
    const result = parseSearchPoi(envelope(SEARCH_PAYLOAD_CAPTURED))
    expect(result.keyword).toBe('天安门')
    expect(result.city).toBe('北京')
    expect(result.total).toBe(100)
    expect(result.pageSize).toBe(2)
    expect(result.pageIndex).toBe(1)
    expect(result.pois).toHaveLength(2)
    expect(result.pois[0]).toEqual({
      id: 'B000A60DA1',
      name: '天安门',
      address: '长安街北侧',
      location: [116.397463, 39.909187],
      tel: '010-65016000',
      type: '风景名胜;风景名胜;国家级景点',
      // The provider's own photo URL is what makes the sidebar legible, so it
      // is carried through rather than dropped.
      photoUrl: 'http://store.is.autonavi.com/showpic/17a36a737908810a310387c7d53e878a',
    })
    // The provider reports `distance: null` outside a nearby search, so the
    // optional field stays absent instead of becoming a non-number.
    expect('distanceMeters' in (result.pois[0] ?? {})).toBe(false)
    expect(result.pois[1]?.name).toBe('天安门广场')
    expect('center' in result).toBe(false)
    expect('radius' in result).toBe(false)
  })

  it('still reads the legacy top-level searchPOI layout', () => {
    const result = parseSearchPoi(envelope(SEARCH_PAYLOAD_LEGACY))
    expect(result.keyword).toBe('咖啡')
    expect(result.city).toBe('杭州')
    expect(result.total).toBe(132)
    expect(result.radius).toBe(2000)
  })

  it('prefers the live state block when both layouts are present', () => {
    const both = { ...SEARCH_PAYLOAD_LEGACY, state: { keyword: '咖啡', resultCount: 7, pageSize: 5, pageIndex: 3 } }
    const result = parseSearchPoi(envelope(both))
    expect(result.keyword).toBe('咖啡')
    expect(result.total).toBe(7)
    expect(result.pageSize).toBe(5)
    expect(result.pageIndex).toBe(3)
  })

  it('parses a route payload', () => {
    const result = parseRoute(envelope(ROUTE_PAYLOAD))
    expect(result.type).toBe('driving')
    expect(result.from).toEqual({ name: '天安门', position: [116.397428, 39.90923] })
    expect(result.to.position).toEqual([116.41765, 39.947407])
    expect(result.summary.distance).toBe(8234)
    expect(result.summary.time).toBe(1560)
    expect(result.summary.tolls).toBe(0)
    expect(result.summary.steps).toHaveLength(2)
    expect(result.summary.steps[0]).toEqual({ instruction: '沿东长安街向西行驶', distance: 320, time: 60 })
  })

  it('treats missing route steps as an empty list', () => {
    const result = parseRoute(
      envelope({ ...ROUTE_PAYLOAD, summary: { distance: 10, time: 20 } }),
    )
    expect(result.summary.steps).toEqual([])
    expect('tolls' in result.summary).toBe(false)
  })

  it('rejects malformed route payloads', () => {
    const withoutSummary = { type: 'walking', from: { name: 'A', position: [1, 2] }, to: { name: 'B', position: [3, 4] } }
    expectAmapErrorCode(() => parseRoute(envelope(withoutSummary)), 'AMAP_INVALID_RESPONSE')
    expectAmapErrorCode(
      () => parseRoute(envelope({ ...ROUTE_PAYLOAD, summary: { distance: null, time: 10, steps: [] } })),
      'AMAP_INVALID_RESPONSE',
    )
    expectAmapErrorCode(
      () => parseRoute(envelope({ ...ROUTE_PAYLOAD, summary: { distance: 1, time: 1, steps: 'none' } })),
      'AMAP_INVALID_RESPONSE',
    )
    expectAmapErrorCode(
      () => parseRoute(envelope({ ...ROUTE_PAYLOAD, state: { from: { name: 'A', position: [1] }, to: { name: 'B', position: [3, 4] }, type: 'walking' } })),
      'AMAP_INVALID_RESPONSE',
    )
  })

  it('reads a captured route payload whose endpoints live under state', () => {
    const result = parseRoute(envelope(ROUTE_PAYLOAD_CAPTURED))
    expect(result.type).toBe('walking')
    expect(result.from).toEqual({ name: '天安门', position: [116.397463, 39.909187] })
    expect(result.to).toEqual({ name: '天安门广场', position: [116.397755, 39.903182] })
    expect(result.summary.distance).toBe(3113)
    expect(result.summary.time).toBe(2490)
    expect(result.summary.steps).toHaveLength(3)
    expect(result.summary.steps[0]).toEqual({ instruction: '向北步行396米右转', distance: 396, time: 317 })
  })

  it('still reads the legacy top-level route layout', () => {
    const result = parseRoute(envelope(ROUTE_PAYLOAD_LEGACY))
    expect(result.type).toBe('driving')
    expect(result.from.name).toBe('天安门')
    expect(result.summary.tolls).toBe(0)
  })

  it('parses status payloads', () => {
    expect(parseStatus(envelope({ status: 'not_running' }))).toEqual({ status: 'not_running' })
    expect(parseStatus(envelope({ status: 'stopped' }))).toEqual({ status: 'stopped' })
    expect(parseStatus(envelope({ status: 'running', port: 43117, mapReady: true, uptime: 12.5 }))).toEqual({
      status: 'running',
      port: 43117,
      mapReady: true,
      uptime: 12.5,
    })
    expect(parseStatus(envelope({ status: 'running', port: 1, mapReady: false }))).toEqual({
      status: 'running',
      port: 1,
      mapReady: false,
    })
  })

  it('rejects an unknown status or a wrongly typed optional field', () => {
    expectAmapErrorCode(() => parseStatus(envelope({ status: 'starting' })), 'AMAP_INVALID_RESPONSE')
    expectAmapErrorCode(() => parseStatus(envelope({})), 'AMAP_INVALID_RESPONSE')
    expectAmapErrorCode(() => parseStatus(envelope({ status: 'running', port: '43117' })), 'AMAP_INVALID_RESPONSE')
    expectAmapErrorCode(() => parseStatus(envelope({ status: 'running', mapReady: 'yes' })), 'AMAP_INVALID_RESPONSE')
  })
})

describe('amap cache keys', () => {
  const baseSearch = {
    keyword: '咖啡',
    city: '杭州',
    center: WEST_LAKE,
    radiusMeters: 2000,
    pageSize: 20,
    pageIndex: 1,
  } as const

  it('is stable across property order', () => {
    const reordered = {
      pageIndex: 1,
      pageSize: 20,
      radiusMeters: 2000,
      center: WEST_LAKE,
      city: '杭州',
      keyword: '咖啡',
    }
    expect(poiCacheKey(reordered)).toBe(poiCacheKey(baseSearch))
    expect(poiCacheKey(baseSearch)).toMatch(/^poi:[0-9a-f]{8}$/)
  })

  it('lowercases and trims search inputs', () => {
    expect(poiCacheKey({ keyword: ' Coffee ' })).toBe(poiCacheKey({ keyword: 'coffee' }))
    expect(poiCacheKey({ keyword: 'k', city: ' HangZhou ' })).toBe(poiCacheKey({ keyword: 'k', city: 'hangzhou' }))
  })

  it('changes for every search field that changes the result', () => {
    const keys = new Set([
      poiCacheKey(baseSearch),
      poiCacheKey({ ...baseSearch, keyword: '茶叶' }),
      poiCacheKey({ ...baseSearch, city: '上海' }),
      poiCacheKey({ ...baseSearch, center: { longitude: 121.4737, latitude: 31.2304, coordinateSystem: 'gcj02' } }),
      poiCacheKey({ ...baseSearch, radiusMeters: 3000 }),
      poiCacheKey({ ...baseSearch, pageSize: 10 }),
      poiCacheKey({ ...baseSearch, pageIndex: 2 }),
    ])
    expect(keys.size).toBe(7)
  })

  it('is stable across property order for routes', () => {
    const reordered = {
      city: '杭州',
      to: '灵隐寺',
      mode: 'transit',
      from: '西湖',
      strategy: 'least_walk',
    } as const
    expect(routeCacheKey(reordered)).toBe(routeCacheKey({ from: '西湖', to: '灵隐寺', mode: 'transit', city: '杭州', strategy: 'least_walk' }))
    expect(routeCacheKey(reordered)).toMatch(/^route:[0-9a-f]{8}$/)
  })

  it('changes for every route field that changes the result', () => {
    const base = { from: '西湖', to: '灵隐寺', mode: 'walking' } as const
    const keys = new Set([
      routeCacheKey(base),
      routeCacheKey({ ...base, mode: 'riding' }),
      routeCacheKey({ from: '灵隐寺', to: '西湖', mode: 'walking' }),
      routeCacheKey({ ...base, city: '杭州' }),
      routeCacheKey({ from: '西湖', to: '灵隐寺', mode: 'driving', policy: 'fastest' }),
      routeCacheKey({ from: '西湖', to: '灵隐寺', mode: 'driving', policy: 'shortest' }),
      routeCacheKey({ from: '西湖', to: '灵隐寺', mode: 'driving', waypoints: ['A'] }),
      routeCacheKey({ from: '西湖', to: '灵隐寺', mode: 'driving', waypoints: ['B', 'A'] }),
      routeCacheKey({ from: '西湖', to: '灵隐寺', mode: 'transit', city: '杭州', strategy: 'least_cost' }),
    ])
    expect(keys.size).toBe(9)
  })

  it('normalizes route input whitespace and case', () => {
    expect(routeCacheKey({ from: ' West Lake ', to: 'Lingyin', mode: 'walking' })).toBe(
      routeCacheKey({ from: 'west lake', to: 'lingyin', mode: 'walking' }),
    )
    expect(routeCacheKey({ from: 'A', to: 'B', mode: 'driving', waypoints: [' X '] })).toBe(
      routeCacheKey({ from: 'A', to: 'B', mode: 'driving', waypoints: ['x'] }),
    )
  })
})

describe('amap error type', () => {
  it('carries code, name and optional detail', () => {
    const error = new AmapCliError('AMAP_COMMAND_TIMEOUT', 'timed out')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AmapCliError')
    expect(error.message).toBe('timed out')
    expect(error.code).toBe('AMAP_COMMAND_TIMEOUT')
    expect(error.detail).toBeUndefined()
    expect(AmapCliError.isAmapCliError(error)).toBe(true)
    expect(AmapCliError.isAmapCliError(new Error('plain'))).toBe(false)
    expect(AmapCliError.isAmapCliError('AMAP_COMMAND_FAILED')).toBe(false)
    expect(new AmapCliError('AMAP_NOT_READY', 'not ready', 'mapReady=false').detail).toBe('mapReady=false')
  })
})

describe('normalizeCategories', () => {
  it('splits, trims, dedupes and drops empties', () => {
    expect(normalizeCategories('餐饮服务;咖啡厅;星巴克;咖啡厅')).toEqual(['餐饮服务', '咖啡厅', '星巴克'])
    expect(normalizeCategories(' 购物服务 ; ; 便利店 ')).toEqual(['购物服务', '便利店'])
    expect(normalizeCategories(';;')).toEqual([])
  })

  it('returns an empty list when the provider reports no type', () => {
    expect(normalizeCategories(undefined)).toEqual([])
    expect(normalizeCategories('')).toEqual([])
  })
})

describe('normalizePlace', () => {
  const raw = asPoi(poiPayload())

  it('normalizes a complete POI', () => {
    const place = normalizePlace(raw, { id: 'place-1', fetchedAt: FETCHED_AT, providerVersion: '1.4.0' })
    expect(place).toEqual({
      id: 'place-1',
      providerPlaceId: 'B0FFH3L0YM',
      name: '星巴克(湖滨银泰店)',
      address: '杭州市上城区延安路258号',
      point: { longitude: 120.168285, latitude: 30.252619, coordinateSystem: 'gcj02' },
      telephone: '0571-87021234',
      categories: ['餐饮服务', '咖啡厅', '星巴克'],
      status: 'candidate',
      source: { provider: 'amap-cli', fetchedAt: FETCHED_AT, providerVersion: '1.4.0' },
    })
  })

  it('defaults the status to candidate and honours an explicit status', () => {
    expect(normalizePlace(raw, { id: 'p', fetchedAt: FETCHED_AT }).status).toBe('candidate')
    expect(normalizePlace(raw, { id: 'p', fetchedAt: FETCHED_AT, status: 'planned' }).status).toBe('planned')
  })

  it('only sets optional properties that exist', () => {
    const bare = normalizePlace(asPoi({ id: 'B1', name: '西湖', address: '', location: [120.15507, 30.274084] }), {
      id: 'place-2',
      fetchedAt: FETCHED_AT,
    })
    expect('telephone' in bare).toBe(false)
    expect('providerVersion' in bare.source).toBe(false)
    expect(bare.address).toBe('')
    expect(bare.categories).toEqual([])
    expect(bare.point.coordinateSystem).toBe('gcj02')
  })

  it('keeps longitude first and never swaps the axes', () => {
    const place = normalizePlace(raw, { id: 'p', fetchedAt: FETCHED_AT })
    expect(place.point.longitude).toBe(120.168285)
    expect(place.point.latitude).toBe(30.252619)
  })

  it('rejects a missing id, name or location', () => {
    expectAmapErrorCode(
      () => normalizePlace(asPoi({ ...poiPayload(), id: '  ' }), { id: 'p', fetchedAt: FETCHED_AT }),
      'AMAP_INVALID_RESPONSE',
    )
    expectAmapErrorCode(
      () => normalizePlace(asPoi({ ...poiPayload(), name: '' }), { id: 'p', fetchedAt: FETCHED_AT }),
      'AMAP_INVALID_RESPONSE',
    )
    expectAmapErrorCode(
      () => normalizePlace(asPoi({ ...poiPayload(), location: [120.1] }), { id: 'p', fetchedAt: FETCHED_AT }),
      'AMAP_INVALID_RESPONSE',
    )
    expectAmapErrorCode(
      () => normalizePlace(asPoi({ ...poiPayload(), location: ['120.1', 30.2] }), { id: 'p', fetchedAt: FETCHED_AT }),
      'AMAP_INVALID_RESPONSE',
    )
    expectAmapErrorCode(
      () => normalizePlace(asPoi({ ...poiPayload(), location: Number.NaN as unknown as number[] }), {
        id: 'p',
        fetchedAt: FETCHED_AT,
      }),
      'AMAP_INVALID_RESPONSE',
    )
  })

  it('accepts a POI without an address and without a telephone', () => {
    const place = normalizePlace(asPoi({ ...poiPayload(), address: undefined, tel: '   ' }), {
      id: 'p',
      fetchedAt: FETCHED_AT,
    })
    expect(place.address).toBe('')
    expect('telephone' in place).toBe(false)
  })
})

describe('normalizeRouteLeg', () => {
  const context = {
    id: 'leg-1',
    fromItemId: 'item-1',
    toItemId: 'item-2',
    mode: 'driving',
    fetchedAt: FETCHED_AT,
  } as const

  it('maps summary fields, tolls, steps and freshness', () => {
    const leg = normalizeRouteLeg(parseRoute(envelope(ROUTE_PAYLOAD)), { ...context, providerVersion: '1.4.0' })
    expect(leg.id).toBe('leg-1')
    expect(leg.fromItemId).toBe('item-1')
    expect(leg.toItemId).toBe('item-2')
    expect(leg.mode).toBe('driving')
    expect(leg.distanceMeters).toBe(8234)
    expect(leg.durationSeconds).toBe(1560)
    expect(leg.tollsYuan).toBe(0)
    expect(leg.freshness).toBe('fresh')
    expect(leg.source).toEqual({ provider: 'amap-cli', fetchedAt: FETCHED_AT, providerVersion: '1.4.0' })
    expect(leg.steps).toEqual([
      { instruction: '沿东长安街向西行驶', distanceMeters: 320, durationSeconds: 60 },
      { instruction: '右转进入南河沿大街', distanceMeters: 0, durationSeconds: 0 },
    ])
  })

  it('omits tollsYuan when the provider reports no tolls', () => {
    const leg = normalizeRouteLeg(asRoute({ ...ROUTE_PAYLOAD, summary: { distance: 100, time: 60, steps: [] } }), context)
    expect('tollsYuan' in leg).toBe(false)
    expect('providerVersion' in leg.source).toBe(false)
  })

  it('clamps negative or zero step magnitudes to zero', () => {
    const raw = asRoute({
      ...ROUTE_PAYLOAD,
      summary: {
        distance: 100,
        time: 60,
        steps: [
          { instruction: 'a', distance: -5, time: 0 },
          { instruction: 'b', distance: 0, time: -9 },
        ],
      },
    })
    expect(routeSteps(raw)).toEqual([
      { instruction: 'a', distanceMeters: 0, durationSeconds: 0 },
      { instruction: 'b', distanceMeters: 0, durationSeconds: 0 },
    ])
    expect(normalizeRouteLeg(raw, context).steps).toHaveLength(2)
  })

  it('returns no steps when the response has none', () => {
    expect(routeSteps(asRoute({ ...ROUTE_PAYLOAD, summary: { distance: 1, time: 1 } }))).toEqual([])
    expect(routeSteps(asRoute({ ...ROUTE_PAYLOAD, summary: { distance: 1, time: 1, steps: [] } }))).toEqual([])
  })

  it('rejects a missing or malformed summary', () => {
    const withoutSummary = asRoute({
      type: 'walking',
      from: { name: 'A', position: [1, 2] },
      to: { name: 'B', position: [3, 4] },
    })
    expectAmapErrorCode(() => normalizeRouteLeg(withoutSummary, context), 'AMAP_INVALID_RESPONSE')
    expectAmapErrorCode(() => routeSteps(withoutSummary), 'AMAP_INVALID_RESPONSE')
    expectAmapErrorCode(
      () => normalizeRouteLeg(asRoute({ ...ROUTE_PAYLOAD, summary: { time: 10, steps: [] } }), context),
      'AMAP_INVALID_RESPONSE',
    )
    expectAmapErrorCode(
      () => normalizeRouteLeg(asRoute({ ...ROUTE_PAYLOAD, summary: { distance: Number.NaN, time: 10 } }), context),
      'AMAP_INVALID_RESPONSE',
    )
  })

  it('rejects malformed steps', () => {
    expectAmapErrorCode(
      () => routeSteps(asRoute({ ...ROUTE_PAYLOAD, summary: { distance: 1, time: 1, steps: 'none' } })),
      'AMAP_INVALID_RESPONSE',
    )
    expectAmapErrorCode(
      () => routeSteps(asRoute({ ...ROUTE_PAYLOAD, summary: { distance: 1, time: 1, steps: [{ instruction: 'a' }] } })),
      'AMAP_INVALID_RESPONSE',
    )
    expectAmapErrorCode(
      () =>
        routeSteps(
          asRoute({ ...ROUTE_PAYLOAD, summary: { distance: 1, time: 1, steps: [{ instruction: 3, distance: 1, time: 1 }] } }),
        ),
      'AMAP_INVALID_RESPONSE',
    )
  })
})

describe('placeCacheId', () => {
  it('is deterministic and readable for a normal 高德 POI id', () => {
    expect(placeCacheId('B0FFH3L0YM')).toBe('amap-B0FFH3L0YM')
    expect(placeCacheId('B0FFH3L0YM')).toBe(placeCacheId('B0FFH3L0YM'))
  })

  it('stays safe for ids with separators and non-ASCII characters', () => {
    const id = placeCacheId('B0FF/杭州 店')
    expect(id).toMatch(/^amap-[A-Za-z0-9_-]+$/)
    expect(id).toBe(placeCacheId('B0FF/杭州 店'))
  })

  it('never collapses two different provider ids', () => {
    expect(placeCacheId('a/b')).not.toBe(placeCacheId('a_b'))
    expect(placeCacheId('A')).not.toBe(placeCacheId('a'))
  })

  it('rejects an empty provider id', () => {
    expectAmapErrorCode(() => placeCacheId('   '), 'AMAP_INVALID_RESPONSE')
  })
})

// ---------------------------------------------------------------------------
// Web-service (REST) POI search
// ---------------------------------------------------------------------------

describe('drivingRouteOverRest', () => {
  /** Minimal fetch stand-in that records the requested URL. */
  function fakeFetch(payload: unknown, status = 200): { readonly impl: typeof fetch; readonly urls: string[] } {
    const urls: string[] = []
    const impl = (async (input: string | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { impl, urls }
  }

  it('reads the distance, the clock and the provider path', async () => {
    const call = fakeFetch({
      status: '1',
      info: 'OK',
      infocode: '10000',
      route: {
        paths: [
          {
            distance: '1077100',
            cost: { duration: '45480', tolls: '420' },
            steps: [
              { instruction: '沿二环向西', polyline: '120.1,30.2;119.4,30.5' },
              { instruction: '驶入京港澳高速', polyline: '119.4,30.5;108.9,34.2' },
            ],
          },
        ],
      },
    })

    const route = await drivingRouteOverRest(
      { key: 'rest-key', origin: '120.1,30.2', destination: '108.9,34.2' },
      { fetchImpl: call.impl, minIntervalMs: 0 },
    )

    expect(route.distanceMeters).toBe(1_077_100)
    expect(route.durationSeconds).toBe(45_480)
    expect(route.tollsYuan).toBe(420)
    // The per-step paths are joined, which is what the map draws.
    expect(route.polyline).toBe('120.1,30.2;119.4,30.5;119.4,30.5;108.9,34.2')
    expect(call.urls[0]).toContain('/v5/direction/driving')
    expect(call.urls[0]).toContain('show_fields=cost%2Cpolyline')
  })

  it('reports a provider answer with no route', async () => {
    const call = fakeFetch({ status: '1', info: 'OK', infocode: '10000', route: {} })

    await expect(
      drivingRouteOverRest({ key: 'rest-key', origin: '1,1', destination: '2,2' }, { fetchImpl: call.impl, minIntervalMs: 0 }),
    ).rejects.toThrow('没有返回这条驾车路线')
  })
})

describe('searchPoisOverRest', () => {
  /** Minimal fetch stand-in that records the requested URL. */
  function fakeFetch(payload: unknown, status = 200): { readonly impl: typeof fetch; readonly urls: string[] } {
    const urls: string[] = []
    const impl = (async (input: string | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { impl, urls }
  }

  it('reads photos, phone and address without touching the CLI', async () => {
    const call = fakeFetch({
      status: '1',
      info: 'OK',
      infocode: '10000',
      count: '7',
      pois: [
        {
          id: 'B0XIHU',
          name: '西湖',
          address: ['浙江省杭州市西湖区', '龙井路1号'],
          tel: ['0571-87977767', '0571-87977768'],
          photos: [{ title: '西湖', url: 'http://store.is.autonavi.com/showpic/abc' }],
        },
        { id: 'B0OTHER', name: '西湖音乐喷泉' },
      ],
    })

    const result = await searchPoisOverRest(
      { key: 'rest-key', keyword: '西湖', city: '杭州' },
      { fetchImpl: call.impl, minIntervalMs: 0 },
    )

    expect(result.total).toBe(7)
    expect(result.places).toEqual([
      {
        providerPlaceId: 'B0XIHU',
        name: '西湖',
        address: '浙江省杭州市西湖区 / 龙井路1号',
        telephone: '0571-87977767 / 0571-87977768',
        photoUrl: 'http://store.is.autonavi.com/showpic/abc',
      },
      { providerPlaceId: 'B0OTHER', name: '西湖音乐喷泉' },
    ])
    expect(call.urls[0]).toContain('restapi.amap.com/v3/place/text')
    expect(call.urls[0]).toContain('extensions=all')
    expect(call.urls[0]).toContain('city=')
  })

  it('names the credential to fix when the key is rejected', async () => {
    const call = fakeFetch({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' })

    await expect(searchPoisOverRest({ key: 'bad', keyword: '西湖' }, { fetchImpl: call.impl, minIntervalMs: 0 })).rejects.toThrow(
      /restKeyRef/,
    )
  })

  it('reports an HTTP failure instead of pretending there were no matches', async () => {
    const call = fakeFetch({}, 502)

    await expect(searchPoisOverRest({ key: 'k', keyword: '西湖' }, { fetchImpl: call.impl, minIntervalMs: 0 })).rejects.toThrow(/502/)
  })

  it('paces calls and retries once when the key is rate-limited', async () => {
    const urls: string[] = []
    let call = 0
    const impl = (async (input: string | URL) => {
      urls.push(String(input))
      call += 1
      const payload = call === 1 ? { status: '0', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT', infocode: '10021' } : { status: '1', info: 'OK', infocode: '10000', count: '1', pois: [{ id: 'B1', name: '西湖' }] }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const result = await searchPoisOverRest({ key: 'k', keyword: '西湖' }, { fetchImpl: impl, minIntervalMs: 0 })

    expect(urls).toHaveLength(2)
    expect(result.places[0]?.name).toBe('西湖')
  })

  it('reads one POI by its stored id, photos included', async () => {
    const call = fakeFetch({
      status: '1',
      info: 'OK',
      infocode: '10000',
      pois: [{ id: 'B0FFKL520U', name: '故宫博物院检票处', photos: [{ url: 'https://aos-comment.amap.com/x.jpg' }] }],
    })

    const place = await getPoiByIdOverRest({ key: 'k', id: 'B0FFKL520U' }, { fetchImpl: call.impl, minIntervalMs: 0 })

    expect(place).toEqual({
      providerPlaceId: 'B0FFKL520U',
      name: '故宫博物院检票处',
      photoUrl: 'https://aos-comment.amap.com/x.jpg',
    })
    expect(call.urls[0]).toContain('/v3/place/detail')
    expect(call.urls[0]).toContain('id=B0FFKL520U')
  })
})
