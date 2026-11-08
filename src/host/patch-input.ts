import type { TripPatchOp } from '../domain/patch.js'
import type {
  TransitEnd,
  TripTransit,
  GeoPoint,
  ItineraryItem,
  PlaceStatus,
  RouteLeg,
  RouteStep,
  TripDay,
  TravelMode,
  TravelPreferences,
  TripPlace,
  TripStatus,
} from '../domain/trip.js'

/** One rejected raw operation. */
export interface PatchInputViolation {
  /** Index in the submitted batch; `-1` for a malformed batch. */
  readonly index: number
  /** Chinese explanation safe to show the model. */
  readonly message: string
}

/** Outcome of validating model-supplied operations. */
export interface PatchInputResult {
  readonly ops: readonly TripPatchOp[]
  readonly violations: readonly PatchInputViolation[]
}

/** Success or a human-readable reason. */
type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

const TRIP_STATUSES: readonly TripStatus[] = ['idea', 'drafting', 'checking', 'needs-attention', 'ready', 'traveling', 'archived']
const PLACE_STATUSES: readonly PlaceStatus[] = ['candidate', 'planned', 'excluded', 'locked']
const TRAVEL_MODES: readonly TravelMode[] = ['walking', 'transit', 'riding', 'driving']
const PACES: readonly TravelPreferences['pace'][] = ['relaxed', 'balanced', 'intensive']

/**
 * Validate raw model-supplied patch operations into typed operations.
 *
 * The model produces JSON, so every field is checked before an operation
 * reaches the domain layer. Violations are returned rather than thrown so the
 * model can correct one operation without losing the rest of the batch.
 * @param value - raw operations array.
 * @returns accepted operations and per-index violations.
 */
export function parsePatchOps(value: unknown): PatchInputResult {
  if (!Array.isArray(value)) {
    return { ops: [], violations: [{ index: -1, message: '`ops` 必须是数组。' }] }
  }
  const ops: TripPatchOp[] = []
  const violations: PatchInputViolation[] = []
  value.forEach((raw, index) => {
    const parsed = parseOne(raw)
    if (parsed.ok) ops.push(parsed.value)
    else violations.push({ index, message: parsed.message })
  })
  return { ops, violations }
}

/** Validate one raw operation. */
function parseOne(raw: unknown): Parsed<TripPatchOp> {
  if (!isRecord(raw)) return fail('操作必须是对象。')
  const kind = raw['kind']
  if (typeof kind !== 'string') return fail('缺少字符串字段 `kind`。')
  switch (kind) {
    case 'rename-trip':
      return mapField(requireString(raw, 'title'), (title) => ({ kind: 'rename-trip', title }))
    case 'set-status':
      return mapField(requireEnum(raw, 'status', TRIP_STATUSES), (status) => ({ kind: 'set-status', status: status as TripStatus }))
    case 'set-active-scenario':
      return mapField(requireString(raw, 'scenarioId'), (scenarioId) => ({ kind: 'set-active-scenario', scenarioId }))
    case 'set-budget':
      return parseBudget(raw)
    case 'set-preferences':
      return parsePreferences(raw)
    case 'add-place':
      return mapField(parsePlace(raw['place']), (place) => ({ kind: 'add-place', place }))
    case 'set-place-status':
      return parsePlaceStatus(raw)
    case 'set-place-facts':
      return parsePlaceFacts(raw)
    case 'add-item':
      return parseAddItem(raw)
    case 'remove-item':
      return parseItemRef(raw, 'remove-item')
    case 'move-item':
      return parseItemRef(raw, 'move-item')
    case 'set-item-lock':
      return parseItemLock(raw)
    case 'set-item-time':
      return parseItemTime(raw)
    case 'set-day-title':
      return parseDayTitle(raw)
    case 'set-leg':
      return mapField(couple(requireString(raw, 'dayId'), parseLeg(raw['leg'])), ([dayId, leg]) => ({ kind: 'set-leg', dayId, leg }))
    case 'remove-leg':
      return mapField(couple(requireString(raw, 'dayId'), requireString(raw, 'legId')), ([dayId, legId]) => ({ kind: 'remove-leg', dayId, legId }))
    case 'set-day-transit':
      return mapField(
        couple(requireString(raw, 'dayId'), parseTransit(raw['transit'])),
        ([dayId, transit]) => ({ kind: 'set-day-transit', dayId, transit }),
      )
    case 'remove-day-transit':
      return mapField(
        couple(requireString(raw, 'dayId'), requireString(raw, 'transitId')),
        ([dayId, transitId]) => ({ kind: 'remove-day-transit', dayId, transitId }),
      )
    case 'add-day':
      return mapField(parseDay(raw['day']), (day) => ({ kind: 'add-day', day }))
    case 'remove-day':
      return mapField(requireString(raw, 'dayId'), (dayId) => ({ kind: 'remove-day', dayId }))
    case 'set-trip-dates':
      return parseTripDates(raw)
    case 'reorder-day':
      return parseReorderDay(raw)
    case 'reflow-day':
      return mapField(requireString(raw, 'dayId'), (dayId) => ({ kind: 'reflow-day', dayId }))
    default:
      return fail(`不支持的操作类型 \`${kind}\`。`)
  }
}

/**
 * Validate a day re-order: an ordered list of the day's own item ids.
 *
 * Whether the ids really belong to that day is the domain's job, because only
 * the stored day knows its items.
 */
function parseReorderDay(raw: Record<string, unknown>): Parsed<TripPatchOp> {
  const dayId = requireString(raw, 'dayId')
  if (!dayId.ok) return dayId
  const order = raw['order']
  if (!Array.isArray(order) || order.length === 0 || order.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    return fail('字段 `order` 必须是非空的安排 id 数组。')
  }
  return ok({ kind: 'reorder-day', dayId: dayId.value, order: order.map((entry) => (entry as string).trim()) })
}

/**
 * Validate a trip-level date change.
 *
 * Only shape is checked here; calendar validity and the day-count agreement
 * belong to the domain op, which reports them as patch rejections.
 */
function parseTripDates(raw: Record<string, unknown>): Parsed<TripPatchOp> {
  const startDate = requireString(raw, 'startDate')
  if (!startDate.ok) return startDate
  const endDate = optionalString(raw, 'endDate')
  if (!endDate.ok) return endDate
  const redateDays = raw['redateDays']
  if (redateDays !== undefined && typeof redateDays !== 'boolean') {
    return fail('字段 `redateDays` 必须是布尔值。')
  }
  return ok({
    kind: 'set-trip-dates',
    startDate: startDate.value,
    ...endDate.value === undefined ? {} : { endDate: endDate.value },
    ...redateDays === undefined ? {} : { redateDays },
  })
}

/** Validate a budget update. */
function parseBudget(raw: Record<string, unknown>): Parsed<TripPatchOp> {
  const currency = optionalString(raw, 'currency')
  if (!currency.ok) return currency
  const limit = optionalNumber(raw, 'limit')
  if (!limit.ok) return limit
  const estimatedTotal = optionalNumber(raw, 'estimatedTotal')
  if (!estimatedTotal.ok) return estimatedTotal
  const confirmedTotal = optionalNumber(raw, 'confirmedTotal')
  if (!confirmedTotal.ok) return confirmedTotal
  if (currency.value === undefined && limit.value === undefined && estimatedTotal.value === undefined && confirmedTotal.value === undefined) {
    return fail('`set-budget` 至少需要 `currency`、`limit`、`estimatedTotal` 或 `confirmedTotal` 之一。')
  }
  for (const entry of [limit.value, estimatedTotal.value, confirmedTotal.value]) {
    if (entry !== undefined && entry < 0) return fail('预算数值不能为负数。')
  }
  return ok({
    kind: 'set-budget',
    ...currency.value === undefined ? {} : { currency: currency.value },
    ...limit.value === undefined ? {} : { limit: limit.value },
    ...estimatedTotal.value === undefined ? {} : { estimatedTotal: estimatedTotal.value },
    ...confirmedTotal.value === undefined ? {} : { confirmedTotal: confirmedTotal.value },
  })
}

/** Validate a preferences update. */
function parsePreferences(raw: Record<string, unknown>): Parsed<TripPatchOp> {
  const source = raw['preferences']
  if (!isRecord(source)) return fail('字段 `preferences` 必须是对象。')
  const preferences: Record<string, unknown> = {}
  if (source['pace'] !== undefined) {
    const pace = requireEnum(source, 'pace', PACES)
    if (!pace.ok) return pace
    preferences['pace'] = pace.value
  }
  for (const key of ['interests', 'avoid', 'preferredModes'] as const) {
    const list = source[key]
    if (list === undefined) continue
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
      return fail(`字段 \`preferences.${key}\` 必须是字符串数组。`)
    }
    preferences[key] = list
  }
  const maximumWalking = source['maximumWalkingMinutesPerLeg']
  if (maximumWalking !== undefined) {
    if (typeof maximumWalking !== 'number' || !Number.isFinite(maximumWalking) || maximumWalking < 0) {
      return fail('字段 `preferences.maximumWalkingMinutesPerLeg` 必须是非负数。')
    }
    preferences['maximumWalkingMinutesPerLeg'] = maximumWalking
  }
  if (Object.keys(preferences).length === 0) return fail('`set-preferences` 至少需要一个字段。')
  return ok({ kind: 'set-preferences', preferences: preferences as Partial<TravelPreferences> })
}

/** Validate a place status update. */
function parsePlaceStatus(raw: Record<string, unknown>): Parsed<TripPatchOp> {
  return mapField(
    couple(requireString(raw, 'placeId'), requireEnum(raw, 'status', PLACE_STATUSES)),
    ([placeId, status]) => ({ kind: 'set-place-status', placeId, status: status as PlaceStatus }),
  )
}

/** Validate a provider-fact merge on one place. */
function parsePlaceFacts(raw: Record<string, unknown>): Parsed<TripPatchOp> {
  const placeId = requireString(raw, 'placeId')
  if (!placeId.ok) return placeId
  const photoUrl = optionalString(raw, 'photoUrl')
  if (!photoUrl.ok) return photoUrl
  const telephone = optionalString(raw, 'telephone')
  if (!telephone.ok) return telephone
  const address = optionalString(raw, 'address')
  if (!address.ok) return address
  if (photoUrl.value === undefined && telephone.value === undefined && address.value === undefined) {
    return fail('`set-place-facts` 至少需要 `photoUrl`、`telephone` 或 `address` 之一。')
  }
  return ok({
    kind: 'set-place-facts',
    placeId: placeId.value,
    ...photoUrl.value === undefined ? {} : { photoUrl: photoUrl.value },
    ...telephone.value === undefined ? {} : { telephone: telephone.value },
    ...address.value === undefined ? {} : { address: address.value },
  })
}

/** Validate an item insertion. */
function parseAddItem(raw: Record<string, unknown>): Parsed<TripPatchOp> {
  const dayId = requireString(raw, 'dayId')
  if (!dayId.ok) return dayId
  const item = parseItem(raw['item'])
  if (!item.ok) return item
  const afterItemId = optionalString(raw, 'afterItemId')
  if (!afterItemId.ok) return afterItemId
  return ok({
    kind: 'add-item',
    dayId: dayId.value,
    item: item.value,
    ...afterItemId.value === undefined ? {} : { afterItemId: afterItemId.value },
  })
}

/** Validate an operation that names one item. */
function parseItemRef(raw: Record<string, unknown>, kind: 'remove-item' | 'move-item'): Parsed<TripPatchOp> {
  const dayId = requireString(raw, 'dayId')
  if (!dayId.ok) return dayId
  const itemId = requireString(raw, 'itemId')
  if (!itemId.ok) return itemId
  if (kind === 'remove-item') return ok({ kind, dayId: dayId.value, itemId: itemId.value })
  const afterItemId = optionalString(raw, 'afterItemId')
  if (!afterItemId.ok) return afterItemId
  return ok({
    kind,
    dayId: dayId.value,
    itemId: itemId.value,
    ...afterItemId.value === undefined ? {} : { afterItemId: afterItemId.value },
  })
}

/** Validate a lock toggle. */
function parseItemLock(raw: Record<string, unknown>): Parsed<TripPatchOp> {
  const dayId = requireString(raw, 'dayId')
  if (!dayId.ok) return dayId
  const itemId = requireString(raw, 'itemId')
  if (!itemId.ok) return itemId
  if (typeof raw['locked'] !== 'boolean') return fail('字段 `locked` 必须是布尔值。')
  return ok({ kind: 'set-item-lock', dayId: dayId.value, itemId: itemId.value, locked: raw['locked'] })
}

/** Validate an item time update. */
function parseItemTime(raw: Record<string, unknown>): Parsed<TripPatchOp> {
  const dayId = requireString(raw, 'dayId')
  if (!dayId.ok) return dayId
  const itemId = requireString(raw, 'itemId')
  if (!itemId.ok) return itemId
  const startAt = optionalString(raw, 'startAt')
  if (!startAt.ok) return startAt
  const endAt = optionalString(raw, 'endAt')
  if (!endAt.ok) return endAt
  const duration = optionalNumber(raw, 'plannedDurationMinutes')
  if (!duration.ok) return duration
  if (duration.value !== undefined && duration.value < 0) return fail('`plannedDurationMinutes` 不能为负数。')
  if (startAt.value === undefined && endAt.value === undefined && duration.value === undefined) {
    return fail('`set-item-time` 至少需要 `startAt`、`endAt` 或 `plannedDurationMinutes` 之一。')
  }
  return ok({
    kind: 'set-item-time',
    dayId: dayId.value,
    itemId: itemId.value,
    ...startAt.value === undefined ? {} : { startAt: startAt.value },
    ...endAt.value === undefined ? {} : { endAt: endAt.value },
    ...duration.value === undefined ? {} : { plannedDurationMinutes: duration.value },
  })
}

/** Validate a day title update. */
function parseDayTitle(raw: Record<string, unknown>): Parsed<TripPatchOp> {
  const dayId = requireString(raw, 'dayId')
  if (!dayId.ok) return dayId
  const title = requireString(raw, 'title')
  if (!title.ok) return title
  const areaLabel = optionalString(raw, 'areaLabel')
  if (!areaLabel.ok) return areaLabel
  return ok({
    kind: 'set-day-title',
    dayId: dayId.value,
    title: title.value,
    ...areaLabel.value === undefined ? {} : { areaLabel: areaLabel.value },
  })
}

/** Validate one place literal. */
function parsePlace(value: unknown): Parsed<TripPlace> {
  if (!isRecord(value)) return fail('字段 `place` 必须是对象。')
  const id = requireString(value, 'id')
  if (!id.ok) return id
  const name = requireString(value, 'name')
  if (!name.ok) return name
  const point = parsePoint(value['point'])
  if (!point.ok) return point
  const address = optionalString(value, 'address')
  if (!address.ok) return address
  const telephone = optionalString(value, 'telephone')
  if (!telephone.ok) return telephone
  const categories = optionalStringArray(value, 'categories')
  if (!categories.ok) return categories
  const providerPlaceId = optionalString(value, 'providerPlaceId')
  if (!providerPlaceId.ok) return providerPlaceId
  const status = optionalEnum(value, 'status', PLACE_STATUSES)
  if (!status.ok) return status
  const fetchedAt = optionalString(value, 'fetchedAt')
  if (!fetchedAt.ok) return fetchedAt
  return ok({
    id: id.value,
    name: name.value,
    address: address.value ?? '',
    point: point.value,
    ...telephone.value === undefined ? {} : { telephone: telephone.value },
    categories: categories.value ?? [],
    status: (status.value as PlaceStatus | undefined) ?? 'candidate',
    ...providerPlaceId.value === undefined ? {} : { providerPlaceId: providerPlaceId.value },
    source: {
      provider: providerPlaceId.value === undefined ? 'manual' : 'amap-cli',
      fetchedAt: fetchedAt.value ?? new Date(0).toISOString(),
    },
  })
}

/** Validate one point literal. */
function parsePoint(value: unknown, owner = 'point'): Parsed<GeoPoint> {
  if (!isRecord(value)) return fail(`字段 \`${owner}\` 必须是对象。`)
  const longitude = value['longitude']
  const latitude = value['latitude']
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return fail(`字段 \`${owner}.longitude\` 必须是 -180..180 之间的有限数字。`)
  }
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return fail(`字段 \`${owner}.latitude\` 必须是 -90..90 之间的有限数字。`)
  }
  return ok({ longitude, latitude, coordinateSystem: 'gcj02' })
}

/** Validate one itinerary item literal. */
function parseItem(value: unknown): Parsed<ItineraryItem> {
  if (!isRecord(value)) return fail('字段 `item` 必须是对象。')
  const id = requireString(value, 'id')
  if (!id.ok) return id
  const placeId = requireString(value, 'placeId')
  if (!placeId.ok) return placeId
  const startAt = optionalString(value, 'startAt')
  if (!startAt.ok) return startAt
  const endAt = optionalString(value, 'endAt')
  if (!endAt.ok) return endAt
  const duration = optionalNumber(value, 'plannedDurationMinutes')
  if (!duration.ok) return duration
  if (duration.value !== undefined && duration.value < 0) return fail('`item.plannedDurationMinutes` 不能为负数。')
  const notes = optionalStringArray(value, 'notes')
  if (!notes.ok) return notes
  return ok({
    id: id.value,
    placeId: placeId.value,
    ...startAt.value === undefined ? {} : { startAt: startAt.value },
    ...endAt.value === undefined ? {} : { endAt: endAt.value },
    ...duration.value === undefined ? {} : { plannedDurationMinutes: duration.value },
    locked: value['locked'] === true,
    notes: notes.value ?? [],
  })
}

/** Validate one route leg literal. */
function parseLeg(value: unknown): Parsed<RouteLeg> {
  if (!isRecord(value)) return fail('字段 `leg` 必须是对象。')
  const id = requireString(value, 'id')
  if (!id.ok) return id
  const fromItemId = requireString(value, 'fromItemId')
  if (!fromItemId.ok) return fromItemId
  const toItemId = requireString(value, 'toItemId')
  if (!toItemId.ok) return toItemId
  const mode = optionalEnum(value, 'mode', TRAVEL_MODES)
  if (!mode.ok) return mode
  if (mode.value === undefined) return fail(`字段 \`leg.mode\` 必须是 ${TRAVEL_MODES.join(' / ')} 之一。`)
  const distanceMeters = requireNumber(value, 'distanceMeters')
  if (!distanceMeters.ok) return distanceMeters
  const durationSeconds = requireNumber(value, 'durationSeconds')
  if (!durationSeconds.ok) return durationSeconds
  const tollsYuan = optionalNumber(value, 'tollsYuan')
  if (!tollsYuan.ok) return tollsYuan
  const freshness = optionalEnum(value, 'freshness', ['fresh', 'stale', 'failed'])
  if (!freshness.ok) return freshness
  const fetchedAt = optionalString(value, 'fetchedAt')
  if (!fetchedAt.ok) return fetchedAt
  const steps = parseSteps(value['steps'])
  if (!steps.ok) return steps
  return ok({
    id: id.value,
    fromItemId: fromItemId.value,
    toItemId: toItemId.value,
    mode: mode.value as TravelMode,
    distanceMeters: distanceMeters.value,
    durationSeconds: durationSeconds.value,
    ...tollsYuan.value === undefined ? {} : { tollsYuan: tollsYuan.value },
    steps: steps.value,
    freshness: (freshness.value as RouteLeg['freshness'] | undefined) ?? 'fresh',
    source: { provider: 'amap-cli', fetchedAt: fetchedAt.value ?? new Date(0).toISOString() },
  })
}

/** Validate one end of a transit: a place id, a label, or both. */
function parseTransitEnd(value: unknown, field: string): Parsed<TransitEnd> {
  if (!isRecord(value)) return fail(`字段 \`${field}\` 必须是对象。`)
  const placeId = optionalString(value, 'placeId')
  if (!placeId.ok) return placeId
  const label = optionalString(value, 'label')
  if (!label.ok) return label
  if (placeId.value === undefined && (label.value === undefined || label.value === '')) {
    return fail(`字段 \`${field}\` 需要 placeId 或 label 至少一个。`)
  }
  // An end that names no place may still carry the coordinate a geocode gave it.
  const point = value['point'] === undefined ? ok<GeoPoint | undefined>(undefined) : parsePoint(value['point'], `${field}.point`)
  if (!point.ok) return point
  return ok({
    ...placeId.value === undefined ? {} : { placeId: placeId.value },
    label: label.value?.trim() ?? '',
    ...point.value === undefined ? {} : { point: point.value },
  })
}

/**
 * Validate a transit.
 *
 * Distance and duration stay optional: a day title that states 723 km becomes a
 * transit before anything has planned the road.
 */
function parseTransit(value: unknown): Parsed<TripTransit> {
  if (!isRecord(value)) return fail('字段 `transit` 必须是对象。')
  const id = requireString(value, 'id')
  if (!id.ok) return id
  const from = parseTransitEnd(value['from'], 'transit.from')
  if (!from.ok) return from
  const to = parseTransitEnd(value['to'], 'transit.to')
  if (!to.ok) return to
  const mode = optionalEnum(value, 'mode', TRAVEL_MODES)
  if (!mode.ok) return mode
  const distanceMeters = optionalNumber(value, 'distanceMeters')
  if (!distanceMeters.ok) return distanceMeters
  const durationSeconds = optionalNumber(value, 'durationSeconds')
  if (!durationSeconds.ok) return durationSeconds
  const tollsYuan = optionalNumber(value, 'tollsYuan')
  if (!tollsYuan.ok) return tollsYuan
  const departAt = optionalString(value, 'departAt')
  if (!departAt.ok) return departAt
  const arriveAt = optionalString(value, 'arriveAt')
  if (!arriveAt.ok) return arriveAt
  const polyline = optionalString(value, 'polyline')
  if (!polyline.ok) return polyline
  const freshness = optionalEnum(value, 'freshness', ['fresh', 'stale', 'failed'])
  if (!freshness.ok) return freshness
  const fetchedAt = optionalString(value, 'fetchedAt')
  if (!fetchedAt.ok) return fetchedAt
  const provider = optionalString(value, 'provider')
  if (!provider.ok) return provider
  const steps = parseSteps(value['steps'], 'transit')
  if (!steps.ok) return steps
  return ok({
    id: id.value,
    from: from.value,
    to: to.value,
    mode: (mode.value as TravelMode | undefined) ?? 'driving',
    ...distanceMeters.value === undefined ? {} : { distanceMeters: distanceMeters.value },
    ...durationSeconds.value === undefined ? {} : { durationSeconds: durationSeconds.value },
    ...departAt.value === undefined ? {} : { departAt: departAt.value },
    ...arriveAt.value === undefined ? {} : { arriveAt: arriveAt.value },
    ...tollsYuan.value === undefined ? {} : { tollsYuan: tollsYuan.value },
    steps: steps.value,
    freshness: (freshness.value as TripTransit['freshness'] | undefined) ?? 'stale',
    source:
      provider.value === 'title'
        ? { provider: 'title', fetchedAt: fetchedAt.value ?? new Date(0).toISOString() }
        : { provider: 'amap-cli', fetchedAt: fetchedAt.value ?? new Date(0).toISOString() },
    ...polyline.value === undefined || polyline.value === '' ? {} : { polyline: polyline.value },
  })
}

/** Validate a leg's steps. */
function parseSteps(value: unknown, owner = 'leg'): Parsed<readonly RouteStep[]> {
  if (value === undefined) return ok([])
  if (!Array.isArray(value)) return fail(`字段 \`${owner}.steps\` 必须是数组。`)
  const steps: RouteStep[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return fail(`每个 \`${owner}.steps\` 条目都必须是对象。`)
    const instruction = entry['instruction']
    if (typeof instruction !== 'string') return fail(`\`${owner}.steps[].instruction\` 必须是字符串。`)
    const distance = typeof entry['distanceMeters'] === 'number' ? entry['distanceMeters'] : 0
    const duration = typeof entry['durationSeconds'] === 'number' ? entry['durationSeconds'] : 0
    steps.push({ instruction, distanceMeters: Math.max(0, distance), durationSeconds: Math.max(0, duration) })
  }
  return ok(steps)
}

/** Validate one day literal. */
function parseDay(value: unknown): Parsed<TripDay> {
  if (!isRecord(value)) return fail('字段 `day` 必须是对象。')
  const id = requireString(value, 'id')
  if (!id.ok) return id
  const date = requireString(value, 'date')
  if (!date.ok) return date
  const title = optionalString(value, 'title')
  if (!title.ok) return title
  const areaLabel = optionalString(value, 'areaLabel')
  if (!areaLabel.ok) return areaLabel
  const items = value['items']
  if (items !== undefined && !Array.isArray(items)) return fail('字段 `day.items` 必须是数组。')
  const legs = value['legs']
  if (legs !== undefined && !Array.isArray(legs)) return fail('字段 `day.legs` 必须是数组。')
  return ok({
    id: id.value,
    date: date.value,
    title: title.value ?? date.value,
    ...areaLabel.value === undefined ? {} : { areaLabel: areaLabel.value },
    items: [],
    legs: [],
  })
}

/** Whether a value is a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Wrap a success. */
function ok<T>(value: T): Parsed<T> {
  return { ok: true, value }
}

/** Wrap a failure. */
function fail<T>(message: string): Parsed<T> {
  return { ok: false, message }
}

/** Map a parsed value into another parsed value. */
function mapField<S, T>(source: Parsed<S>, map: (value: S) => T): Parsed<T> {
  return source.ok ? ok(map(source.value)) : source
}

/** Combine two parsed values. */
function couple<A, B>(left: Parsed<A>, right: Parsed<B>): Parsed<readonly [A, B]> {
  if (!left.ok) return left
  if (!right.ok) return right
  return ok([left.value, right.value] as const)
}

/** Require a non-empty string field. */
function requireString(record: Record<string, unknown>, key: string): Parsed<string> {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') return fail(`字段 \`${key}\` 必须是非空字符串。`)
  return ok(value.trim())
}

/** Read an optional string field. */
function optionalString(record: Record<string, unknown>, key: string): Parsed<string | undefined> {
  const value = record[key]
  if (value === undefined || value === null) return ok(undefined)
  if (typeof value !== 'string') return fail(`字段 \`${key}\` 必须是字符串。`)
  return ok(value)
}

/** Require a finite number field. */
function requireNumber(record: Record<string, unknown>, key: string): Parsed<number> {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`字段 \`${key}\` 必须是有限数字。`)
  return ok(value)
}

/** Read an optional finite number field. */
function optionalNumber(record: Record<string, unknown>, key: string): Parsed<number | undefined> {
  const value = record[key]
  if (value === undefined || value === null) return ok(undefined)
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`字段 \`${key}\` 必须是有限数字。`)
  return ok(value)
}

/** Require an enum member. */
function requireEnum(record: Record<string, unknown>, key: string, allowed: readonly string[]): Parsed<string> {
  const value = record[key]
  if (typeof value !== 'string' || !allowed.includes(value)) return fail(`字段 \`${key}\` 必须是 ${allowed.join(' / ')} 之一。`)
  return ok(value)
}

/** Read an optional enum member. */
function optionalEnum(record: Record<string, unknown>, key: string, allowed: readonly string[]): Parsed<string | undefined> {
  const value = record[key]
  if (value === undefined || value === null) return ok(undefined)
  if (typeof value !== 'string' || !allowed.includes(value)) return fail(`字段 \`${key}\` 必须是 ${allowed.join(' / ')} 之一。`)
  return ok(value)
}

/** Read an optional string array field. */
function optionalStringArray(record: Record<string, unknown>, key: string): Parsed<readonly string[] | undefined> {
  const value = record[key]
  if (value === undefined || value === null) return ok(undefined)
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return fail(`字段 \`${key}\` 必须是字符串数组。`)
  }
  return ok(value as readonly string[])
}
