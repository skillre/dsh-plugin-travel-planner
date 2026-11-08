/**
 * Immutable structured patching of a Trip Project.
 *
 * Ops are applied in array order against the state produced by the previous
 * applied op. Every update is structurally copied: the input project is never
 * mutated and the returned project always owns fresh top-level objects for the
 * parts it changed. A rejected op is recorded and does not stop later ops.
 */

import type {
  BudgetSummary,
  ItineraryItem,
  PlaceStatus,
  RouteFreshness,
  RouteLeg,
  TravelMode,
  TravelPreferences,
  TripDay,
  TripPlace,
  TripProject,
  TripScenario,
  TripStatus,
  TripTransit,
} from './trip.js'
import { CURRENT_TRIP_SCHEMA_VERSION } from './trip.js'
import { ReflowOrderError, reflowDay, type ReflowResult } from './reflow.js'

/**
 * One structured edit request against a Trip Project.
 *
 * `dayId` always refers to a day of the currently active scenario.
 */
export type TripPatchOp =
  | { readonly kind: 'rename-trip'; readonly title: string }
  | { readonly kind: 'set-status'; readonly status: TripStatus }
  | { readonly kind: 'set-active-scenario'; readonly scenarioId: string }
  | {
      readonly kind: 'set-budget'
      readonly currency?: string
      readonly limit?: number
      readonly estimatedTotal?: number
      readonly confirmedTotal?: number
    }
  | { readonly kind: 'set-preferences'; readonly preferences: Partial<TravelPreferences> }
  | { readonly kind: 'add-place'; readonly place: TripPlace }
  | { readonly kind: 'set-place-status'; readonly placeId: string; readonly status: PlaceStatus }
  | {
      readonly kind: 'set-place-facts'
      readonly placeId: string
      readonly photoUrl?: string
      readonly telephone?: string
      readonly address?: string
    }
  | {
      readonly kind: 'add-item'
      readonly dayId: string
      readonly item: ItineraryItem
      readonly afterItemId?: string
    }
  | { readonly kind: 'remove-item'; readonly dayId: string; readonly itemId: string }
  | {
      readonly kind: 'move-item'
      readonly dayId: string
      readonly itemId: string
      readonly afterItemId?: string
    }
  | {
      readonly kind: 'set-item-lock'
      readonly dayId: string
      readonly itemId: string
      readonly locked: boolean
    }
  | {
      readonly kind: 'set-item-time'
      readonly dayId: string
      readonly itemId: string
      readonly startAt?: string
      readonly endAt?: string
      readonly plannedDurationMinutes?: number
    }
  | {
      readonly kind: 'set-day-title'
      readonly dayId: string
      readonly title: string
      readonly areaLabel?: string
    }
  | { readonly kind: 'set-leg'; readonly dayId: string; readonly leg: RouteLeg }
  | { readonly kind: 'remove-leg'; readonly dayId: string; readonly legId: string }
  | { readonly kind: 'set-day-transit'; readonly dayId: string; readonly transit: TripTransit }
  | { readonly kind: 'remove-day-transit'; readonly dayId: string; readonly transitId: string }
  | { readonly kind: 'add-day'; readonly day: TripDay }
  | { readonly kind: 'remove-day'; readonly dayId: string }
  | {
      readonly kind: 'set-trip-dates'
      readonly startDate: string
      readonly endDate?: string
      readonly redateDays?: boolean
    }
  | { readonly kind: 'reorder-day'; readonly dayId: string; readonly order: readonly string[] }
  | { readonly kind: 'reflow-day'; readonly dayId: string }

/**
 * One op that could not be applied.
 */
export interface PatchRejection {
  /** Zero-based position of the op inside the submitted list. */
  readonly index: number
  /** Op kind, mirroring `TripPatchOp['kind']`. */
  readonly kind: string
  /** Machine-readable rejection code. */
  readonly code: string
  /** Short Chinese explanation for the user. */
  readonly reason: string
}

/**
 * Result of one {@link applyTripPatch} call.
 */
export interface PatchOutcome {
  /** Project after all applied ops; the input object when nothing applied. */
  readonly project: TripProject
  /** Applied op labels such as `set-status:drafting` or `move-item:day1:item3`. */
  readonly applied: readonly string[]
  /** Rejected ops in submission order. */
  readonly rejected: readonly PatchRejection[]
  /** True when at least one op applied and the revision was bumped. */
  readonly changed: boolean
}

/**
 * Thrown when the caller's expected revision does not match the project.
 */
export class TripRevisionError extends Error {
  /** Stable error code used by callers to branch on this failure. */
  readonly code: 'REVISION_MISMATCH' = 'REVISION_MISMATCH'

  /** Revision the caller expected. */
  readonly expectedRevision: number

  /** Revision the project actually carries. */
  readonly actualRevision: number

  /**
   * @param expectedRevision - Revision supplied through the patch options.
   * @param actualRevision - Revision currently stored on the project.
   */
  constructor(expectedRevision: number, actualRevision: number) {
    super(`Trip revision mismatch: expected ${expectedRevision}, actual ${actualRevision}`)
    this.name = 'TripRevisionError'
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

/** Rejection code raised when a referenced day id is unknown. */
const CODE_UNKNOWN_DAY = 'UNKNOWN_DAY'
/** Rejection code raised when a referenced item id is unknown. */
const CODE_UNKNOWN_ITEM = 'UNKNOWN_ITEM'
/** Rejection code raised when a referenced place id is unknown. */
const CODE_UNKNOWN_PLACE = 'UNKNOWN_PLACE'
/** Rejection code raised when a referenced scenario id is unknown. */
const CODE_UNKNOWN_SCENARIO = 'UNKNOWN_SCENARIO'
/** Rejection code raised when an id already exists. */
const CODE_DUPLICATE_ID = 'DUPLICATE_ID'
/** Rejection code raised when a locked item blocks the operation. */
const CODE_ITEM_LOCKED = 'ITEM_LOCKED'
/** Rejection code raised for malformed op values. */
const CODE_INVALID_VALUE = 'INVALID_VALUE'

/** Known trip statuses, used for runtime validation of untrusted input. */
const TRIP_STATUSES: ReadonlySet<string> = new Set<TripStatus>([
  'idea',
  'drafting',
  'checking',
  'needs-attention',
  'ready',
  'traveling',
  'archived',
])

/** Known place statuses, used for runtime validation of untrusted input. */
const PLACE_STATUSES: ReadonlySet<string> = new Set<PlaceStatus>([
  'candidate',
  'planned',
  'excluded',
  'locked',
])

/** Known travel modes, used for runtime validation of untrusted input. */
const TRAVEL_MODES: ReadonlySet<string> = new Set<TravelMode>([
  'walking',
  'transit',
  'riding',
  'driving',
])

/** Known route freshness values, used for runtime validation of untrusted input. */
const ROUTE_FRESHNESS: ReadonlySet<string> = new Set<RouteFreshness>(['fresh', 'stale', 'failed'])

/** Known pace values, used for runtime validation of untrusted input. */
const PACES: ReadonlySet<string> = new Set<TravelPreferences['pace']>([
  'relaxed',
  'balanced',
  'intensive',
])

/** Strict `YYYY-MM-DD` shape; calendar validity is checked separately. */
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Milliseconds in one calendar day, used for whole-day date arithmetic. */
const MILLISECONDS_PER_DAY = 86_400_000

/** Chinese labels for trip statuses, used by {@link describePatchOps}. */
const STATUS_LABELS = {
  idea: '构想',
  drafting: '草稿',
  checking: '校验',
  'needs-attention': '待处理',
  ready: '就绪',
  traveling: '旅途中',
  archived: '归档',
} satisfies Readonly<Record<TripStatus, string>>

/** Chinese labels for travel modes, used by {@link describePatchOps}. */
const MODE_LABELS = {
  walking: '步行',
  transit: '公交',
  riding: '骑行',
  driving: '驾车',
} satisfies Readonly<Record<TravelMode, string>>

/** Chinese labels for preference fields, used by {@link describePatchOps}. */
const PREFERENCE_LABELS = {
  pace: '节奏',
  interests: '兴趣',
  avoid: '避开',
  preferredModes: '交通偏好',
  maximumWalkingMinutesPerLeg: '单段步行上限',
} satisfies Readonly<Record<keyof TravelPreferences, string>>

/** A type with the readonly modifiers of `T` removed, used for local building. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** Internal step result: either a new project plus label, or a rejection. */
type PatchStep =
  | { readonly ok: true; readonly project: TripProject; readonly label: string }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/**
 * Applies structured ops to a trip project.
 *
 * @param project - Source project; never mutated.
 * @param ops - Ops to apply in array order.
 * @param options - Evaluation timestamp and optional optimistic-concurrency revision.
 * @returns The patched project, applied op labels, and recorded rejections.
 * @throws TripRevisionError When `options.expectedRevision` differs from `project.revision`.
 */
export function applyTripPatch(
  project: TripProject,
  ops: readonly TripPatchOp[],
  options: { readonly now: string; readonly expectedRevision?: number },
): PatchOutcome {
  if (options.expectedRevision !== undefined && options.expectedRevision !== project.revision) {
    throw new TripRevisionError(options.expectedRevision, project.revision)
  }

  const applied: string[] = []
  const rejected: PatchRejection[] = []
  let working = project

  ops.forEach((op, index) => {
    const step = applyOp(working, op)
    if (step.ok) {
      working = step.project
      applied.push(step.label)
      return
    }
    rejected.push({ index, kind: op.kind, code: step.code, reason: step.reason })
  })

  const changed = applied.length > 0
  // A write may have added a field this build introduced, so the document
  // declares the version it is actually written at; reading is what has to
  // accept older ones.
  const next: TripProject = changed
    ? { ...working, schemaVersion: CURRENT_TRIP_SCHEMA_VERSION, revision: project.revision + 1, updatedAt: options.now }
    : working

  return { project: next, applied, rejected, changed }
}

/**
 * Describes what a patch would change, in user-facing Chinese.
 *
 * @param ops - Ops to describe, in order.
 * @returns One short description per op, in the same order.
 */
export function describePatchOps(ops: readonly TripPatchOp[]): readonly string[] {
  return ops.map((op) => describeOp(op))
}

/**
 * Dispatches one op to its implementation.
 *
 * @param project - Current project state.
 * @param op - Op to apply.
 * @returns The step result for this op.
 */
function applyOp(project: TripProject, op: TripPatchOp): PatchStep {
  switch (op.kind) {
    case 'rename-trip':
      return applyRenameTrip(project, op.title)
    case 'set-status':
      return applySetStatus(project, op.status)
    case 'set-active-scenario':
      return applySetActiveScenario(project, op.scenarioId)
    case 'set-budget':
      return applySetBudget(project, op)
    case 'set-preferences':
      return applySetPreferences(project, op.preferences)
    case 'add-place':
      return applyAddPlace(project, op.place)
    case 'set-place-status':
      return applySetPlaceStatus(project, op.placeId, op.status)
    case 'set-place-facts':
      return applySetPlaceFacts(project, op)
    case 'add-item':
      return applyAddItem(project, op.dayId, op.item, op.afterItemId)
    case 'remove-item':
      return applyRemoveItem(project, op.dayId, op.itemId)
    case 'move-item':
      return applyMoveItem(project, op.dayId, op.itemId, op.afterItemId)
    case 'set-item-lock':
      return applySetItemLock(project, op.dayId, op.itemId, op.locked)
    case 'set-item-time':
      return applySetItemTime(project, op.dayId, op.itemId, op)
    case 'set-day-title':
      return applySetDayTitle(project, op.dayId, op.title, op.areaLabel)
    case 'set-leg':
      return applySetLeg(project, op.dayId, op.leg)
    case 'remove-leg':
      return applyRemoveLeg(project, op.dayId, op.legId)
    case 'set-day-transit':
      return applySetDayTransit(project, op.dayId, op.transit)
    case 'remove-day-transit':
      return applyRemoveDayTransit(project, op.dayId, op.transitId)
    case 'add-day':
      return applyAddDay(project, op.day)
    case 'remove-day':
      return applyRemoveDay(project, op.dayId)
    case 'set-trip-dates':
      return applySetTripDates(project, op)
    case 'reorder-day':
      return applyReorderDay(project, op.dayId, op.order)
    case 'reflow-day':
      return applyReorderDay(project, op.dayId, undefined)
    default:
      return failed(CODE_INVALID_VALUE, '不支持的 patch 操作')
  }
}

/**
 * Builds a successful step.
 *
 * @param project - Project after the op.
 * @param label - Applied-op label recorded in the outcome.
 * @returns A success step.
 */
function succeeded(project: TripProject, label: string): PatchStep {
  return { ok: true, project, label }
}

/**
 * Builds a rejected step.
 *
 * @param code - Machine-readable rejection code.
 * @param reason - Short Chinese explanation.
 * @returns A failure step.
 */
function failed(code: string, reason: string): PatchStep {
  return { ok: false, code, reason }
}

/**
 * Applies `rename-trip`.
 *
 * @param project - Current project state.
 * @param title - New trip title.
 * @returns The step result.
 */
function applyRenameTrip(project: TripProject, title: string): PatchStep {
  const trimmed = title.trim()
  if (trimmed.length === 0) return failed(CODE_INVALID_VALUE, '行程标题不能为空')
  return succeeded({ ...project, title: trimmed }, `rename-trip:${trimmed}`)
}

/**
 * Applies `set-status`.
 *
 * @param project - Current project state.
 * @param status - Target trip status.
 * @returns The step result.
 */
function applySetStatus(project: TripProject, status: TripStatus): PatchStep {
  if (!TRIP_STATUSES.has(status)) {
    return failed(CODE_INVALID_VALUE, `未知的行程状态：${String(status)}`)
  }
  return succeeded({ ...project, status }, `set-status:${status}`)
}

/**
 * Applies `set-active-scenario`.
 *
 * @param project - Current project state.
 * @param scenarioId - Scenario to activate.
 * @returns The step result.
 */
function applySetActiveScenario(project: TripProject, scenarioId: string): PatchStep {
  const exists = project.scenarios.some((scenario) => scenario.id === scenarioId)
  if (!exists) return failed(CODE_UNKNOWN_SCENARIO, `方案 ${scenarioId} 不存在`)
  return succeeded({ ...project, activeScenarioId: scenarioId }, `set-active-scenario:${scenarioId}`)
}

/**
 * Applies `set-budget`.
 *
 * @param project - Current project state.
 * @param op - Budget op carrying the fields to update.
 * @returns The step result.
 */
function applySetBudget(project: TripProject, op: Extract<TripPatchOp, { kind: 'set-budget' }>): PatchStep {
  const hasField =
    op.currency !== undefined ||
    op.limit !== undefined ||
    op.estimatedTotal !== undefined ||
    op.confirmedTotal !== undefined
  if (!hasField) return failed(CODE_INVALID_VALUE, 'set-budget 至少需要提供一个字段')

  if (op.currency !== undefined && op.currency.trim().length === 0) {
    return failed(CODE_INVALID_VALUE, '货币代码不能为空')
  }
  for (const amount of [
    { name: '预算上限', value: op.limit },
    { name: '估算总额', value: op.estimatedTotal },
    { name: '已确认支出', value: op.confirmedTotal },
  ]) {
    if (amount.value === undefined) continue
    if (!Number.isFinite(amount.value) || amount.value < 0) {
      return failed(CODE_INVALID_VALUE, `${amount.name}不能为负数`)
    }
  }

  const next: Mutable<BudgetSummary> = { ...project.budget }
  if (op.currency !== undefined) next.currency = op.currency.trim()
  if (op.limit !== undefined) next.limit = op.limit
  if (op.estimatedTotal !== undefined) next.estimatedTotal = op.estimatedTotal
  if (op.confirmedTotal !== undefined) next.confirmedTotal = op.confirmedTotal

  return succeeded({ ...project, budget: next }, `set-budget:${next.currency}`)
}

/**
 * Applies `set-preferences` as a partial merge.
 *
 * @param project - Current project state.
 * @param preferences - Preference fields to update.
 * @returns The step result.
 */
function applySetPreferences(
  project: TripProject,
  preferences: Partial<TravelPreferences>,
): PatchStep {
  const provided = Object.keys(preferences)
  if (provided.length === 0) {
    return failed(CODE_INVALID_VALUE, 'set-preferences 至少需要提供一个字段')
  }

  const next: Mutable<TravelPreferences> = { ...project.preferences }

  if (preferences.pace !== undefined) {
    if (!PACES.has(preferences.pace)) {
      return failed(CODE_INVALID_VALUE, `未知的节奏：${String(preferences.pace)}`)
    }
    next.pace = preferences.pace
  }
  if (preferences.interests !== undefined) {
    if (!isStringArray(preferences.interests)) {
      return failed(CODE_INVALID_VALUE, '兴趣必须是字符串数组')
    }
    next.interests = [...preferences.interests]
  }
  if (preferences.avoid !== undefined) {
    if (!isStringArray(preferences.avoid)) {
      return failed(CODE_INVALID_VALUE, '回避项必须是字符串数组')
    }
    next.avoid = [...preferences.avoid]
  }
  if (preferences.preferredModes !== undefined) {
    if (!isStringArray(preferences.preferredModes)) {
      return failed(CODE_INVALID_VALUE, '交通偏好必须是字符串数组')
    }
    for (const mode of preferences.preferredModes) {
      if (!TRAVEL_MODES.has(mode)) {
        return failed(CODE_INVALID_VALUE, `未知的交通方式：${String(mode)}`)
      }
    }
    next.preferredModes = [...preferences.preferredModes]
  }
  if (preferences.maximumWalkingMinutesPerLeg !== undefined) {
    const limit = preferences.maximumWalkingMinutesPerLeg
    if (!Number.isFinite(limit) || limit < 0) {
      return failed(CODE_INVALID_VALUE, '单段步行上限必须是非负数')
    }
    next.maximumWalkingMinutesPerLeg = limit
  }

  const label = [...provided].sort().join('+')
  return succeeded({ ...project, preferences: next }, `set-preferences:${label}`)
}

/**
 * Applies `add-place`.
 *
 * @param project - Current project state.
 * @param place - Place to add to the project library.
 * @returns The step result.
 */
function applyAddPlace(project: TripProject, place: TripPlace): PatchStep {
  if (place.id.trim().length === 0) return failed(CODE_INVALID_VALUE, '地点 id 不能为空')
  if (project.places[place.id] !== undefined) {
    return failed(CODE_DUPLICATE_ID, `地点 ${place.id} 已存在`)
  }
  const places = { ...project.places, [place.id]: clonePlace(place) }
  return succeeded({ ...project, places }, `add-place:${place.id}`)
}

/**
 * Applies `set-place-status`.
 *
 * @param project - Current project state.
 * @param placeId - Place to update.
 * @param status - Target place status.
 * @returns The step result.
 */
function applySetPlaceStatus(
  project: TripProject,
  placeId: string,
  status: PlaceStatus,
): PatchStep {
  const place = project.places[placeId]
  if (place === undefined) return failed(CODE_UNKNOWN_PLACE, `地点 ${placeId} 不存在`)
  if (!PLACE_STATUSES.has(status)) {
    return failed(CODE_INVALID_VALUE, `未知的地点状态：${String(status)}`)
  }
  const places = { ...project.places, [placeId]: { ...place, status } }
  return succeeded({ ...project, places }, `set-place-status:${placeId}:${status}`)
}

/**
 * Applies `set-place-facts`, merging the provided provider facts onto a place.
 *
 * Only the fields the caller supplies are touched, so refreshing a photo never
 * disturbs an address the user edited by hand.
 *
 * @param project - Current project state.
 * @param op - Op carrying the place id and the fields to merge.
 * @returns The step result.
 */
function applySetPlaceFacts(project: TripProject, op: Extract<TripPatchOp, { kind: 'set-place-facts' }>): PatchStep {
  const place = project.places[op.placeId]
  if (place === undefined) return failed(CODE_UNKNOWN_PLACE, `地点 ${op.placeId} 不存在`)
  if (op.photoUrl === undefined && op.telephone === undefined && op.address === undefined) {
    return failed(CODE_INVALID_VALUE, 'set-place-facts 至少需要提供一个字段')
  }
  const next: Mutable<TripPlace> = { ...place }
  const touched: string[] = []
  if (op.photoUrl !== undefined) {
    const value = op.photoUrl.trim()
    if (value === '') delete next.photoUrl
    else next.photoUrl = value
    touched.push('photo')
  }
  if (op.telephone !== undefined) {
    const value = op.telephone.trim()
    if (value === '') delete next.telephone
    else next.telephone = value
    touched.push('tel')
  }
  if (op.address !== undefined) {
    next.address = op.address
    touched.push('address')
  }
  const places = { ...project.places, [op.placeId]: next }
  return succeeded({ ...project, places }, `set-place-facts:${op.placeId}:${touched.join('+')}`)
}

/**
 * Applies `add-item`.
 *
 * The referenced place id is not resolved here: a dangling place reference is
 * a validation concern (`PLACE_UNKNOWN`) rather than a patch rejection.
 *
 * @param project - Current project state.
 * @param dayId - Target day of the active scenario.
 * @param item - Item to insert.
 * @param afterItemId - Optional anchor item; when omitted the item is appended.
 * @returns The step result.
 */
function applyAddItem(
  project: TripProject,
  dayId: string,
  item: ItineraryItem,
  afterItemId: string | undefined,
): PatchStep {
  const found = lookupDay(project, dayId)
  if (found === undefined) return failed(CODE_UNKNOWN_DAY, `第 ${dayId} 天不存在`)
  if (item.id.trim().length === 0) return failed(CODE_INVALID_VALUE, '安排 id 不能为空')
  if (findItem(project, item.id) !== undefined) {
    return failed(CODE_DUPLICATE_ID, `安排 ${item.id} 已存在`)
  }

  const items = [...found.day.items]
  const inserted = cloneItem(item)
  if (afterItemId === undefined) {
    items.push(inserted)
  } else {
    const anchorIndex = items.findIndex((entry) => entry.id === afterItemId)
    if (anchorIndex < 0) {
      return failed(CODE_UNKNOWN_ITEM, `锚点安排 ${afterItemId} 不在第 ${dayId} 天`)
    }
    items.splice(anchorIndex + 1, 0, inserted)
  }

  const nextProject = replaceDay(project, found.scenario, { ...found.day, items })
  return succeeded(nextProject, `add-item:${dayId}:${item.id}`)
}

/**
 * Applies `remove-item` and drops the legs that referenced it.
 *
 * @param project - Current project state.
 * @param dayId - Target day of the active scenario.
 * @param itemId - Item to remove.
 * @returns The step result.
 */
function applyRemoveItem(project: TripProject, dayId: string, itemId: string): PatchStep {
  const found = lookupDay(project, dayId)
  if (found === undefined) return failed(CODE_UNKNOWN_DAY, `第 ${dayId} 天不存在`)
  const item = found.day.items.find((entry) => entry.id === itemId)
  if (item === undefined) return failed(CODE_UNKNOWN_ITEM, `安排 ${itemId} 不在第 ${dayId} 天`)
  if (item.locked) return failed(CODE_ITEM_LOCKED, `安排 ${itemId} 已锁定，需先解锁`)

  const items = found.day.items.filter((entry) => entry.id !== itemId)
  const legs = found.day.legs.filter(
    (leg) => leg.fromItemId !== itemId && leg.toItemId !== itemId,
  )
  const next = replaceDay(project, found.scenario, { ...found.day, items, legs })
  return succeeded(next, `remove-item:${dayId}:${itemId}`)
}

/**
 * Applies `move-item`.
 *
 * Moving an item directly after itself is a no-op that still counts as applied.
 *
 * @param project - Current project state.
 * @param dayId - Target day of the active scenario.
 * @param itemId - Item to move.
 * @param afterItemId - Optional anchor item; when omitted the item moves to the end.
 * @returns The step result.
 */
function applyMoveItem(
  project: TripProject,
  dayId: string,
  itemId: string,
  afterItemId: string | undefined,
): PatchStep {
  const found = lookupDay(project, dayId)
  if (found === undefined) return failed(CODE_UNKNOWN_DAY, `第 ${dayId} 天不存在`)
  const item = found.day.items.find((entry) => entry.id === itemId)
  if (item === undefined) return failed(CODE_UNKNOWN_ITEM, `安排 ${itemId} 不在第 ${dayId} 天`)
  if (item.locked) return failed(CODE_ITEM_LOCKED, `安排 ${itemId} 已锁定，需先解锁`)

  const label = `move-item:${dayId}:${itemId}`
  if (afterItemId === itemId) return succeeded(project, label)

  const remaining = found.day.items.filter((entry) => entry.id !== itemId)
  let insertIndex = remaining.length
  if (afterItemId !== undefined) {
    const anchorIndex = remaining.findIndex((entry) => entry.id === afterItemId)
    if (anchorIndex < 0) {
      return failed(CODE_UNKNOWN_ITEM, `锚点安排 ${afterItemId} 不在第 ${dayId} 天`)
    }
    insertIndex = anchorIndex + 1
  }
  const items = [...remaining.slice(0, insertIndex), item, ...remaining.slice(insertIndex)]
  const next = replaceDay(project, found.scenario, { ...found.day, items })
  return succeeded(next, label)
}

/**
 * Applies `set-item-lock`.
 *
 * @param project - Current project state.
 * @param dayId - Target day of the active scenario.
 * @param itemId - Item to lock or unlock.
 * @param locked - Target lock state.
 * @returns The step result.
 */
function applySetItemLock(
  project: TripProject,
  dayId: string,
  itemId: string,
  locked: boolean,
): PatchStep {
  const found = lookupDay(project, dayId)
  if (found === undefined) return failed(CODE_UNKNOWN_DAY, `第 ${dayId} 天不存在`)
  const item = found.day.items.find((entry) => entry.id === itemId)
  if (item === undefined) return failed(CODE_UNKNOWN_ITEM, `安排 ${itemId} 不在第 ${dayId} 天`)
  if (typeof locked !== 'boolean') return failed(CODE_INVALID_VALUE, 'locked 必须是布尔值')

  const items = found.day.items.map((entry) =>
    entry.id === itemId ? { ...entry, locked } : entry,
  )
  const next = replaceDay(project, found.scenario, { ...found.day, items })
  return succeeded(next, `set-item-lock:${dayId}:${itemId}:${locked ? 'locked' : 'unlocked'}`)
}

/**
 * Applies `set-item-time`.
 *
 * @param project - Current project state.
 * @param dayId - Target day of the active scenario.
 * @param itemId - Item to retime.
 * @param op - Op carrying the time fields to update.
 * @returns The step result.
 */
function applySetItemTime(
  project: TripProject,
  dayId: string,
  itemId: string,
  op: Extract<TripPatchOp, { kind: 'set-item-time' }>,
): PatchStep {
  const found = lookupDay(project, dayId)
  if (found === undefined) return failed(CODE_UNKNOWN_DAY, `第 ${dayId} 天不存在`)
  const item = found.day.items.find((entry) => entry.id === itemId)
  if (item === undefined) return failed(CODE_UNKNOWN_ITEM, `安排 ${itemId} 不在第 ${dayId} 天`)
  if (item.locked) return failed(CODE_ITEM_LOCKED, `安排 ${itemId} 已锁定，需先解锁`)

  const hasField =
    op.startAt !== undefined || op.endAt !== undefined || op.plannedDurationMinutes !== undefined
  if (!hasField) return failed(CODE_INVALID_VALUE, 'set-item-time 至少需要提供一个字段')

  if (op.startAt !== undefined && parseTimestamp(op.startAt) === undefined) {
    return failed(CODE_INVALID_VALUE, `开始时间无法解析：${op.startAt}`)
  }
  if (op.endAt !== undefined && parseTimestamp(op.endAt) === undefined) {
    return failed(CODE_INVALID_VALUE, `结束时间无法解析：${op.endAt}`)
  }
  if (op.plannedDurationMinutes !== undefined) {
    const duration = op.plannedDurationMinutes
    if (!Number.isFinite(duration) || duration < 0) {
      return failed(CODE_INVALID_VALUE, '停留时长必须是非负数')
    }
  }

  const nextStartAt = op.startAt ?? item.startAt
  const nextEndAt = op.endAt ?? item.endAt
  if (nextStartAt !== undefined && nextEndAt !== undefined) {
    const startMs = parseTimestamp(nextStartAt)
    const endMs = parseTimestamp(nextEndAt)
    if (startMs !== undefined && endMs !== undefined && endMs <= startMs) {
      return failed(CODE_INVALID_VALUE, '结束时间必须晚于开始时间')
    }
  }

  const updated: Mutable<ItineraryItem> = { ...item }
  if (op.startAt !== undefined) updated.startAt = op.startAt
  if (op.endAt !== undefined) updated.endAt = op.endAt
  if (op.plannedDurationMinutes !== undefined) {
    updated.plannedDurationMinutes = op.plannedDurationMinutes
  }

  const items = found.day.items.map((entry) => (entry.id === itemId ? updated : entry))
  const next = replaceDay(project, found.scenario, { ...found.day, items })
  return succeeded(next, `set-item-time:${dayId}:${itemId}`)
}

/**
 * Applies `set-day-title`.
 *
 * The op is refused while the day holds any locked item, because locked items
 * pin the day they belong to. An empty `areaLabel` clears the field.
 *
 * @param project - Current project state.
 * @param dayId - Target day of the active scenario.
 * @param title - New day title.
 * @param areaLabel - Optional area label; an empty string clears it.
 * @returns The step result.
 */
function applySetDayTitle(
  project: TripProject,
  dayId: string,
  title: string,
  areaLabel: string | undefined,
): PatchStep {
  const found = lookupDay(project, dayId)
  if (found === undefined) return failed(CODE_UNKNOWN_DAY, `第 ${dayId} 天不存在`)
  if (found.day.items.some((item) => item.locked)) {
    return failed(CODE_ITEM_LOCKED, `第 ${dayId} 天包含已锁定的安排，需先解锁`)
  }
  const trimmed = title.trim()
  if (trimmed.length === 0) return failed(CODE_INVALID_VALUE, '当天标题不能为空')

  const updated: Mutable<TripDay> = { ...found.day, title: trimmed }
  if (areaLabel !== undefined) {
    const area = areaLabel.trim()
    if (area.length === 0) delete updated.areaLabel
    else updated.areaLabel = area
  }

  const next = replaceDay(project, found.scenario, updated)
  return succeeded(next, `set-day-title:${dayId}:${trimmed}`)
}

/**
 * Applies `set-leg` as an upsert keyed by leg id.
 *
 * @param project - Current project state.
 * @param dayId - Target day of the active scenario.
 * @param leg - Route leg to insert or replace.
 * @returns The step result.
 */
function applySetLeg(project: TripProject, dayId: string, leg: RouteLeg): PatchStep {
  const found = lookupDay(project, dayId)
  if (found === undefined) return failed(CODE_UNKNOWN_DAY, `第 ${dayId} 天不存在`)
  if (leg.id.trim().length === 0) return failed(CODE_INVALID_VALUE, '交通段 id 不能为空')

  const hasFrom = found.day.items.some((item) => item.id === leg.fromItemId)
  if (!hasFrom) {
    return failed(CODE_UNKNOWN_ITEM, `交通段起点 ${leg.fromItemId} 不在第 ${dayId} 天`)
  }
  const hasTo = found.day.items.some((item) => item.id === leg.toItemId)
  if (!hasTo) {
    return failed(CODE_UNKNOWN_ITEM, `交通段终点 ${leg.toItemId} 不在第 ${dayId} 天`)
  }
  if (leg.fromItemId === leg.toItemId) {
    return failed(CODE_INVALID_VALUE, '交通段的起点和终点不能是同一项')
  }
  if (!TRAVEL_MODES.has(leg.mode)) {
    return failed(CODE_INVALID_VALUE, `未知的交通方式：${String(leg.mode)}`)
  }
  if (!ROUTE_FRESHNESS.has(leg.freshness)) {
    return failed(CODE_INVALID_VALUE, `未知的路线状态：${String(leg.freshness)}`)
  }
  if (!Number.isFinite(leg.distanceMeters) || leg.distanceMeters < 0) {
    return failed(CODE_INVALID_VALUE, '交通距离必须是非负数')
  }
  if (!Number.isFinite(leg.durationSeconds) || leg.durationSeconds < 0) {
    return failed(CODE_INVALID_VALUE, '交通时长必须是非负数')
  }

  const existingIndex = found.day.legs.findIndex((entry) => entry.id === leg.id)
  const stored = cloneLeg(leg)
  const legs =
    existingIndex < 0
      ? [...found.day.legs, stored]
      : found.day.legs.map((entry, index) => (index === existingIndex ? stored : entry))

  const next = replaceDay(project, found.scenario, { ...found.day, legs })
  return succeeded(next, `set-leg:${dayId}:${leg.id}`)
}

/**
 * Applies `remove-leg`.
 *
 * @param project - Current project state.
 * @param dayId - Target day of the active scenario.
 * @param legId - Leg to remove.
 * @returns The step result.
 */
function applyRemoveLeg(project: TripProject, dayId: string, legId: string): PatchStep {
  const found = lookupDay(project, dayId)
  if (found === undefined) return failed(CODE_UNKNOWN_DAY, `第 ${dayId} 天不存在`)
  const exists = found.day.legs.some((leg) => leg.id === legId)
  if (!exists) return failed(CODE_INVALID_VALUE, `交通段 ${legId} 不在第 ${dayId} 天`)

  const legs = found.day.legs.filter((leg) => leg.id !== legId)
  const next = replaceDay(project, found.scenario, { ...found.day, legs })
  return succeeded(next, `remove-leg:${dayId}:${legId}`)
}

/**
 * Applies `set-day-transit` as an upsert keyed by transit id.
 *
 * Unlike a leg, a transit is not tied to two of the day's own stops: it is how
 * the day changes city, and its ends may be places that are not on any day.
 *
 * @param project - Current project state.
 * @param dayId - Target day of the active scenario.
 * @param transit - Transit to insert or replace.
 * @returns The step result.
 */
function applySetDayTransit(project: TripProject, dayId: string, transit: TripTransit): PatchStep {
  const found = lookupDay(project, dayId)
  if (found === undefined) return failed(CODE_UNKNOWN_DAY, `第 ${dayId} 天不存在`)
  if (transit.id.trim().length === 0) return failed(CODE_INVALID_VALUE, '转场 id 不能为空')

  // A place id is enough on its own: the library knows what it is called. Check
  // that first, so a typo'd id is reported as an unknown place rather than as a
  // nameless end.
  for (const end of [transit.from, transit.to]) {
    if (end.placeId !== undefined && project.places[end.placeId] === undefined) {
      return failed(CODE_UNKNOWN_PLACE, `转场端点 ${end.placeId} 不在地点库里`)
    }
    // A geocoded coordinate is ordinary end data, not a place: 「西安」 stays a
    // name and gains the point its geocode produced. Only its range is checked,
    // because a bad number is what would make the map draw nonsense.
    if (end.point !== undefined) {
      const { longitude, latitude } = end.point
      if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        return failed(CODE_INVALID_VALUE, '转场端点的经度必须在 -180..180 之间')
      }
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        return failed(CODE_INVALID_VALUE, '转场端点的纬度必须在 -90..90 之间')
      }
    }
  }
  const labelOf = (end: { readonly placeId?: string; readonly label: string }): string =>
    end.label.trim() !== '' ? end.label.trim() : (end.placeId === undefined ? '' : (project.places[end.placeId]?.name ?? ''))
  const from = labelOf(transit.from)
  const to = labelOf(transit.to)
  if (from.length === 0 || to.length === 0) {
    return failed(CODE_INVALID_VALUE, '转场的起点和终点都要有名称')
  }
  if (!TRAVEL_MODES.has(transit.mode)) {
    return failed(CODE_INVALID_VALUE, `未知的交通方式：${String(transit.mode)}`)
  }
  if (!ROUTE_FRESHNESS.has(transit.freshness)) {
    return failed(CODE_INVALID_VALUE, `未知的路线状态：${String(transit.freshness)}`)
  }
  if (transit.distanceMeters !== undefined && (!Number.isFinite(transit.distanceMeters) || transit.distanceMeters < 0)) {
    return failed(CODE_INVALID_VALUE, '转场距离必须是非负数')
  }
  if (transit.durationSeconds !== undefined && (!Number.isFinite(transit.durationSeconds) || transit.durationSeconds < 0)) {
    return failed(CODE_INVALID_VALUE, '转场时长必须是非负数')
  }
  const transits = found.day.transits ?? []
  const existingIndex = transits.findIndex((entry) => entry.id === transit.id)
  const stored = cloneTransit({
    ...transit,
    from: { ...transit.from, label: from },
    to: { ...transit.to, label: to },
  })
  const nextTransits =
    existingIndex < 0
      ? [...transits, stored]
      : transits.map((entry, index) => (index === existingIndex ? stored : entry))

  const next = replaceDay(project, found.scenario, { ...found.day, transits: nextTransits })
  return succeeded(next, `set-day-transit:${dayId}:${transit.id}`)
}

/**
 * Applies `remove-day-transit`.
 *
 * @param project - Current project state.
 * @param dayId - Target day of the active scenario.
 * @param transitId - Transit to remove.
 * @returns The step result.
 */
function applyRemoveDayTransit(project: TripProject, dayId: string, transitId: string): PatchStep {
  const found = lookupDay(project, dayId)
  if (found === undefined) return failed(CODE_UNKNOWN_DAY, `第 ${dayId} 天不存在`)
  const transits = found.day.transits ?? []
  if (!transits.some((transit) => transit.id === transitId)) {
    return failed(CODE_INVALID_VALUE, `转场 ${transitId} 不在第 ${dayId} 天`)
  }
  const nextTransits = transits.filter((transit) => transit.id !== transitId)
  const updated: Mutable<TripDay> = { ...found.day }
  if (nextTransits.length === 0) delete updated.transits
  else updated.transits = nextTransits
  const next = replaceDay(project, found.scenario, updated)
  return succeeded(next, `remove-day-transit:${dayId}:${transitId}`)
}

/**
 * Applies `add-day`, appending the new day to the active scenario.
 *
 * @param project - Current project state.
 * @param day - Day to append.
 * @returns The step result.
 */
function applyAddDay(project: TripProject, day: TripDay): PatchStep {
  const scenario = findActiveScenario(project)
  if (scenario === undefined) return failed(CODE_UNKNOWN_SCENARIO, '当前没有激活的方案')
  if (day.id.trim().length === 0) return failed(CODE_INVALID_VALUE, '日期 id 不能为空')
  const duplicate = project.scenarios.some((entry) =>
    entry.days.some((existing) => existing.id === day.id),
  )
  if (duplicate) return failed(CODE_DUPLICATE_ID, `日期 ${day.id} 已存在`)

  const days = [...scenario.days, cloneDay(day)]
  return succeeded(replaceScenario(project, { ...scenario, days }), `add-day:${day.id}`)
}

/**
 * Applies `remove-day`.
 *
 * @param project - Current project state.
 * @param dayId - Day to remove from the active scenario.
 * @returns The step result.
 */
function applyRemoveDay(project: TripProject, dayId: string): PatchStep {
  const found = lookupDay(project, dayId)
  if (found === undefined) return failed(CODE_UNKNOWN_DAY, `第 ${dayId} 天不存在`)
  if (found.day.items.some((item) => item.locked)) {
    return failed(CODE_ITEM_LOCKED, `第 ${dayId} 天包含已锁定的安排，需先解锁`)
  }

  const days = found.scenario.days.filter((entry) => entry.id !== dayId)
  return succeeded(replaceScenario(project, { ...found.scenario, days }), `remove-day:${dayId}`)
}

/**
 * Applies `reorder-day` / `reflow-day` through the deterministic re-timer.
 *
 * Reordering is allowed even when the day contains locked items: a locked item
 * keeps its own clock and re-anchors everything after it, which is the whole
 * point of pinning one. Moving a locked item therefore pins its time in the new
 * position, and any resulting clash surfaces as a `TIME_OVERLAP` alert rather
 * than as a silent shift of the user's decision.
 *
 * @param project - Current project state.
 * @param dayId - Day to re-order and re-time.
 * @param order - New item order, or undefined to re-time in place.
 * @returns The step result.
 */
function applyReorderDay(
  project: TripProject,
  dayId: string,
  order: readonly string[] | undefined,
): PatchStep {
  const found = lookupDay(project, dayId)
  if (found === undefined) return failed(CODE_UNKNOWN_DAY, `第 ${dayId} 天不存在`)
  let result: ReflowResult
  try {
    result = reflowDay({
      day: found.day,
      places: project.places,
      ...order === undefined ? {} : { order },
      mode: project.preferences.preferredModes[0] ?? 'transit',
    })
  } catch (error) {
    if (error instanceof ReflowOrderError) return failed(CODE_INVALID_VALUE, error.message)
    throw error
  }
  if (result.unchanged) return succeeded(project, `${order === undefined ? 'reflow-day' : 'reorder-day'}:${dayId}:unchanged`)
  const next = replaceDay(project, found.scenario, result.day)
  return succeeded(
    next,
    `${order === undefined ? 'reflow-day' : 'reorder-day'}:${dayId}` +
      `:moved=${String(result.movedCount)}:retimed=${String(result.retimed.length)}`,
  )
}

/**
 * Applies `set-trip-dates`, optionally re-dating every day of the active
 * scenario from the new start date.
 *
 * Days are re-dated in scenario order, one calendar day apart, and each item
 * keeps its time of day: only the date prefix of `startAt`/`endAt` is
 * rewritten. Re-dating is a calendar shift of the whole plan, so locked items
 * move with their day instead of blocking the op; it never reorders or retimes
 * anything.
 *
 * When `redateDays` is not `false` and the scenario has days, the day count
 * decides the span: an explicit `endDate` that does not match is rejected so
 * the header range can never disagree with the days it contains.
 *
 * @param project - Current project state.
 * @param op - Op carrying the new range and the re-date switch.
 * @returns The step result.
 */
function applySetTripDates(
  project: TripProject,
  op: Extract<TripPatchOp, { kind: 'set-trip-dates' }>,
): PatchStep {
  const startText = op.startDate.trim()
  const startMs = parseCalendarDate(startText)
  if (startMs === undefined) {
    return failed(CODE_INVALID_VALUE, `开始日期必须是 YYYY-MM-DD 形式的真实日期：${op.startDate}`)
  }
  const redate = op.redateDays !== false
  const scenario = findActiveScenario(project)
  const days = scenario?.days ?? []

  let endMs: number
  if (op.endDate !== undefined) {
    const endText = op.endDate.trim()
    const parsed = parseCalendarDate(endText)
    if (parsed === undefined) {
      return failed(CODE_INVALID_VALUE, `结束日期必须是 YYYY-MM-DD 形式的真实日期：${op.endDate}`)
    }
    endMs = parsed
  } else if (redate && days.length > 0) {
    endMs = startMs + (days.length - 1) * MILLISECONDS_PER_DAY
  } else {
    const currentEndMs = parseCalendarDate(project.endDate)
    endMs = currentEndMs !== undefined && currentEndMs >= startMs ? currentEndMs : startMs
  }
  if (endMs < startMs) return failed(CODE_INVALID_VALUE, '结束日期不能早于开始日期')

  if (redate && days.length > 0 && endMs !== startMs + (days.length - 1) * MILLISECONDS_PER_DAY) {
    const expectedEnd = formatCalendarDate(startMs + (days.length - 1) * MILLISECONDS_PER_DAY)
    return failed(
      CODE_INVALID_VALUE,
      `日期区间与天数不匹配：当前方案共 ${String(days.length)} 天，${startText} 起应为 ${startText} ~ ${expectedEnd}。`,
    )
  }

  const startDate = formatCalendarDate(startMs)
  const endDate = formatCalendarDate(endMs)
  let next: TripProject = { ...project, startDate, endDate }
  if (redate && scenario !== undefined) {
    const redated = scenario.days.map((day, index) => {
      const date = formatCalendarDate(startMs + index * MILLISECONDS_PER_DAY)
      if (date === day.date) return day
      const updated: Mutable<TripDay> = {
        ...day,
        date,
        items: day.items.map((item) => shiftItemDate(item, day.date, date)),
      }
      // A transit belongs to the day it happens on: leaving its clocks behind
      // would leave the plan contradicting the date it sits under.
      if (day.transits !== undefined) {
        updated.transits = day.transits.map((transit) => shiftTransitDate(transit, day.date, date))
      }
      return updated
    })
    next = replaceScenario(next, { ...scenario, days: redated })
  }
  return succeeded(next, `set-trip-dates:${startDate}:${endDate}`)
}

/**
 * Moves one item's timestamps onto a new day, keeping its time of day.
 *
 * A timestamp that does not start with the old date is left untouched, so a
 * hand-edited or partially dated item cannot be corrupted by a re-date.
 *
 * @param item - Item to shift.
 * @param from - The day the item currently belongs to.
 * @param to - The day it moves to.
 * @returns The item, or the input when neither timestamp needed changing.
 */
function shiftItemDate(item: ItineraryItem, from: string, to: string): ItineraryItem {
  const startAt = replaceDatePrefix(item.startAt, from, to)
  const endAt = replaceDatePrefix(item.endAt, from, to)
  if (startAt === item.startAt && endAt === item.endAt) return item
  const shifted: Mutable<ItineraryItem> = { ...item }
  if (startAt === undefined) delete shifted.startAt
  else shifted.startAt = startAt
  if (endAt === undefined) delete shifted.endAt
  else shifted.endAt = endAt
  return shifted
}

/**
 * Moves one transit's clocks onto a new day, keeping their times of day.
 *
 * @param transit - Transit to shift.
 * @param from - The day it currently belongs to.
 * @param to - The day it moves to.
 * @returns The transit, or the input when neither clock needed changing.
 */
function shiftTransitDate(transit: TripTransit, from: string, to: string): TripTransit {
  const departAt = replaceDatePrefix(transit.departAt, from, to)
  // A night drive arrives on the following date, and that date moves with the
  // day it left: leaving it behind would put the arrival nine days away from the
  // departure.
  const arriveAt = replaceDatePrefix(
    replaceDatePrefix(transit.arriveAt, dayAfter(from), dayAfter(to)),
    from,
    to,
  )
  if (departAt === transit.departAt && arriveAt === transit.arriveAt) return transit
  const shifted: Mutable<TripTransit> = { ...transit }
  if (departAt === undefined) delete shifted.departAt
  else shifted.departAt = departAt
  if (arriveAt === undefined) delete shifted.arriveAt
  else shifted.arriveAt = arriveAt
  return shifted
}

/**
 * Replaces the leading `YYYY-MM-DD` of a timestamp.
 *
 * @param value - Timestamp to rewrite, if any.
 * @param from - Date prefix to replace.
 * @param to - Replacement date prefix.
 * @returns The rewritten timestamp, or the input when it does not carry `from`.
 */
function replaceDatePrefix(value: string | undefined, from: string, to: string): string | undefined {
  if (value === undefined) return undefined
  return value.startsWith(from) ? `${to}${value.slice(from.length)}` : value
}

/**
 * Parses a `YYYY-MM-DD` calendar date.
 *
 * @param value - Date text to parse.
 * @returns Milliseconds at UTC midnight, or undefined when the text is not a
 * real calendar date (including impossible ones such as `2026-02-31`).
 */
function parseCalendarDate(value: string): number | undefined {
  if (!CALENDAR_DATE_PATTERN.test(value)) return undefined
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(milliseconds)) return undefined
  // `Date.parse` rolls impossible dates over instead of rejecting them, so the
  // round trip is what decides whether the input named a real day.
  return formatCalendarDate(milliseconds) === value ? milliseconds : undefined
}

/**
 * Formats milliseconds as a `YYYY-MM-DD` calendar date.
 *
 * @param milliseconds - Milliseconds at UTC midnight.
 * @returns The date text.
 */
function dayAfter(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(parsed) ? formatCalendarDate(parsed + MILLISECONDS_PER_DAY) : date
}

function formatCalendarDate(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10)
}

/**
 * Resolves the active scenario.
 *
 * @param project - Project to read.
 * @returns The active scenario, or undefined when the id does not resolve.
 */
function findActiveScenario(project: TripProject): TripScenario | undefined {
  return project.scenarios.find((scenario) => scenario.id === project.activeScenarioId)
}

/**
 * Resolves a day inside the active scenario.
 *
 * @param project - Project to read.
 * @param dayId - Day id to resolve.
 * @returns The owning scenario and day, or undefined when either is missing.
 */
function lookupDay(
  project: TripProject,
  dayId: string,
): { readonly scenario: TripScenario; readonly day: TripDay } | undefined {
  const scenario = findActiveScenario(project)
  if (scenario === undefined) return undefined
  const day = scenario.days.find((entry) => entry.id === dayId)
  if (day === undefined) return undefined
  return { scenario, day }
}

/**
 * Replaces one day inside a scenario.
 *
 * @param project - Project to copy.
 * @param scenario - Scenario that owns the day.
 * @param day - New day value; the day with the same id is replaced.
 * @returns A new project with the updated day.
 */
function replaceDay(project: TripProject, scenario: TripScenario, day: TripDay): TripProject {
  const days = scenario.days.map((entry) => (entry.id === day.id ? day : entry))
  return replaceScenario(project, { ...scenario, days })
}

/**
 * Replaces one scenario inside a project.
 *
 * @param project - Project to copy.
 * @param scenario - New scenario value; the scenario with the same id is replaced.
 * @returns A new project with the updated scenario.
 */
function replaceScenario(project: TripProject, scenario: TripScenario): TripProject {
  const scenarios = project.scenarios.map((entry) =>
    entry.id === scenario.id ? scenario : entry,
  )
  return { ...project, scenarios }
}

/**
 * Finds an item by id across every scenario and day.
 *
 * @param project - Project to search.
 * @param itemId - Item id to find.
 * @returns The first matching item, or undefined when the id is unused.
 */
function findItem(project: TripProject, itemId: string): ItineraryItem | undefined {
  for (const scenario of project.scenarios) {
    for (const day of scenario.days) {
      const item = day.items.find((entry) => entry.id === itemId)
      if (item !== undefined) return item
    }
  }
  return undefined
}

/**
 * Parses an ISO timestamp.
 *
 * @param value - Timestamp text to parse.
 * @returns Milliseconds since the epoch, or undefined when unparsable.
 */
function parseTimestamp(value: string): number | undefined {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? milliseconds : undefined
}

/**
 * Checks a runtime value for being an array of strings.
 *
 * @param value - Value to check.
 * @returns True when the value is an array whose entries are all strings.
 */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')
}

/**
 * Copies a place so the returned project owns its own nested objects.
 *
 * @param place - Place to copy.
 * @returns A structurally equal, independently owned place.
 */
function clonePlace(place: TripPlace): TripPlace {
  return {
    ...place,
    point: { ...place.point },
    categories: [...place.categories],
    source: { ...place.source },
  }
}

/**
 * Copies an itinerary item.
 *
 * @param item - Item to copy.
 * @returns A structurally equal, independently owned item.
 */
function cloneItem(item: ItineraryItem): ItineraryItem {
  return { ...item, notes: [...item.notes] }
}

/**
 * Copies a route leg.
 *
 * @param leg - Leg to copy.
 * @returns A structurally equal, independently owned leg.
 */
function cloneLeg(leg: RouteLeg): RouteLeg {
  return {
    ...leg,
    steps: leg.steps.map((step) => ({ ...step })),
    source: { ...leg.source },
  }
}

/**
 * Copies a day together with its items and legs.
 *
 * @param day - Day to copy.
 * @returns A structurally equal, independently owned day.
 */
function cloneDay(day: TripDay): TripDay {
  return {
    ...day,
    items: day.items.map(cloneItem),
    legs: day.legs.map(cloneLeg),
    ...day.transits === undefined ? {} : { transits: day.transits.map(cloneTransit) },
  }
}

/**
 * Copies a transit, ends and steps included.
 *
 * @param transit - Transit to copy.
 * @returns A structurally equal, independently owned transit.
 */
function cloneTransit(transit: TripTransit): TripTransit {
  return {
    ...transit,
    from: { ...transit.from, ...transit.from.point === undefined ? {} : { point: { ...transit.from.point } } },
    to: { ...transit.to, ...transit.to.point === undefined ? {} : { point: { ...transit.to.point } } },
    steps: transit.steps.map((step) => ({ ...step })),
    source: { ...transit.source },
  }
}

/**
 * Describes one op in user-facing Chinese.
 *
 * @param op - Op to describe.
 * @returns A short description of the intended change.
 */
function describeOp(op: TripPatchOp): string {
  switch (op.kind) {
    case 'rename-trip':
      return `把行程重命名为「${op.title}」`
    case 'set-status':
      return `把状态改为「${labelFor(STATUS_LABELS, op.status)}」`
    case 'set-active-scenario':
      return `切换到方案 ${op.scenarioId}`
    case 'set-budget':
      return `更新预算（${describeBudgetFields(op)}）`
    case 'set-preferences':
      return `更新偏好（${describePreferenceFields(op.preferences)}）`
    case 'add-place':
      return `加入地点「${op.place.name}」`
    case 'set-place-status':
      return `把地点 ${op.placeId} 标记为「${op.status}」`
    case 'set-place-facts':
      return `更新地点 ${op.placeId} 的高德信息`
    case 'add-item':
      return `在第 ${op.dayId} 天加入安排 ${op.item.id}`
    case 'remove-item':
      return `移除第 ${op.dayId} 天的安排 ${op.itemId}`
    case 'move-item':
      return `把第 ${op.dayId} 天的 ${op.itemId} 移到${
        op.afterItemId === undefined ? '当天末尾' : `${op.afterItemId} 之后`
      }`
    case 'set-item-lock':
      return `${op.locked ? '锁定' : '解锁'}第 ${op.dayId} 天的安排 ${op.itemId}`
    case 'set-item-time':
      return `调整第 ${op.dayId} 天的安排 ${op.itemId} 的时间`
    case 'set-day-title':
      return `把第 ${op.dayId} 天的标题改为「${op.title}」`
    case 'set-leg':
      return `更新第 ${op.dayId} 天的交通段 ${op.leg.id}（${labelFor(MODE_LABELS, op.leg.mode)}）`
    case 'remove-leg':
      return `移除第 ${op.dayId} 天的交通段 ${op.legId}`
    case 'set-day-transit':
      return `记录第 ${op.dayId} 天的转场：${op.transit.from.label} → ${op.transit.to.label}（${labelFor(MODE_LABELS, op.transit.mode)}）`
    case 'remove-day-transit':
      return `移除第 ${op.dayId} 天的转场 ${op.transitId}`
    case 'add-day':
      return `新增一天 ${op.day.id}（${op.day.date}）`
    case 'remove-day':
      return `删除第 ${op.dayId} 天`
    case 'set-trip-dates':
      return `把行程日期改为 ${op.startDate}${op.endDate === undefined ? '' : ` ~ ${op.endDate}`}${
        op.redateDays === false ? '（各天日期不变）' : '（各天按顺序顺延）'
      }`
    case 'reorder-day':
      return `调整第 ${op.dayId} 天的顺序（${String(op.order.length)} 项）并按停留与交通时长重排时间`
    case 'reflow-day':
      return `重排第 ${op.dayId} 天的时间`
    default:
      return '未知操作'
  }
}

/**
 * Looks up a Chinese label and falls back to the raw value.
 *
 * @param labels - Label map keyed by enum value.
 * @param key - Enum value to resolve, possibly unknown at runtime.
 * @returns The matching label, or the key itself when no label exists.
 */
function labelFor(labels: Readonly<Record<string, string>>, key: string): string {
  return labels[key] ?? key
}

/**
 * Lists the budget fields an op touches.
 *
 * @param op - Budget op to describe.
 * @returns Chinese field names, or a marker when no field is present.
 */
function describeBudgetFields(op: Extract<TripPatchOp, { kind: 'set-budget' }>): string {
  const fields: string[] = []
  if (op.currency !== undefined) fields.push('币种')
  if (op.limit !== undefined) fields.push('预算上限')
  if (op.estimatedTotal !== undefined) fields.push('估算总额')
  if (op.confirmedTotal !== undefined) fields.push('已确认支出')
  return fields.length === 0 ? '无字段' : fields.join('、')
}

/**
 * Lists the preference fields an op touches.
 *
 * @param preferences - Partial preferences carried by the op.
 * @returns Chinese field names, or a marker when no field is present.
 */
function describePreferenceFields(preferences: Partial<TravelPreferences>): string {
  const fields = Object.keys(preferences).map((key) => labelFor(PREFERENCE_LABELS, key))
  return fields.length === 0 ? '无字段' : fields.join('、')
}
