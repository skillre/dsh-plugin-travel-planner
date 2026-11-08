读取时机：跑 `travel_itinerary_validate` 后要解释告警、或要判断"改哪里才能把 readiness 提上去"时，读这份文件。

## 就绪度与排序

| 项 | 规则 |
|---|---|
| 公式 | `readiness = max(0, 1 − 0.25×error数 − 0.05×warning数)`，四舍五入到两位小数 |
| info | **不扣分** |
| 封顶 | error ≥4 条即为 0 |
| 排序 | severity（error→warning→info）→ `code` 字典序 → 第一个 `relatedId` → `alert.id` |
| 作用范围 | 只校验**激活方案**的天；`alerts` 里每条含 `id,severity,code,message,relatedIds[],suggestedActions[]` |
| 工具返回 | `travel_itinerary_validate` 一次最多回 20 条 alert，但 `errors/warnings/infos` 计数是全量 |
| 落盘 | validate 会把这份 alerts 回写进 `trip.json`（**revision 不变**） |

## 12 种 alert

| code | severity | 触发条件（含阈值） | alert id | 建议动作 |
|---|---|---|---|---|
| `PLACE_UNKNOWN` | error | 某天的 item 引用了不在 `places` 里的 `placeId`；**逐 item 一条** | `place-unknown:<dayId>:<itemId>` | 补全该地点坐标 / 移除该安排 |
| `TIME_OVERLAP` | error | 同一天中**同时有** `startAt` 与 `endAt` 的两项，区间按半开 `[start,end)` 相交；只有一个时间界的项不参与 | `time-overlap:<dayId>:<itemA>:<itemB>` | 调整其中一个的开始时间 / 移到其它天 |
| `MISSING_ROUTE` | warning | 相邻两项之间没有 `fromItemId`→`toItemId` **完全匹配**的 leg；**逐对一条** | `missing-route:<dayId>:<from>:<to>` | 规划这段交通 / 确认两地是否相邻 |
| `MISSING_TRANSIT` | info | 标题声明跨城（含 `→`/`->`/`—>`，且不是 `HH:MM → HH:MM`）**且**当天没有 transit **且**所有 leg 都不算真实移动。真实移动 = `distanceMeters ≥ 1000` **或** `durationSeconds ≥ 600` | `missing-transit:<dayId>` | 把标题那段路记为转场 / 用 `travel_route_plan` 规划后写入 |
| `ROUTE_FAILED` | error | 任一 leg/transit 的 `freshness === 'failed'` | `route-failed:<dayId>:<factId>` | 重新规划这段交通 / 改用其它方式 |
| `ROUTE_STALE` | info/warning（分档见下） | leg 或 transit 的 `source.fetchedAt` 早于 `now − 6h`（默认；**不可配置**）。**每天只出一条** | `route-stale:<dayId>` | 重算这一天交通 / 忽略本次提醒 |
| `DAY_OVERLOADED` | warning | `dayTotalSeconds + Σ转场时长 > 10h`。`dayTotalSeconds = Σleg.durationSeconds + Σ(item.plannedDurationMinutes × 60)`；**`startAt`/`endAt` 不参与** | `day-overloaded:<dayId>` | 减少一个安排 / 改用更快的交通方式 |
| `PACE_EXCEEDED` | warning | **仅当 `preferences.pace === 'relaxed'`**：`items > 5` **或** `dayTotalSeconds > 8h`（不含转场时长） | `pace-exceeded:<dayId>` | 减少一个安排 / 移到其它天 |
| `EMPTY_DAY` | info | 某天 `items` 与 `transits` **都**为空 | `empty-day:<dayId>` | 加入地点 / 记为转场 / 删除该天 |
| `BUDGET_UNKNOWN` | info | 设置了 `budget.limit` 但 `estimatedTotal` 为空。**命中后不再判超限** | `budget-unknown` | 生成一份预算估算 |
| `BUDGET_EXCEEDED` | warning | `estimatedTotal > limit`（**严格大于**）；`confirmedTotal` 不参与 | `budget-exceeded` | 压缩安排 / 上调上限 |
| `PLACE_FACT_STALE` | info | 地点 `source.fetchedAt` 早于 `now − 24h`（默认；**不可配置**）；**逐地点一条** | `place-fact-stale:<placeId>` | 重新查询该地点资料 |

**驾驶日变体**：`DAY_OVERLOADED` 触发时，若当天最长一段 `durationSeconds ≥ 当天全部移动时长 × 0.8` 且 `distanceMeters ≥ 100 km`，文案改为「单日驾驶偏长」，建议动作变为「中途加一晚住宿 / 两个人换着开」。leg 与 transit 一视同仁。

## 阈值常量

| 常量 | 值 | 用在哪 |
|---|---|---|
| 路线过期 | 6 小时 | `ROUTE_STALE` |
| 事实过期 | 24 小时 | `PLACE_FACT_STALE` |
| 单日总时长上限 | 10 小时 | `DAY_OVERLOADED`（含转场） |
| relaxed 在途上限 | 8 小时 | `PACE_EXCEEDED`（不含转场） |
| relaxed 项数上限 | 5 项 | `PACE_EXCEEDED` |
| 真实移动 | ≥1000 m 或 ≥600 s | `MISSING_TRANSIT`（与批量补全同一判据） |
| 驾驶日 framing | 最长段 ≥100 km 且占移动时长 ≥80% | `DAY_OVERLOADED` 文案变体 |
| adaptive 远/近 | >7 天不提醒、1–7 天 info、≤1 天 warning | `ROUTE_STALE` 分档 |

6h / 24h 两个阈值在插件配置里**没有出口**：配置只能改 `alerts.routeStaleMode`（默认 `adaptive`）。

## `routeStaleMode` 分档

| 模式 | 行为 |
|---|---|
| `adaptive`（默认） | 该天距今 `> 7` 天 → **不产生** `ROUTE_STALE`；`1–7` 天 → `info`；`≤ 1` 天（含已过去）→ `warning`；日期不可解析 → `warning` |
| `strict` | 只要过期就是 `warning`，与日期无关 |

注意：`adaptive` 下"没有 `ROUTE_STALE`"**不等于**路线是新的；离出发很远的行程不会因为路线过期而掉 readiness。

## 处理顺序（命令式）

1. 先清 `error`：`PLACE_UNKNOWN`（补地点或删 item）→ `TIME_OVERLAP`（改用 `set-item-time`；锁定项要先 `set-item-lock` 解锁）→ `ROUTE_FAILED`（重规划这一段）。
2. 再降 `warning`：`MISSING_ROUTE`（`travel_day_rebuild_legs` 或 `set-leg`）→ `DAY_OVERLOADED`（减项或换交通方式）→ `PACE_EXCEEDED`（仅 relaxed 节奏会出）→ `BUDGET_EXCEEDED`（改 `estimatedTotal` 或 `limit`）。
3. 最后看 `info`：`MISSING_TRANSIT`（`travel_day_set_transit`）、`EMPTY_DAY`、`BUDGET_UNKNOWN`、`PLACE_FACT_STALE`（`travel_place_refresh`）、`ROUTE_STALE`。
4. 处理完再跑一次 `travel_itinerary_validate` 报 readiness。

## 证据

- 常量与公式：`src/domain/validation.ts:44-51`（6h/24h/10h）、`:64-65`（1000m/600s）、`:73-85`（100km、80%、5 项、8h）、`:120-123`（7 天/1 天）、`:691-694`（readiness）
- code 定义：`src/domain/validation.ts:21-34`
- 触发条件：EMPTY_DAY `:222-231`、PLACE_UNKNOWN `:233-244`、MISSING_TRANSIT `:287-309`、TIME_OVERLAP `:323-356`、MISSING_ROUTE `:367-390`、ROUTE_FAILED/ROUTE_STALE `:418-480`、分档 `:491-522`、DAY_OVERLOADED/PACE_EXCEEDED `:533-599`、PLACE_FACT_STALE `:611-629`、BUDGET_* `:638-664`
- 排序：`src/domain/validation.ts:673-682`
- 20 条预览上限：`src/host/tools.ts:27,740-749`；validate 写盘：`src/host/travel-service.ts:1212-1216`
- 阈值不可配置：`src/host/config.ts:85-88`、`src/index.ts:124`
- 测试：`tests/domain.spec.ts:437-499`（10h 与 relaxed）、`:359-395`（adaptive/strict）、`:764-809`（预算与事实过期）、`:874-923`（readiness 与确定性）
