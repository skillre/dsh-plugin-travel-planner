读取时机：需要判断"行程文件在哪、某个 id 怎么来的、字段能不能省、多个行程怎么选"时，读这份文件。

## 落盘布局

| 路径 | 内容 |
|---|---|
| `<会话 cwd>/.travel/projects/<tripId>/trip.json` | 行程文档（可读、可 diff、可版本控制） |
| `<会话 cwd>/.travel/projects/<tripId>/exports/itinerary.md` | Markdown 导出 |
| `<会话 cwd>/.travel/projects/<tripId>/exports/trip.json` | JSON 导出（与存储文档**同名、不同目录**） |
| `<会话 cwd>/.travel/state.json` | 当前行程选择（工作区默认 + 每会话覆盖） |

`.travel` 是 `workspaceSubdirectory` 的默认值，可配置。写入格式为 `JSON.stringify(project, null, 2)` + 换行；父目录由文件系统服务自动创建。工作区根 = 会话的 `header.cwd`，取不到时退回进程 `cwd`。

## `trip.json` 顶层结构

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | `2` | 当前版本；写入时会被改写成 2 |
| `id` | string | tripId，见下方 id 约定 |
| `revision` | 整数 | 乐观并发标记；任何有 op 生效的 patch 都 +1 |
| `title` / `status` / `timezone` | string | `status` ∈ `idea/drafting/checking/needs-attention/ready/traveling/archived`；新建为 `drafting` |
| `startDate` / `endDate` | `YYYY-MM-DD` | 含当天 |
| `destinations` | string[] | 目的地城市/地区 |
| `travelers` | 对象数组 | `{id,label,interests[],accessibilityNeeds[]}`；`accessibilityNeeds` **没有任何写入路径**，恒为 `[]` |
| `preferences` | 对象 | 见下 |
| `constraints` | 数组 | `{id,kind,description,locked}`；类型存在，但**没有任何写入路径**（恒为 `[]`） |
| `places` | 对象字典 | `placeId → 地点`，见下 |
| `scenarios` | 数组 | 每项 `{id,title,basedOnRevision,days[]}`；**只有 `main`**，没有新建方案的 op |
| `activeScenarioId` | string | 目前恒为 `main` |
| `budget` | 对象 | `{currency, limit?, estimatedTotal?, confirmedTotal?}` |
| `alerts` | 数组 | 最近一次校验结果；`travel_itinerary_validate` 会回写，patch 也会顺带回写（都不涨 revision） |
| `createdAt` / `updatedAt` | ISO 8601 | `updatedAt` 在 patch 生效时刷新 |

## 子结构

| 结构 | 字段 |
|---|---|
| `day` | `id`、`date`、`title`、`areaLabel?`、`items[]`、`legs[]`、`transits?` |
| `item` | `id`、`placeId`、`startAt?`、`endAt?`、`plannedDurationMinutes?`、`locked:boolean`、`notes[]` |
| `leg` | `id`、`fromItemId`、`toItemId`、`mode`（`walking/transit/riding/driving`）、`distanceMeters`、`durationSeconds`、`tollsYuan?`、`steps[]`、`freshness`（`fresh/stale/failed`）、`source{provider:'amap-cli'\|'manual',fetchedAt,providerVersion?}` |
| `transit` | `id`、`from`/`to`（`{placeId?,label,point?}`）、`mode`、`distanceMeters?`、`durationSeconds?`、`departAt?`、`arriveAt?`、`tollsYuan?`、`steps[]`、`freshness`、`source{provider:'amap-cli'\|'title'\|'manual',fetchedAt}`、`polyline?` |
| `place` | `id`、`providerPlaceId?`、`name`、`address`（空串=无）、`point{longitude,latitude,coordinateSystem:'gcj02'}`、`telephone?`、`photoUrl?`、`categories[]`、`status`（`candidate/planned/excluded/locked`）、`source{provider,fetchedAt}` |
| `preferences` | `pace`（`relaxed/balanced/intensive`）、`interests[]`、`avoid[]`、`preferredModes[]`（决定 rebuild/set-transit 的缺省出行方式）、`maximumWalkingMinutesPerLeg?` |
| `alert` | `id`、`severity`（`error/warning/info`）、`code`、`message`、`relatedIds[]`、`suggestedActions[]` |

坐标一律 GCJ-02（`coordinateSystem: 'gcj02'`）。`point` 只有 `longitude`/`latitude` 会被校验范围（±180 / ±90）。

## id 约定

| 对象 | 规则 |
|---|---|
| tripId | `slugify(title)` 前缀 + `-` + 6 位 FNV-1a 哈希（基于 `title\0startDate`，十六进制小写）。`slugify`：trim → 转小写 → 把**非 Unicode Letter/Number 的连续片段**折叠为单个 `-`（中文/日文等 Unicode 字母、数字被保留）→ 去首尾 `-` → 截断到 40 字符 → 再去尾部 `-`；结果为空回退 `trip`。例：`成都慢游 4 日` + `2026-10-01` → `成都慢游-4-日-b44b0e`；纯标点标题 `！！！` → `trip-deabe7` |
| day | `travel_project_create` 生成 `d1…dN`；`add-day` 的 id 由调用方给定 |
| item | **由模型给定**（`add-item` 必填 `item.id`）。仓库里存在 `itemIdFor()`（`d1-i0-<hash4>`）但除测试外没有调用点；`d1-i0` 只是习惯写法 |
| leg | `travel_day_rebuild_legs` 生成 `<dayId>-leg-<序号>`；手写 `set-leg` 时自定义，按 id upsert |
| transit | `travel_day_set_transit` / 批量补全生成 `<dayId>-transit-<N>`，N 取当天未被占用的最小序号；手写时自定义，按 id upsert |

## schemaVersion 兼容与文档校验

| 情况 | 行为 |
|---|---|
| 读取 `schemaVersion: 1` | 允许。v1 没有 `transits`，按空处理 |
| 读取 2 | 允许 |
| 读取其它版本 | 抛 `TRIP_SCHEMA_UNSUPPORTED` |
| JSON 解析失败 | 抛 `TRIP_INVALID_DOCUMENT` |
| 列表时遇到坏文档 | 跳过该条，其余行程照常列出；**单独读取**同一文档时才抛错 |
| 写入 | 只要 patch 生效，`schemaVersion` 改写为 2 |

文档校验只硬性检查：`schemaVersion` 属于 `[1,2]`、`id/title/startDate/endDate/activeScenarioId/updatedAt` 为非空字符串、`revision` 为整数、`scenarios` 为数组。其余字段缺失**不会**在读取时报错（下游按缺省处理）。

## `state.json` 与 tripId 解析顺序

`state.json` 结构：`{version:1, activeTripId?, sessions:{<sessionId>:<tripId>}, updatedAt}`。

解析顺序（省略 `tripId` 的工具、以及浏览器 API 的默认行程）：

1. **显式 `tripId`** → `selectionSource: 'explicit'`（**不校验存在性**，不存在时由后续读取抛 `TRIP_NOT_FOUND`）
2. 本会话在 `state.json.sessions` 里的记录 → `'session'`
3. `state.json.activeTripId`（工作区默认）→ `'workspace'`
4. 最近更新的行程 → `'recent'`

`state.json` 退化行为：

| 情况 | 行为 |
|---|---|
| 文件不存在 / 解析失败 / 不是对象 / `version ≠ 1` | 视为"从未记录过选择"，退回第 4 步（最近更新），**不报错、不需要迁移** |
| 记录指向已删除的行程（第 2、3 步） | 跳过该记录，继续往下一级 |
| `travel_project_select` | 写本会话记录；`asDefault:true` 时同时写 `activeTripId`；若此前没有工作区默认，**首次 select 会自动把它设为默认** |
| 目标行程不存在 | 抛 `TRIP_NOT_FOUND`，不修改 state.json |

另外：`travel_project_create` 会把新行程同时设为**本会话选择**与**工作区默认**。

## 工作区边界

- store 按"工作区根 + `workspaceSubdirectory`"建实例并缓存；同一进程内不同会话只要 cwd 相同就共用一份数据。
- 多行程共存在同一个 `.travel/` 下，只有 `state.json` 的指针按会话区分。
- 跨工作区互不可见：换目录就是另一份行程库。

## 导出

| format | 路径 | 内容 |
|---|---|---|
| `markdown` | `exports/itinerary.md` | 现场渲染：标题 / meta / 每天（先转场后逐项 + 交通行）/ 预算 / 提醒（本次校验结果）/ 页脚（含 `修订 rN`） |
| `json` | `exports/trip.json` | 当前读到的项目对象（含 `revision`、含文档里存的 `alerts`） |

导出**不写 `trip.json`、不改 revision**；文件名固定，重复导出直接覆盖。

## 注意

- `travelers` / `constraints` / `accessibilityNeeds` 目前没有任何写入路径，不要承诺能改。
- 方案只有 `main`；`set-active-scenario` 传别的 id 只会被拒。
- `trip.json` 的 `alerts` 是**缓存**：它只在 patch 或 validate 时更新，可能落后于当前数据；要最新结论就再跑一次 `travel_itinerary_validate`。
- `travel_project_create` 的返回体额外带 `activeTripId`，但该工具的 `output.schema` 未声明这一字段；运行时是否会因此被截断**未验证**。

## 证据

- 路径与写入格式：`src/host/trip-store.ts:107-114,188-193,177`；工作区拼接 `src/host/travel-service.ts:290-298`；会话 cwd `src/index.ts:157-166`
- 结构与字段：`src/domain/trip.ts:18-219`
- id 规则：`src/host/ids.ts:24-30`（slugify：Unicode 属性类正则 `/[^\p{Letter}\p{Number}]+/gu` 在 `:26`）、`:38-40`（tripIdFor 取哈希前 6 位）、`:49-51`（itemIdFor，除测试外无调用点）、`src/host/tools.ts:704`（`d1…dN`）、`src/host/travel-service.ts:671`（leg）、`:206-212`（transit）
- schemaVersion 与校验：`src/domain/trip.ts:8`、`src/host/trip-store.ts:76,289-313`、写入改写 `src/domain/patch.ts:285-287`
- 坏文档列表/读取行为：`src/host/trip-store.ts:120-157`
- `state.json` 结构与退化：`src/host/trip-store.ts:47-56,196-236`；解析顺序 `src/host/travel-service.ts:356-372`；写入与默认 `:382-401`；create 设为默认 `src/host/tools.ts:134`
- 导出：`src/host/travel-service.ts:601-612`、`src/domain/markdown.ts:71-90,261-265`
- 测试：`tests/host.spec.ts:338-499`（路径、round-trip、版本兼容、坏文档）、`:1741-1795`（解析顺序与退化）、`tests/domain.spec.ts:1393-1430`（写入版本与转场随天平移）
