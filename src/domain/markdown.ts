/**
 * Deterministic Chinese Markdown rendering of a Trip Project.
 *
 * The renderer is a pure function of the project plus the caller-supplied
 * options: no clock reads, no I/O, and no mutation of the input. Wall-clock
 * values that carry an explicit offset are converted into the trip timezone;
 * offset-less values are printed literally so the export is host-independent.
 */

import type {
  AlertSeverity,
  ItineraryItem,
  RouteLeg,
  TravelMode,
  TripAlert,
  TripDay,
  TripPlace,
  TripProject,
  TripStatus,
} from './trip.js'

/** Chinese labels per trip status. */
const STATUS_LABELS = {
  idea: '构想中',
  drafting: '草稿中',
  checking: '校验中',
  'needs-attention': '待处理',
  ready: '已就绪',
  traveling: '旅途中',
  archived: '已归档',
} satisfies Readonly<Record<TripStatus, string>>

/** Chinese labels per travel mode. */
const MODE_LABELS = {
  walking: '步行',
  transit: '公交',
  riding: '骑行',
  driving: '驾车',
} satisfies Readonly<Record<TravelMode, string>>

/** Severity icon plus label used in the reminder section. */
const SEVERITY_LABELS = {
  error: '❌ 错误',
  warning: '⚠️ 警告',
  info: 'ℹ️ 提示',
} satisfies Readonly<Record<AlertSeverity, string>>

/** Matches an explicit UTC or numeric offset suffix such as `Z` or `+08:00`. */
const OFFSET_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/

/** Matches a bare `HH:mm` wall-clock fragment. */
const CLOCK_PATTERN = /^\d{2}:\d{2}$/

/**
 * Rendering options for {@link renderTripMarkdown}.
 */
export interface MarkdownOptions {
  /** Alerts to append as the reminder section; an empty list omits the section. */
  readonly alerts?: readonly TripAlert[]
  /** Generation timestamp echoed in the footer; omitted when not supplied. */
  readonly generatedAt?: string
}

/**
 * Renders a trip project as Chinese Markdown.
 *
 * @param project - Trip project to render; never mutated.
 * @param options - Optional alerts and generation timestamp.
 * @returns The Markdown document, ending with a newline.
 */
export function renderTripMarkdown(project: TripProject, options: MarkdownOptions = {}): string {
  const formatter = createClockFormatter(project.timezone)
  const sections: string[] = []

  sections.push(`# ${project.title.trim().length === 0 ? '未命名旅行' : project.title}`)
  sections.push(renderMetaBlock(project))

  const days = resolveActiveDays(project)
  days.forEach((day, index) => {
    sections.push(renderDay(day, index, project, formatter))
  })

  sections.push(renderBudget(project))
  if (options.alerts !== undefined && options.alerts.length > 0) {
    sections.push(renderAlerts(options.alerts))
  }
  sections.push(renderFooter(project, options.generatedAt))

  return `${sections.join('\n\n')}\n`
}

/**
 * Renders the meta block below the title.
 *
 * @param project - Trip project to describe.
 * @returns The meta bullet list.
 */
function renderMetaBlock(project: TripProject): string {
  const scenario = resolveActiveScenario(project)
  const lines = [
    `- 日期范围：${project.startDate} 至 ${project.endDate}`,
    `- 同行人：${project.travelers.length === 0 ? '未填写' : project.travelers.map((traveler) => traveler.label).join('、')}`,
    `- 目的地：${project.destinations.length === 0 ? '未设定' : project.destinations.join('、')}`,
    `- 当前方案：${scenario === undefined ? '未选择方案' : scenario.title}`,
    `- 状态：${labelFor(STATUS_LABELS, project.status)}（${project.status}）`,
    `- 预算：${describeBudgetSummary(project)}`,
  ]
  return lines.join('\n')
}

/**
 * Renders one day section.
 *
 * @param day - Day to render.
 * @param dayIndex - Zero-based position of the day inside the active scenario.
 * @param project - Trip project that owns the day.
 * @param formatter - Clock formatter for the trip timezone, when available.
 * @returns The day section.
 */
function renderDay(
  day: TripDay,
  dayIndex: number,
  project: TripProject,
  formatter: Intl.DateTimeFormat | undefined,
): string {
  const lines = [`## Day ${dayIndex + 1} · ${day.title}`]
  if (day.areaLabel !== undefined && day.areaLabel.length > 0) {
    lines.push('', `_区域：${day.areaLabel}_`)
  }

  if (day.items.length === 0) {
    lines.push('', '_当天没有安排_')
    return lines.join('\n')
  }

  lines.push('')
  day.items.forEach((item, itemIndex) => {
    lines.push(`- ${renderItemLine(day, item, project, formatter)}`)
    const next = day.items[itemIndex + 1]
    if (next !== undefined) {
      lines.push(`  - 交通：${describeTransport(day, item, next)}`)
    }
  })
  return lines.join('\n')
}

/**
 * Renders the bullet of one itinerary item.
 *
 * @param day - Day that owns the item.
 * @param item - Item to render.
 * @param project - Trip project that owns the place library.
 * @param formatter - Clock formatter for the trip timezone, when available.
 * @returns A single Markdown bullet line.
 */
function renderItemLine(
  day: TripDay,
  item: ItineraryItem,
  project: TripProject,
  formatter: Intl.DateTimeFormat | undefined,
): string {
  const parts = [
    `**${describeTimeRange(item, formatter)}**`,
    describePlace(project, item.placeId),
    describeCategories(project, item.placeId),
    `停留 ${item.plannedDurationMinutes === undefined ? '未设定' : `${item.plannedDurationMinutes} 分钟`}`,
  ]
  if (item.locked) parts.push('已锁定')
  return parts.join(' · ')
}

/**
 * Describes the transport leg between two consecutive items.
 *
 * @param day - Day that owns the leg.
 * @param from - Item the traveler leaves.
 * @param to - Item the traveler reaches next.
 * @returns Transport text such as `步行 1.2 km · 16 min`.
 */
function describeTransport(day: TripDay, from: ItineraryItem, to: ItineraryItem): string {
  const leg = day.legs.find((entry) => entry.fromItemId === from.id && entry.toItemId === to.id)
  if (leg === undefined) return '待规划'
  if (leg.freshness === 'failed') return '规划失败，需要重新规划'

  const text = describeLeg(leg)
  return leg.freshness === 'stale' ? `${text}（数据可能已过期）` : text
}

/**
 * Renders the transport summary for one leg.
 *
 * @param leg - Route leg to describe.
 * @returns Transport text such as `步行 1.2 km · 16 min`.
 */
function describeLeg(leg: RouteLeg): string {
  return `${labelFor(MODE_LABELS, leg.mode)} ${formatKilometers(leg.distanceMeters)} km · ${formatMinutes(leg.durationSeconds)} min`
}

/**
 * Renders the budget section.
 *
 * @param project - Trip project whose budget is rendered.
 * @returns The budget section.
 */
function renderBudget(project: TripProject): string {
  const { currency, limit, estimatedTotal, confirmedTotal } = project.budget
  const lines = ['## 预算', '', `- 币种：${currency}`]
  lines.push(`- 预算上限：${limit === undefined ? '未设置' : formatAmount(limit)}`)
  lines.push(`- 估算总额：${estimatedTotal === undefined ? '未估算' : formatAmount(estimatedTotal)}`)
  if (confirmedTotal !== undefined) {
    lines.push(`- 已确认支出：${formatAmount(confirmedTotal)}`)
  }
  if (limit !== undefined && estimatedTotal !== undefined) {
    const remaining = limit - estimatedTotal
    lines.push(
      remaining >= 0
        ? `- 预算结余：${formatAmount(remaining)}`
        : `- 预算超出：${formatAmount(-remaining)}`,
    )
  }
  return lines.join('\n')
}

/**
 * Renders the reminder section.
 *
 * @param alerts - Alerts to render, in the given order.
 * @returns The reminder section.
 */
function renderAlerts(alerts: readonly TripAlert[]): string {
  const lines = ['## 提醒', '']
  for (const alert of alerts) {
    const related =
      alert.relatedIds.length === 0 ? '' : `（相关：${alert.relatedIds.join(', ')}）`
    lines.push(`- ${labelFor(SEVERITY_LABELS, alert.severity)}：${alert.message}${related}`)
  }
  return lines.join('\n')
}

/**
 * Renders the document footer.
 *
 * @param project - Trip project that supplies the revision number.
 * @param generatedAt - Caller-supplied generation timestamp, when available.
 * @returns The footer block.
 */
function renderFooter(project: TripProject, generatedAt: string | undefined): string {
  const revision = `修订 r${project.revision}`
  const stamp = generatedAt === undefined ? revision : `生成时间：${generatedAt} · ${revision}`
  return `---\n\n_${stamp} · 地点与路线事实来自高德（AMap）。_`
}

/**
 * Renders the one-line budget summary used in the meta block.
 *
 * @param project - Trip project whose budget is summarized.
 * @returns Summary text such as `CNY 5000（估算 4200，已确认 1500）`.
 */
function describeBudgetSummary(project: TripProject): string {
  const { currency, limit, estimatedTotal, confirmedTotal } = project.budget
  if (limit === undefined && estimatedTotal === undefined && confirmedTotal === undefined) {
    return '未设置'
  }
  const details: string[] = []
  if (estimatedTotal !== undefined) details.push(`估算 ${formatAmount(estimatedTotal)}`)
  if (confirmedTotal !== undefined) details.push(`已确认 ${formatAmount(confirmedTotal)}`)
  const head = limit === undefined ? `${currency} 无上限` : `${currency} ${formatAmount(limit)}`
  return details.length === 0 ? head : `${head}（${details.join('，')}）`
}

/**
 * Renders the time range of one item.
 *
 * @param item - Item to describe.
 * @param formatter - Clock formatter for the trip timezone, when available.
 * @returns Text such as `09:00–11:00`, `09:00 起`, `至 11:00`, or `时间待定`.
 */
function describeTimeRange(
  item: ItineraryItem,
  formatter: Intl.DateTimeFormat | undefined,
): string {
  const start = item.startAt === undefined ? undefined : formatClock(item.startAt, formatter)
  const end = item.endAt === undefined ? undefined : formatClock(item.endAt, formatter)
  if (start !== undefined && end !== undefined) return `${start}–${end}`
  if (start !== undefined) return `${start} 起`
  if (end !== undefined) return `至 ${end}`
  return '时间待定'
}

/**
 * Renders the place name of an item, marking unknown ids.
 *
 * @param project - Trip project that owns the place library.
 * @param placeId - Place id referenced by the item.
 * @returns The place name, or `(未知地点 <id>)` when the place is unknown.
 */
function describePlace(project: TripProject, placeId: string): string {
  const place = project.places[placeId]
  return place === undefined ? `(未知地点 ${placeId})` : place.name
}

/**
 * Renders the category list of an item's place.
 *
 * @param project - Trip project that owns the place library.
 * @param placeId - Place id referenced by the item.
 * @returns Category text, or `未分类` when nothing is known.
 */
function describeCategories(project: TripProject, placeId: string): string {
  const place: TripPlace | undefined = project.places[placeId]
  if (place === undefined || place.categories.length === 0) return '未分类'
  return place.categories.join('、')
}

/**
 * Resolves the active scenario.
 *
 * @param project - Project to read.
 * @returns The active scenario, or undefined when the id does not resolve.
 */
function resolveActiveScenario(project: TripProject) {
  return project.scenarios.find((scenario) => scenario.id === project.activeScenarioId)
}

/**
 * Resolves the days of the active scenario.
 *
 * @param project - Project to read.
 * @returns The active scenario days, or an empty list when no scenario matches.
 */
function resolveActiveDays(project: TripProject): readonly TripDay[] {
  const scenario = resolveActiveScenario(project)
  return scenario === undefined ? [] : scenario.days
}

/**
 * Creates a fixed clock formatter for a trip timezone.
 *
 * @param timezone - IANA timezone name taken from the project.
 * @returns The formatter, or undefined when the timezone is unusable.
 */
function createClockFormatter(timezone: string): Intl.DateTimeFormat | undefined {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return undefined
  }
}

/**
 * Formats a timestamp as `HH:mm`.
 *
 * Values with an explicit offset are converted into the trip timezone; values
 * without an offset are already wall-clock local time and are printed as is.
 *
 * @param timestamp - Timestamp to format.
 * @param formatter - Clock formatter for the trip timezone, when available.
 * @returns The clock text, falling back to the raw timestamp when unparsable.
 */
function formatClock(timestamp: string, formatter: Intl.DateTimeFormat | undefined): string {
  const literal = extractLiteralClock(timestamp)
  if (!OFFSET_SUFFIX.test(timestamp)) return literal ?? timestamp

  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime()) || formatter === undefined) return literal ?? timestamp
  return formatter.format(parsed)
}

/**
 * Extracts a bare `HH:mm` fragment from a timestamp.
 *
 * @param timestamp - Timestamp to read.
 * @returns The clock fragment, or undefined when absent.
 */
function extractLiteralClock(timestamp: string): string | undefined {
  const fragment = timestamp.slice(11, 16)
  return CLOCK_PATTERN.test(fragment) ? fragment : undefined
}

/**
 * Formats a distance in meters as kilometers.
 *
 * @param meters - Distance in meters.
 * @returns Kilometer text with at most one decimal, such as `1.2`.
 */
function formatKilometers(meters: number): string {
  if (!Number.isFinite(meters)) return '0'
  return `${Math.round((meters / 1000) * 10) / 10}`
}

/**
 * Formats a duration in seconds as minutes.
 *
 * @param seconds - Duration in seconds.
 * @returns Minute text such as `16`.
 */
function formatMinutes(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0'
  return `${Math.round(seconds / 60)}`
}

/**
 * Formats a money amount.
 *
 * @param value - Amount to format.
 * @returns The plain amount without grouping separators.
 */
function formatAmount(value: number): string {
  return Number.isFinite(value) ? `${value}` : '未填写'
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
