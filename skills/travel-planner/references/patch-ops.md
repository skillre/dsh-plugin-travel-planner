读取时机：要写一次 `travel_project_patch`、或某个 op 被拒绝、或需要确认"锁定项会不会挡住这次修改"时，读这份文件。

## 批次语义（必读）

| 规则 | 说明 |
|---|---|
| 前置过滤 | 形状不合法的 op 在 host 层就变成 `violations:[{index,message}]`，**不会**进入域层；若过滤后没有 op，工具直接返回 `{applied:[],changed:false,violations}`，**连 `expectedRevision` 都不核对** |
| `expectedRevision` | 可选参数。与当前 `revision` 不等 → **在应用任何 op 之前**抛 `REVISION_MISMATCH`，整批拒绝、不落盘；工具层把它转成 `rejected:[{index:-1,kind:'batch',code:'REVISION_MISMATCH',reason}]`，并回带 `expectedRevision`/`actualRevision` |
| 执行顺序 | 按数组顺序逐条应用，每条作用于**前一条的结果** |
| **非事务** | 单条 op 被拒只记录进 `rejected[]`，**不影响后续 op**；前面已生效的改动会随整批一起落盘 |
| revision | `changed = 至少一条 op 生效`；changed 时 revision+1、`updatedAt` 刷新为当前时刻；全部被拒 → 不写盘、revision 与 `updatedAt` 不变 |
| version | changed 时文档 `schemaVersion` 被改写为 2 |
| 幂等性 | 没有任何 op 是"重复调用安全"的保证：`add-place`/`add-item` 重复 id 会被拒，`set-leg`/`set-day-transit` 按 id upsert |

## 拒绝码

| code | 含义 |
|---|---|
| `UNKNOWN_DAY` | 引用的 `dayId` 不在**当前激活方案**里 |
| `UNKNOWN_ITEM` | 引用的 `itemId`（或锚点 `afterItemId`）不在该天 |
| `UNKNOWN_PLACE` | 引用的 `placeId` 不在地点库 |
| `UNKNOWN_SCENARIO` | `scenarioId` 不存在，或没有激活方案 |
| `DUPLICATE_ID` | 地点 id 已存在；或 item id 已在**任意场景任意天**用过；或 day id 已在任意场景用过 |
| `ITEM_LOCKED` | 目标被锁定，或所在天含锁定项（见矩阵） |
| `INVALID_VALUE` | 取值非法（空串、负数、未知枚举、无法解析的时间、顺序不是排列…），也包括未知 `kind` |

## host 层形状校验（不满足即 `violations`）

| 规则 | 行为 |
|---|---|
| 必填字符串 | 非空字符串，**自动 trim**；空白 → 违规 |
| 可选字段 | `undefined` / `null` 视为未提供；类型不符 → 违规 |
| 数字 | 必须是有限数字；负数在多数字段被拒 |
| 枚举 | 必须在允许集合内，否则违规 |
| 字符串数组 | 每一项都必须是字符串 |
| `ops` 本身 | 不是数组 → `violations:[{index:-1,…}]` |

## 23 种 kind 全表

| kind | 形状（`?` = 可选） | 关键校验 / 拒绝 | locked 交互 |
|---|---|---|---|
| `rename-trip` | `title` 必填 | 空 → `INVALID_VALUE` | 无关 |
| `set-status` | `status` 必填，∈`idea/drafting/checking/needs-attention/ready/traveling/archived` | 未知 → `INVALID_VALUE` | 无关 |
| `set-active-scenario` | `scenarioId` 必填 | 不存在 → `UNKNOWN_SCENARIO`；目前只有 `main` | 无关 |
| `set-budget` | `currency?`、`limit?`、`estimatedTotal?`、`confirmedTotal?`，**至少一个** | 全空或负数 → `INVALID_VALUE` | 无关 |
| `set-preferences` | `preferences` 必填：`pace?`∈`relaxed/balanced/intensive`、`interests?`/`avoid?`/`preferredModes?` 字符串数组、`maximumWalkingMinutesPerLeg?`≥0，**至少一个字段** | 空/类型错/未知 mode → `INVALID_VALUE`；⚠️ **只有 `pace`（仅 `relaxed`）与 `preferredModes[0]` 有行为**，`avoid`/`interests`/`maximumWalkingMinutesPerLeg` 写得进去但**全库无读取方**（不告警/不重排/不影响搜索）——不要对用户说"插件会按它约束" | 无关 |
| `add-place` | `place` 必填：`id`、`name`、`point{longitude,latitude}`；`address?`(缺省 `''`)、`categories?`(缺省 `[]`)、`status?`(缺省 `candidate`)、`providerPlaceId?`、`telephone?`、`fetchedAt?` | id 空 → `INVALID_VALUE`；id 已存在 → `DUPLICATE_ID`；缺 `fetchedAt` → 写成 1970 → 立刻 `PLACE_FACT_STALE` | 无关 |
| `set-place-status` | `placeId`、`status` 必填（∈`candidate/planned/excluded/locked`） | 地点不存在 → `UNKNOWN_PLACE`；未知状态 → `INVALID_VALUE` | 无关（与 item 锁无关） |
| `set-place-facts` | `placeId` 必填 + `photoUrl?`/`telephone?`/`address?` 至少一个 | 全空 → `INVALID_VALUE`；`photoUrl:''`、`telephone:''` = **删除该字段** | 无关 |
| `add-item` | `dayId`、`item` 必填（`item.id`、`item.placeId` 必填；`startAt?`、`endAt?`、`plannedDurationMinutes?`≥0、`locked?`、`notes?`）；`afterItemId?`（省略=追加到末尾） | 天不存在 `UNKNOWN_DAY`；item id 重复 `DUPLICATE_ID`；锚点不在当天 `UNKNOWN_ITEM`；`item.placeId` **不做存在性检查**（由告警 `PLACE_UNKNOWN` 兜底） | 新建项可自带 `locked:true`；与既有锁定项无关 |
| `remove-item` | `dayId`、`itemId` 必填 | 天/项不存在 | 目标锁定 → `ITEM_LOCKED`；同时删掉引用该 item 的 leg |
| `move-item` | `dayId`、`itemId` 必填；`afterItemId?` | 天/项/锚点不存在 | 目标锁定 → `ITEM_LOCKED`；`afterItemId === itemId` 视为已应用的 no-op |
| `set-item-lock` | `dayId`、`itemId`、`locked:boolean` 必填 | 天/项不存在；非布尔 → `INVALID_VALUE` | **唯一能解锁的 op** |
| `set-item-time` | `dayId`、`itemId` 必填 + `startAt?`/`endAt?`/`plannedDurationMinutes?` 至少一个 | 时间不可解析、`endAt <= startAt`、时长<0 → `INVALID_VALUE` | 目标锁定 → `ITEM_LOCKED` |
| `set-day-title` | `dayId`、`title` 必填；`areaLabel?`（空串 = 清除该字段） | 空标题 → `INVALID_VALUE` | **当天有任意锁定项 → `ITEM_LOCKED`**（最容易被忽略的一条） |
| `set-leg` | `dayId`、`leg` 必填：`id`、`fromItemId`、`toItemId`、`mode`、`distanceMeters`、`durationSeconds`；`tollsYuan?`、`freshness?`(缺省 `fresh`)、`steps?`、`fetchedAt?` | from/to 必须是**当天**的项、互不相同；距离/时长 `≥0`；未知 mode/freshness → `INVALID_VALUE`；按 `leg.id` upsert | 不检查 |
| `remove-leg` | `dayId`、`legId` 必填 | 不存在 → `INVALID_VALUE`（不是 `UNKNOWN_*`） | 不检查 |
| `set-day-transit` | `dayId`、`transit` 必填：`id` + `from`/`to`（每端 `placeId?`/`label?` 至少一个、`point?`）；`mode?`(缺省 `driving`)、`distanceMeters?`、`durationSeconds?`、`departAt?`、`arriveAt?`、`tollsYuan?`、`freshness?`(**缺省 `stale`**)、`steps?`、`polyline?`、`provider?`、`fetchedAt?` | `placeId` 不在地点库 → `UNKNOWN_PLACE`；两端无名称、`point` 越界、mode/freshness 非法、距离/时长<0 → `INVALID_VALUE`；`label` 为空时用库内地点名回填；按 `transit.id` upsert | 不检查（转场不属于站点） |
| `remove-day-transit` | `dayId`、`transitId` 必填 | 不存在 → `INVALID_VALUE`；删空后移除 `transits` 字段 | 不检查 |
| `add-day` | `day` 必填：`id`、`date`；`title?`(缺省 = date)；`areaLabel?` | id 在任意场景重复 → `DUPLICATE_ID`；**传入的 `items`/`legs` 被忽略，强制为空** | 不检查 |
| `remove-day` | `dayId` 必填 | 天不存在 → `UNKNOWN_DAY` | **当天有任意锁定项 → `ITEM_LOCKED`** |
| `set-trip-dates` | `startDate` 必填；`endDate?`；`redateDays?`（缺省 true） | 非真实日历日（如 `2026-02-31`）、结束早于开始 → `INVALID_VALUE`；`redateDays≠false` 且 `endDate` 与天数不一致 → `INVALID_VALUE`「日期区间与天数不匹配」 | **不阻止**；锁定项随所在天平移（只改时间戳的日期前缀，不改时刻） |
| `reorder-day` | `dayId` 必填、`order` 必填（当天项 id 的**完整排列**，非空、不重复） | 长度不符/含他天的 id/重复 → `INVALID_VALUE` | **允许**；锁定项作为时间锚点保留自己的时刻 |
| `reflow-day` | `dayId` 必填 | 天不存在 → `UNKNOWN_DAY` | 同上 |

`set-place-facts`、`set-day-transit`、`remove-day-transit`、`reorder-day`、`reflow-day` 这 5 种 **没有写进工具的 `ops` 说明**，但完全合法。

## locked 交互矩阵

| op | 面对锁定项的结果 |
|---|---|
| `remove-item` / `move-item` / `set-item-time` | 目标本身锁定 → `ITEM_LOCKED` |
| `set-day-title` / `remove-day` | 该天**只要有一个**锁定项 → `ITEM_LOCKED`（哪怕改的不是那一项） |
| `reorder-day` / `reflow-day` | 允许；锁定项保留自己的 `startAt`/`endAt`，其后各项从它的结束时刻续排 |
| `set-trip-dates` | 允许；锁定项随天平移，时刻不变 |
| `set-item-lock` | 唯一解锁途径（`locked:false`） |
| `set-leg` / `remove-leg` / `set-day-transit` / `remove-day-transit` / `add-item` / `add-place` | 不受锁定影响 |

## 不能通过 patch 完成的事

- 新建方案（`scenarios` 固定只有 `main`）、修改 `travelers` / `constraints`（类型存在，但没有任何写入路径）。
- 给 `add-day` 直接塞 `items` / `legs`：只能先建空白天，再逐条 `add-item` / `set-leg`。
- 跨天移动一个 item：`move-item` 只在同一天内定位锚点。
- 自动重排时间：`add-item`/`move-item`/`set-item-time` **都不重算时间**，要显式加 `reflow-day`（或 `reorder-day`）。

## 常用示例

```json
{"kind":"add-item","dayId":"d1","item":{"id":"d1-i0","placeId":"amap-xxx","startAt":"2026-10-01T09:00:00+08:00","plannedDurationMinutes":90,"notes":[]}}
{"kind":"set-day-title","dayId":"d2","title":"西安 → 成都｜翻秦岭 723km","areaLabel":"成都"}
{"kind":"set-day-transit","dayId":"d2","transit":{"id":"d2-transit-1","from":{"label":"西安"},"to":{"label":"成都"},"mode":"driving","distanceMeters":723000,"freshness":"stale","source":{"provider":"title","fetchedAt":"2026-09-22T00:00:00.000Z"},"steps":[]}}
{"kind":"set-item-lock","dayId":"d1","itemId":"d1-i0","locked":true}
{"kind":"set-trip-dates","startDate":"2026-10-05"}
{"kind":"reorder-day","dayId":"d1","order":["d1-i1","d1-i0","d1-i2"]}
```

带 revision 与城市校验的推荐调用：先 `travel_project_read` 取 `view.headline.revision`，把它作为 `expectedRevision` 回传；一次 patch 只放同一意图的 op，便于把 `rejected[]` 映射回具体修改。

## 证据

- 批次语义：`src/domain/patch.ts:258-290`（expectedRevision `:263-265`、顺序 `:271-279`、changed/revision `:281-289`）
- 拒绝码常量：`src/domain/patch.ts:155-168`；`TripRevisionError`：`:133-153`
- 工具层返回与 violations：`src/host/tools.ts:282-311`；`parsePatchOps`：`src/host/patch-input.ts:48-122`
- 形状校验规则：`src/host/patch-input.ts:594-646`
- 各 op 实现：`rename-trip` `src/domain/patch.ts:391-395`、`set-status` `:404-409`、`set-active-scenario` `:418-421`、`set-budget` `:431-460`、`set-preferences` `:469-519`、`add-place` `:528-535`、`set-place-status` `:545-557`、`set-place-facts` `:569-595`、`add-item` `:609-636`、`remove-item` `:646-659`、`move-item` `:672-699`、`set-item-lock` `:710-727`、`set-item-time` `:738-787`、`set-day-title` `:801-824`、`set-leg` `:834-872`、`remove-leg` `:882-891`、`set-day-transit` `:904-962`、`remove-day-transit` `:972-985`、`add-day` `:994-1005`、`remove-day` `:1014-1023`、`reorder-day`/`reflow-day` `:1039-1065`、`set-trip-dates` `:1085-1144`
- item id 查重跨场景：`src/domain/patch.ts:1302-1310`；leg/transit 形状校验：`src/host/patch-input.ts:412-523`
- 测试：`tests/domain.spec.ts:1038-1048`（revision）、`:1059-1075`（拒一条不中断）、`:1077-1093`（全拒不涨 revision）、`:1095-1113`（锁定矩阵）、`:1253-1274`（后续 op 基于前一条结果）
