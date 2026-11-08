# @skillre/dsh-plugin-travel-planner

> 状态：experimental · 已实现（Host + Client），浏览器人工验证待补

面向个人 / 情侣自由行的 DSH 原生旅行规划插件。用高德 CLI 查询地点与路线，在 DSH 右侧 Sidebar 中展示逐日行程、地点卡片、交通段与提醒，并把这套能力同时暴露给模型工具。

[English](README.en.md)

## 它能做什么

- **对话驱动、结构化落地**：模型通过 `travel_*` 工具维护同一份 Trip Project，而不是每次重新生成攻略。
- **高德事实**：POI 搜索、周边搜索、步行/公交/骑行/驾车路线与途经点，全部经 `amap-gui` 查询并标准化为 GCJ-02 坐标。
- **右侧栏工作台**：`行程 / 地图 / 地点 / 提醒` 四个视图；面板 ≥1240px 时是三栏（行程｜地图｜日期目录），1080–1239px 两栏，560–1079px 地图在上、行程与目录在下，更窄则单栏（全部由 CSS container query 决定，不依赖任何运行时 hook）。地图的框按路线形状给（全程路线近似正方形，2.8:1 的扁条只能把整条路压成一小撮），框一变就重新 fit。
- **时间轴**：左侧时间轨（时刻 + 类别色节点 + 贯穿下一段交通的虚线），右侧卡片（名称 / 固定 chip / 停留时长 / 类别·地址），以及缩略图与拖动把手；告警不落在卡片里，只在日期标题行汇总一处。
- **赶路日是一等公民**：一天可以只有路、没有任何地点。`TripDay.transits` 记的是「移动」本身——两端（有地点就用它的坐标，没有就只是名字）、方式、里程、时长、出发/到达时刻、真实路径与数据来源。它不计入站数与停留，但计入里程与行车时长；只有转场没有站点的日子是完整的一天，不再显示「还没有安排」。工具 `travel_day_set_transit` 会用高德把这段路算成真实路线（配了 Web 服务 Key 时连真实路径一起写回），面板上的「记为转场」一键把标题里那段路升级成真数据。
- **拖拽排序 + 自动重排**：拖动把手直接调整顺序，单位让位并缓入落位，松手后 Host 按「停留时长 + 已测交通」立刻重算当天时间（固定项不动），并给出「重算这一天交通」（真实路网，无需模型）或交给 Agent 复核；「交通待重算」入口常驻在日期标题行，关掉提示不会丢掉它。
- **地图上的赶路日**：只要有路就画线，三级降级——当天有转场就用转场的真实路径（实线），当天有一段主导的长途 leg（≥100 km，且占当天里程或移动时长 ≥80%）就用那段（实线），只有标题（`西安 → 成都｜723km`）就按标题画估算线（长虚线 + `≈` + 「按标题估算」，端点取该天自己的站点，没有就借相邻天）。线中点挂一枚胶囊写明里程与时长（`驾车 · 1077.1 km · 12 小时 38 分`），显隐跟站名同一套规则；"整天赶路、一个站点都没有"的日子现在也能被画出来并被 fit 框住。行程里只有标题的赶路日可以在**地图角上**用「补全 N 天路线」一次性让高德算出真实路线并落盘（走 Web 服务 HTTPS，或复用**已经启动**的高德容器；**不会**替你打开高德窗口）。
- **真实地点照片**：高德 POI 图片（列表缩略图 / 详情横幅 / 地点图片墙），加载失败自动隐藏；缺失时可在地点库用「补全照片」按 POI 重新检索（匹配先按 POI id，再按完全同名）。
- **固定与增量修改**：**固定**＝钉住这一站，Agent 不会移动它、不会改时间，也不能拖动；未固定的安排可拖动、可改时、可删除。每次写入带 `expectedRevision`，冲突返回 409；`set-trip-dates` 可整体改行程日期并按天顺延（固定项随当天整体平移）。
- **确定性告警**：时间重叠、缺失或过期路线、单日过载、节奏超限、预算超限、事实过期，均由代码计算，不由模型自由填写。
- **导出**：Markdown 行程单与 JSON 备份。

## 安装

交付并完成兼容验证后，由**用户**在 DSH Desktop Client 或 Web UI 的 **Plugins/插件管理**中自行发起安装、更新和启用；开发者/agent 不在用户 profile 里代装。若已发布且目标 DSH 版本受支持、目标管理器确认可安装，可输入 npm 包名 `@skillre/dsh-plugin-travel-planner@<version>`。未发布时，可在管理界面选择经过构建与验证的本地包目录或 `.tgz` **绝对路径**，前提是该界面支持这种来源并且包可安装。GitHub 仓库 URL 仅在管理器支持、仓库有安全自包含的 `prepare` 构建且完成安装验证后才能提供；原始源码链接不是已验证的交付物。

发布前开发者须用 `npm pack` 生成 tarball，在自己拥有的可丢弃**非 Desktop**隔离 profile 里临时挂载并完成有界启动；成功或失败后停止测试进程、移除仅本次新增的包/选择/配置或确认归属的隔离 profile，并核验清理。若需测试用户真实 Desktop/Web profile，须事先获同意、记录原有状态并仅撤销本次测试更改；不动既有插件和用户数据。测试安装不能作为最终交付。

## 配置

Bundle 默认注入两行，配置如下（`webKeyRef` / `securityKeyRef` 是 DSH 凭据引用名，不是密钥值）：

```yaml
- id: skillre-travel-planner
  name: '@skillre/dsh-plugin-travel-planner'
  config:
    amap:
      webKeyRef: AMAP_KEY
      securityKeyRef: AMAP_SECURITY_KEY
- id: skillre-travel-planner-web
  name: '@skillre/dsh-plugin-travel-planner/web'
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `workspaceSubdirectory` | `.travel` | 工作区内保存旅行项目的目录 |
| `currency` | `CNY` | 新项目的默认货币 |
| `timezone` | `Asia/Shanghai` | 新项目的默认时区 |
| `httpPath` | `/api/skillre-travel` | 浏览器 API 前缀 |
| `ui.placePhotos` | `auto` | 是否把高德 POI 图片地址下发到浏览器（`auto` 显示真实照片，`off` 则完全不外发第三方地址） |
| `alerts.routeStaleMode` | `adaptive` | 交通过期的计分口径：`adaptive` 只在该天临近时才提醒（>7 天不产生、1–7 天提示、≤1 天警告），`strict` 始终按警告处理 |
| `amap.executable` | `amap-gui` | CLI 可执行文件 |
| `amap.webKeyRef` | 必填 | 高德 Web (JS API) Key 的凭据引用名 |
| `amap.restKeyRef` | `AMAP_REST_KEY` | 高德 **Web 服务** Key 的凭据引用名。配了它，地点照片/电话查询走 HTTPS 直连，**完全不需要高德容器**（也不会弹窗）；没有则回退到 CLI，此时补全照片需要容器在线 |
| `amap.securityKeyRef` | 空 | 安全密钥的凭据引用名（账号需要时填写）；只在进程内使用，永不下发浏览器 |
| `amap.browserMap` | `auto` | 侧边栏是否用 `webKeyRef` 的 Key 自行渲染高德地图；`off` 时退回坐标示意图 |
| `amap.autoStart` | `true` | 容器未运行时自动启动 |
| `amap.autoStop` | `true` | 仅停止本插件启动的容器 |
| `amap.commandTimeoutMs` | `45000` | 单次 CLI 超时（1000–600000） |
| `amap.poiCacheTtlMs` | `86400000` | POI 缓存时长 |
| `amap.routeCacheTtlMs` | `21600000` | 路线缓存时长 |

主行只负责工具、存储与 CLI 网关；Web 行单独承担浏览器 API，因此没有 Web GUI 的 profile 也能使用全部模型工具。

## 模型工具

`travel_project_create` · `travel_project_list` · `travel_project_select` · `travel_project_read` · `travel_project_patch` · `travel_place_search` · `travel_place_refresh` · `travel_route_plan` · `travel_day_rebuild_legs` · `travel_day_set_transit` · `travel_itinerary_validate` · `travel_project_export` · `travel_map_focus`

省略 `tripId` 时按「会话选择 → 工作区默认 → 最近更新」解析当前行程；`travel_project_list` 列出全部行程，`travel_project_select` 切换。

## 自带 skill

插件在挂载时把自己的 skill 注册进 DSH 的 skill 目录（`ctx.skills.register`，来源标为 `bundled`，`resourceBase` 指向包内目录），所以装上插件就等于装上了这份「怎么用这套工具 + 怎么排好一趟旅行」的手册，不需要额外往 `~/.dsh/skills/` 放东西：

```text
skills/travel-planner/
├── SKILL.md                        # 工作循环、锁定与 revision、赶路日、能力边界
└── references/                     # 按需加载：模型用自己的文件工具读
    ├── tools.md                    # 13 个工具的副作用与失败降级
    ├── patch-ops.md                # 23 种 patch kind 的字段表与拒绝码
    ├── alerts.md                   # 12 种告警的阈值与就绪度公式
    ├── data-model.md               # trip.json 结构、id 规则、多行程解析
    └── itinerary-craft.md          # 容量模型、聚类、约束收集、失败模式
```

- 只在 profile 有 skill 注册表时注册；没有时静默跳过，插件其余能力不受影响。
- 优先级：项目级 skill 目录（`<project>/.dsh/skills`、`<project>/.agents/skills`）里同名的 skill 覆盖它，它覆盖用户级目录（`~/.dsh/skills`、`~/.agents/skills`）。
- 想替换或屏蔽它：在项目级 skill 目录放一份同名 skill 即可覆盖，无需改动插件。

## 数据位置

```text
<会话工作区>/.travel/
├── state.json                                       # 当前行程：会话选择 + 工作区默认
└── projects/<tripId>/
    ├── trip.json                                    # 可读、可版本控制的项目文档
    └── exports/                                     # Markdown / JSON 导出
```

一个工作区可以放多份行程；`state.json` 缺失或损坏时退化为「最近更新的行程」，不需要迁移。

## 安全与权限

- 需要启动与控制 `amap-gui` 子进程，并访问高德网络服务；配置 `amap.restKeyRef` 后，补充照片/电话只调用高德 Web 服务 API（HTTPS），不再需要容器。
- 凭据在每次调用时通过 `credentials` 解析，只注入当前子进程环境；不会写入文件、日志、工具返回或命令行参数。
- 只停止本插件启动的高德容器。
- 浏览器 API 仅接受同源请求，且只读写旅行项目数据。
- 不涉及下单、支付或取消。

详见 [SECURITY.md](SECURITY.md) 与 [docs/amap-cli-integration.md](docs/amap-cli-integration.md)。

## 当前验证状态

| DSH 版本 | 结果 | 验证日期 | 检查项 |
|---|---|---|---|
| 0.1.5-rc.2 | passed | 2026-09-15 | `dump-config`、`bounded-startup`（隔离 profile 安装 tarball 后两行均激活；API 与 boot graph 校验通过） |
| 0.1.6-alpha.1 | passed | 2026-09-15 | 上述两项，外加 `browser`（右侧栏占用者在真实 Slot 账本中 `active: true`；面板内高德地图从 loopback 页面加载并渲染瓦片与标记） |
| 0.1.7-alpha.2 | passed | 2026-09-23 | `dump-config`、`bounded-startup`、`display-metadata`（隔离 profile 安装重打包 tarball，两行均激活；新增元数据检查：经 Node ESM resolver 解析 `locale/en.json` 与 `package.json`，卡片标题解析为 **Travel Planner**、`icon` 与 `engines.dsh` 可读；13 个主题 token 与当前 theme 全部对账通过） |

机器可读证据见 `compatibility.json`。**右侧栏的人工验收（拖拽手感、照片墙、固定语义、赶路日路线的观感）仍待你本人完成**；已有 Web/浏览器证据不等于 Desktop Client 的 Electron 验收。实际面向 Desktop 时须在真实客户端另行做视觉/交互检查；面向独立 Web UI 时检查现有 DSH Web 页面。

0.12.0（赶路日路线）另有一轮可复现的验证：316 个单测（6 个文件，`npm run check` 含 typecheck / publint / `npm pack --dry-run`）、两次脚本化真机浏览器检查（`.verify/drive-routes.mjs` 全程、`.verify/drive-day-mode.mjs` 当天模式），以及**历史上**在用户 `web` profile 里用 0.12.0 tarball 安装（插件管理器报 `restart-required`，profile 依赖已指向该 tarball，安装产物里核对了 `fill-transits` 路由与客户端 `driveRoutes`）。该历史记录不证明安装已清理或 Desktop 客户端已验证；本次文档工作不改动既有 profile，若要核查/清理旧测试状态，须先获同意并仅处理确认归属测试的内容。**Host 变了，需要重启一次 DSH 才生效。**

实现细节、所用契约与验证步骤见 [docs/implementation.md](docs/implementation.md)；
右侧栏时间轴、拖拽动效、固定语义、照片补全与重算入口的设计与实测见 [docs/sidebar-v4-design.md](docs/sidebar-v4-design.md)；
整趟行程一屏读下来、地图与日期目录的布局演进见 [docs/sidebar-v5-design.md](docs/sidebar-v5-design.md)、[docs/sidebar-v6-design.md](docs/sidebar-v6-design.md) 与 [docs/sidebar-v7-design.md](docs/sidebar-v7-design.md)；
"赶路日在地图上也要有路线"的设计、真机实测与评审结论见 [docs/drive-routes-design.md](docs/drive-routes-design.md)。

## 已知限制

- 当前高德契约不提供营业时间、评分与实时票价（POI 图片有，见上），插件不编造这些数据。
- 公交路线必须逐城市查询，跨城交通不能伪装成本地公交结果。
- 地图默认由高德容器渲染；`amap.browserMap: off` 或容器不可用时退回按坐标投影的示意图（只用于判断顺序与折返，精确路网以高德为准）。每一站都是水滴标记、按天着色；每天的第一站是当天的锚点（`D1`…`D14`），当天其余站标站号。地点名字在**缩放 6 级及以上**（或整幅不超过 10 个点）时显示在标记上方——32 个名字铺在全国视野里只会互相压。
- POI 图片是高德 CDN 的 http 地址：在 `http://127.0.0.1` 下可直接显示，若将来从 https 打开 Sidebar，需要 Host 侧图片代理（未实现）。
- 拖拽只在同一天内生效，跨天移动需要走 Agent 或 `travel_project_patch`。
- 行程文件 `schemaVersion` 已到 2（新增 `transits`）；版本 1 的文件仍可读，只在写入时才升到 2。
- 赶路日的**估算线**（长虚线）是标题那两个端点的两点直连，不代表真实道路，里程取自标题；只有「补全 N 天路线」或「记为转场」+「用高德重算」之后才会变成真实路径的实线。已有转场的那一天，转场折线与赶路实线会重叠绘制（同色，实线更粗在上，看起来是一条线）。
- 插件注册的 HTTP 路由不受 Web GUI 的浏览器信任围栏保护（实测：`/api` 返回 401，而插件路由不校验 launch cookie），详见 [SECURITY.md](SECURITY.md)。
- 客户端文案目前只有中文。
- 独立 Web UI 的页签渲染须在真实浏览器中确认；面向 Desktop Client 时另须在真实 Electron 客户端检查，二者不能互代。

## 卸载与回滚

见 [UNINSTALL.md](UNINSTALL.md)。

## License

MIT
