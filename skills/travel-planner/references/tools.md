读取时机：准备发出一次 `travel_*` 调用、或不确定"这次调用会不会落盘、会不会报错、失败后还能用什么"时，先读这份文件。

## 通用约定

| 事项 | 规则 |
|---|---|
| 会话 | `sessionId` 由运行时注入，模型不传 |
| `tripId` | 除 `travel_project_create` / `travel_project_list` / `travel_project_select` 外都可省略；解析顺序见 `data-model.md` |
| 落盘 | 写 `<会话 cwd>/.travel/projects/<tripId>/trip.json` |
| revision | 凡走 patch 落盘的工具，**只要有一个 op 生效，revision 就 +1** |
| 日期/时间 | ISO 8601；`dayId` 形如 `d1`；日期为 `YYYY-MM-DD` |
| 高德窗口 | 多数高德工具在容器未运行时会**自动启动容器（会弹出高德窗口）**；只有批量补全路线不启动（无模型工具） |

## 13 个工具速查表

| 工具 | 何时用 | 必填参数 | 副作用 | 返回关键字段 | 失败与降级 |
|---|---|---|---|---|---|
| `travel_project_create` | 建新行程（首次必调） | `title,startDate,endDate,destinations` | 落盘，revision=1；并把该行程设为**本会话选择 + 工作区默认** | `tripId,revision,dayCount,days[]` | 同标题 + 同 startDate 已存在 → 抛错；日期不可解析 → 只建 1 天；超过 30 天 → 静默截断为 30 天；`preferredModes` 固定 `['transit','walking']`，本次无法指定 |
| `travel_project_list` | 用户按名字提行程、切换前 | 无 | 无（只读；内部会对每个行程跑一次校验） | `count,activeTripId,selectionSource,trips[]`（含 `readiness`、`alerts` 计数、`active`） | 空工作区 → `count:0` + `hint`；`includeArchived:false` 过滤 `archived`（默认 true） |
| `travel_project_select` | 切换到某个行程 | `tripId` | 写 `state.json`（本会话选择）；`asDefault:true` 时同时改工作区默认 | `activeTripId,asDefault,title,startDate,endDate,note` | 行程不存在 → `TRIP_NOT_FOUND`；`tripId` 空白 → 抛错 |
| `travel_project_read` | **任何修改前、汇报前** | 无 | 无（只读） | `exists,tripId,title,selectionSource,summary,candidates[],view{headline,days,places,alerts,…}` | 无行程 → `{exists:false,trips,hint}`；`includePlaces:false` 时 `view.places` 为空数组 |
| `travel_project_patch` | 一切结构化修改 | `ops` | 落盘（≥1 op 生效才写，revision+1；顺带回写 alerts） | `tripId,revision,applied[],rejected[],violations[],changed,readiness,alerts` | 见 `patch-ops.md`；revision 不符 → 返回 `rejected:[{index:-1,kind:'batch',code:'REVISION_MISMATCH'}]` 且不落盘；ops 全部形状非法 → 直接返回、不核对 revision |
| `travel_place_search` | 找 POI | `keyword` | `add:true` → 落盘（批量 `add-place`，revision+1）；缺省 `add:false` 时不碰行程 | `keyword,total,fromCache,places[{id,name,address,categories,longitude,latitude,telephone?,providerPlaceId}],added[]` | 无 `subprocess` 服务 → 抛「高德 CLI 不可用」；容器未运行会自动启动；POI 已在地点库 → 该条被 `DUPLICATE_ID` 拒绝，不出现在 `added[]` |
| `travel_place_refresh` | 地点缺照片/电话 | 无 | 有匹配时落盘（`set-place-facts`，revision+1） | `checked,updated,unmatched[],source('web-service'\|'amap-cli')` | **没有 CLI 网关即报 `AMAP_CLI_NOT_FOUND`**（配了 REST Key 也一样）；候选集只含缺 `photoUrl` 的地点；本次调用 `allowStart:true` → 容器未运行会启动并弹出高德窗口 |
| `travel_route_plan` | 只要一段路的事实、暂不写入 | `from,to,mode` | 无（**不落盘**） | `mode,distanceMeters,durationSeconds,tollsYuan?,from,to,fetchedAt,fromCache,steps[]`（`includeSteps:true` 才有 steps） | `transit` 无 `city` → `AMAP_UNSUPPORTED_ROUTE`；`waypoints` 仅 `driving` 且 ≤16；容器未运行会自动启动；结果必须再用 `set-leg` / `set-day-transit` 才落盘 |
| `travel_day_rebuild_legs` | 相邻两站点之间要真实交通 | `dayId` | 落盘（批量 `set-leg`，revision+1）；一段都没算出来时不写 | `dayId,legs,totalDistanceMeters,totalDurationSeconds,skipped[]` | `mode` 缺省 = `preferences.preferredModes[0] ?? 'transit'`；地点缺失的相邻对进 `skipped`；无网关 → `AMAP_CLI_NOT_FOUND`；会启动容器 |
| `travel_day_set_transit` | 这一天的主内容是**换城市**（可以没有任何站点） | `dayId` + 每端 `placeId` 或 `label` 至少一个 | 落盘（`set-day-transit`） | `dayId,transitId,distanceMeters?,durationSeconds?,planned,polyline` | 见下方专节；无 provider 也**不会失败**（按调用方数字写入）；本工具**没有** `arriveAt` / `transitId` 参数 |
| `travel_itinerary_validate` | 宣布"就绪"前、每次改完 | 无 | 写 `trip.json` 但 **revision 不变**（回写 alerts） | `tripId,revision,readiness,errors,warnings,infos,alerts[]`（最多 20 条） | 无行程 → `TRIP_NOT_FOUND`（提示先 `travel_project_create`） |
| `travel_project_export` | 交付行程单/备份 | `format`（`markdown`\|`json`） | 写 `exports/`，**不改 `trip.json`、不改 revision** | `tripId,path,format` | 无行程 → `TRIP_NOT_FOUND`；重复导出覆盖同一路径 |
| `travel_map_focus` | 让用户在高德窗口看到某天/某点 | 无（`longitude`+`latitude` 优先于 `dayId`） | 无（只驱动容器） | `focused,longitude,latitude,dayId` | 该天没有带坐标的地点 → 抛「无法定位」；`zoom` 夹到 3..20；会启动容器 |

## `travel_day_set_transit` 专节

| 参数 | 语义 |
|---|---|
| `fromPlaceId`/`fromLabel`、`toPlaceId`/`toLabel` | 每端至少一个。`placeId` 权威（名称与坐标取自地点库）；只给 `label` 时，**配了高德 Web 服务 Key 才会地理编码**，坐标写回该端并持久化；编码失败/无 Key → 保留纯名称，**写入照常成功** |
| `mode` | 缺省 `preferences.preferredModes[0] ?? 'driving'` |
| `departAt` | 缺省 = 当天第一项的 `startAt` |
| `plan` | 缺省 **true**：向高德要真实路线，**你传的 `distanceMeters`/`durationSeconds` 会被覆盖**；`false`：不动 provider，保留你的数字 |
| 结果标记 | `planned:true` → `freshness:'fresh'`、`source:'amap-cli'`；`planned:false` → `freshness:'stale'`、`source:'title'`（面板显示「按标题估算」） |
| `polyline` | 只有走 Web 服务驾车 API 才拿到（CLI 路径不返回） |

降级链：`plan:true` 且 `mode=driving` 且**有 REST Key** → 走 HTTPS 驾车 API；REST 报错时本工具**直接抛错**（批量补全才会回退 CLI）；两端任一端没有坐标 → 两个 provider 都不问，直接按调用方数字写入。

## 失败与降级总表

| 情况 | 表现 | 可以做什么 |
|---|---|---|
| profile 未组成 `subprocess` | `travel_place_search` / `travel_route_plan` / `travel_map_focus` 抛「高德 CLI 不可用」；`travel_day_rebuild_legs` / `travel_place_refresh` 抛 `AMAP_CLI_NOT_FOUND` | 改用已有数据（手写 `set-leg` / `set-day-transit`），或告知用户需要配置 |
| 容器未运行、允许自动启动 | 相关调用启动容器（弹出高德窗口）后继续 | 无 |
| 容器未运行、且调用方禁止启动 | `AMAP_NOT_RUNNING` | 请用户手动开容器；批量补全路线会返回该天的 `reason` 而不是报错 |
| 配置 `autoStart:false` 且容器未运行 | `AMAP_NOT_READY` | 让用户在插件设置里开启自动启动 |
| 容器启动但地图未就绪 | `AMAP_START_FAILED` | 稍后重试 |
| 凭据引用解析不到 | `AMAP_CREDENTIAL_MISSING` | 让用户配置该凭据引用 |
| CLI 超时（默认 45000ms） | `AMAP_COMMAND_TIMEOUT` | 缩小范围重试；超时可配置（1000–600000ms） |
| CLI 退出码非 0 | `AMAP_COMMAND_FAILED` | 检查关键词/城市参数 |
| CLI 输出无法解析 | `AMAP_INVALID_RESPONSE` | 通常意味着版本不匹配；告知用户 |
| 跨城公交 | `AMAP_UNSUPPORTED_ROUTE` | 公交必须逐城市查询；跨城用 `driving` 转场 |
| `travel_day_set_transit` 无任何 provider | **不报错**，按调用方数字写入（`planned:false`） | 继续用；需要真实数据时补 Key 后重调 |

## 常见序列

```text
建行程：travel_project_create → travel_project_read
排一天：travel_place_search(keyword,add:true) → travel_project_patch([add-item…])
       → travel_day_rebuild_legs(dayId) → travel_itinerary_validate
赶路日：travel_project_patch([set-day-title]) → travel_day_set_transit(dayId, fromLabel, toLabel)
交付：  travel_itinerary_validate → travel_project_export(format)
换行程：travel_project_list → travel_project_select(tripId)
```

## 运行时陷阱与降级

下列「真机」证据指 0.12.1 上的评测运行日志：`skills/.build/evals/iteration-1/<eval>/<arm>/run-1/outputs/notes.md`（仓库内可读，发布包不含）。

| # | 现象 | 为什么 | 怎么做 |
|---|---|---|---|
| T1 | `travel_project_create` 返回 `invalid output: "value.activeTripId" is not a declared property`，**但行程已写入** | 返回体多带 `activeTripId`，而 `output.schema` 是 `additionalProperties:false`；写入发生在返回之前。当前源码已补声明，但已发布 profile 里的 0.12.1 仍是旧行为 | 先 `travel_project_list` 复核行程是否已在（真机两臂都确认已落盘、已成为会话选择）；**绝不重试 create**——同标题+同 `startDate` 会直接冲突报错。之后全程显式带 `tripId` |
| T2 | 省略 `tripId` 时导出/校验落到**别的行程**：`travel_project_export` 把 `itinerary.md` 写进了另一条臂的行程目录 | 省略 `tripId` ≠「当前会话的行程」。解析顺序是 显式 → 本会话选择 → **工作区默认** → **最近更新**，后两级会被同一工作区的其它会话改写 | 多行程/多会话/并发时**每次都显式传 `tripId`**；先 `travel_project_list` 核对 `activeTripId` 与 `active` 再动手；不要靠"当前行程"兜底，也不要用 `travel_project_select` 去改工作区默认 |
| T3 | `travel_day_rebuild_legs` 的 `mode:'transit'`（往往就是缺省值）整天失败：`amap-gui reported success: false`，一段都不落盘 | 失败点定位在**批量 transit 这条路径**上 CLI 返回 `success:false`；同一环境单段 `travel_route_plan(mode:'transit')` 正常，说明不是容器未就绪或高德服务整体不可用（确切根因未定位）。缺省 mode 取 `preferences.preferredModes[0]`，而工具建的行程是 `['transit','walking']`，所以不传 mode 就会走这条路。**不是稳定复现**：另一组 run 的 transit 批量成功 | 降级两步走：① 换成 `mode:'walking'`（或 `'driving'`）把整天先落盘；② 对真正需要公交的长段单独 `travel_route_plan{mode:'transit',city}` 取真实数据，再用 `set-leg` 以**同一 `leg.id`** upsert 覆盖（真机：`d3-leg-3` → 6484 m / 2342 s） |
| T4 | 纯地名端点被地理编码到错误城市：`travel_route_plan{from:'成都',to:'乐山'}` 算出 1957.8 km，`from.point={116.46,39.90}`（北京） | 只给 `label` 的端点会做一次地名地理编码，同名/模糊命中可能落在别处 | 先用 `travel_place_search{keyword:'成都市',city:'成都'}` 建城市锚点地点（真机命中 `amap-B001C8OIZM` 104.07,30.57），此后端点**一律传 `placeId`**；`travel_day_set_transit` 同理，不要用 `fromLabel` 传城市名 |
| T5 | 重建后同一天出现两条相同 `fromItemId→toItemId` 的 leg，或 0 km 自环段 | `travel_day_rebuild_legs` 按 id upsert、**不清理旧 leg**；中途删过 item 再重建时，旧编号与新编号会并存 | 重建后复核相邻对唯一性（`travel_project_read` 或读 `days[].legs`），用 `remove-leg` 删多余项；删 item 时引用它的 leg 会被同一 op 连带删除，可省一次清理 |
| T6 | 按旧 revision 发出的整批 op 被 `REVISION_MISMATCH` 整批拒绝（真机：读到的 revision 1 与实际 22） | 带 `add:true` 的 `travel_place_search` **也是写操作**，每次入库 revision+1（真机连续 21 次搜索把 1 推到 22） | 搜完地点后**重新 `travel_project_read` 取 revision** 再 patch；被拒时无需回滚（整批拒绝=未落盘），直接用返回的 `actualRevision` 重发同一批 op |
| T7 | 同一批里有几条 op 被逐条拒绝：`{"message":"字段 dayId 必须是非空字符串。"}` ×3，其余 op 照常生效 | host 层逐条校验、逐条拒绝，批次**不是事务** | 每条 op 都写全自己的 `dayId`（`set-item-lock`/`set-item-time`/`move-item`/`set-day-title`/`set-leg`/`set-day-transit` 等）；同一批里别把「删 item」和「依赖旧 id 的改」混在一起，必要时拆成两批 |
| T8 | `exports/itinerary.md` 里每站只有 时间 · 名称 · 类别 · 停留（+已锁定），没有地址、电话、备注 | 渲染器只取这几个字段 | 现场要用的信息（预约方式、电话、集合点、注意事项）在 `add-item` 时写进 `notes`——`notes` 会出现在 `travel_project_read` 的 view 里，但**不会**进 Markdown；或直接写进给用户的回复 |
| T9 | 同一天第二次 `travel_day_set_transit` 新增 `dN-transit-2`，而不是覆盖 `dN-transit-1` | 工具没有 `transitId` 参数，id 由「当天未占用的最小序号」生成，写入按 id upsert | 要改已有转场：用 `travel_project_patch` 的 `set-day-transit`（自带 `transit.id`，按 id 覆盖）；或先 `remove-day-transit` 再重写。（源码结论，未在评测中复现） |
| T10 | 手写 `add-place` 不带 `fetchedAt`，该地点立刻产生 `PLACE_FACT_STALE` | 解析器缺省写 `1970-01-01T00:00:00.000Z`；而 `travel_place_refresh` 只合并 photoUrl/telephone/address，**不改** `source.fetchedAt`，同 id 又不能重复 `add-place` —— 没有工具路径能把它改新 | 优先用 `travel_place_search(add:true)` 入库（自带真实取数时间）；必须手写就显式带 `fetchedAt`；已经写旧的，向用户说明这只是「资料可能过期」的 info 提示，不影响规划，不要为它硬造数据 |

## 证据

- 真机证据（0.12.1 六个 run 的调用日志与报错原文）：`skills/.build/evals/iteration-1/*/*/run-1/outputs/notes.md`；对照分析 `skills/.build/evals/iteration-1/analysis.md`
- T1：真机 eval-0 两臂（`notes.md:100,105`、`:110-112`）；当前源码已声明 `activeTripId` `src/host/tools.ts:82`
- T2：真机 eval-1 without_skill（`notes.md:30,118-124`）；解析顺序 `src/host/travel-service.ts:356-372`
- T3：真机 eval-0 两臂（`notes.md:33,121-136`、`:35,53,116-118`）；eval-2 两 run 成功（非稳定复现）；缺省 mode `src/host/travel-service.ts:642`、`src/host/tools.ts:117`
- T4：真机 eval-1 without_skill（`notes.md:18,80-99`）；地理编码 `src/host/travel-service.ts:834-867`
- T5：真机 eval-0 without_skill（`notes.md:51,55,157-158`）；leg id 生成 `src/host/travel-service.ts:671`；删 item 连带删 leg `src/domain/patch.ts:653-656`
- T6：真机 eval-0 with_skill（`notes.md:30,107-119`）；`add:true` 落盘 `src/host/tools.ts:355-362`
- T7：真机 eval-0 without_skill（`notes.md:127-132`）；逐条校验 `src/host/patch-input.ts:594-598`、整批拒绝语义 `src/host/tools.ts:282-285`
- T8：渲染字段 `src/domain/markdown.ts:170-184`；`notes` 进 view `src/host/view.ts:167`
- T9：`src/host/travel-service.ts:206-212,738`；工具参数无 id `src/host/tools.ts:504-516`
- T10：真机 eval-1 without_skill（`notes.md:141-144`）；缺省 epoch `src/host/patch-input.ts:363-366`；refresh 字段集 `src/host/travel-service.ts:1191-1196`；同 id 拒绝 `src/domain/patch.ts:530-532`
- 工具注册与参数：`src/host/tools.ts:44,148,190,219,253,318,385,412,460,501,566,614,639`
- 工具数量断言：`tests/host.spec.ts:2907-2921`
- create 细节：`src/host/tools.ts:88-92`（重复）、`:701`（30 天上限）、`:117`（preferredModes）、`:134`（设为默认）
- patch 工具返回：`src/host/tools.ts:286-311`；空 ops 提前返回 `:282-285`
- 落盘/ revision：`src/host/travel-service.ts:561-580`（patch 写入门控）、`:1212-1216`（validate 写文件不改 revision）
- rebuild legs：`src/host/travel-service.ts:628-701`（`mode` 缺省 `:642`、`skipped` `:654-656`、无网关 `:634-637`、0 段不写 `:693-699`）
- set transit：`src/host/travel-service.ts:725-802`（plan `:741-766`、freshness/source `:747,786-791`、departAt `:768`）、`:821-868`（端点解析与地理编码）、`:913-972`（provider 顺序）
- place search / refresh：`src/host/tools.ts:342-378`；`src/host/travel-service.ts:1142-1203`（无网关 `:1152-1155`、候选 `:1158-1160`、匹配 `:1184-1196`）
- export：`src/host/travel-service.ts:601-612`、`src/host/trip-store.ts:188-193`
- map focus：`src/host/tools.ts:664-692`、`src/host/amap/gateway.ts:259-271`
- 错误码全集与抛出点：`src/host/amap/cli.ts:9-21`、`src/host/amap/gateway.ts:128-151,299-324`、`src/host/amap/exec.ts:81`、`src/index.ts:85-90`
- `AMAP_NO_RESULT`：类型中已声明，源码无抛出点（未验证其运行时触发条件）
