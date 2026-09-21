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
- **真实地点照片**：高德 POI 图片（列表缩略图 / 详情横幅 / 地点图片墙），加载失败自动隐藏；缺失时可在地点库用「补全照片」按 POI 重新检索（匹配先按 POI id，再按完全同名）。
- **固定与增量修改**：**固定**＝钉住这一站，Agent 不会移动它、不会改时间，也不能拖动；未固定的安排可拖动、可改时、可删除。每次写入带 `expectedRevision`，冲突返回 409；`set-trip-dates` 可整体改行程日期并按天顺延（固定项随当天整体平移）。
- **确定性告警**：时间重叠、缺失或过期路线、单日过载、节奏超限、预算超限、事实过期，均由代码计算，不由模型自由填写。
- **导出**：Markdown 行程单与 JSON 备份。

## 安装

```sh
dsh plugin --profile <profile> add @skillre/dsh-plugin-travel-planner
```

发布前必须用 `npm pack` 生成 tarball 并在隔离 profile 中验证；源码链接不能替代发布视图测试。

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

`travel_project_create` · `travel_project_list` · `travel_project_select` · `travel_project_read` · `travel_project_patch` · `travel_place_search` · `travel_place_refresh` · `travel_route_plan` · `travel_day_rebuild_legs` · `travel_itinerary_validate` · `travel_project_export` · `travel_map_focus`

省略 `tripId` 时按「会话选择 → 工作区默认 → 最近更新」解析当前行程；`travel_project_list` 列出全部行程，`travel_project_select` 切换。

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

机器可读证据见 `compatibility.json`。**右侧栏的人工验收（拖拽手感、照片墙、固定语义）仍待你本人完成**——我可以验证状态与结构，无法代替你的手感和判断。

实现细节、所用契约与验证步骤见 [docs/implementation.md](docs/implementation.md)；
右侧栏时间轴、拖拽动效、固定语义、照片补全与重算入口的设计与实测见 [docs/sidebar-v4-design.md](docs/sidebar-v4-design.md)；
整趟行程一屏读下来、地图与日期目录的布局演进见 [docs/sidebar-v5-design.md](docs/sidebar-v5-design.md)、[docs/sidebar-v6-design.md](docs/sidebar-v6-design.md) 与 [docs/sidebar-v7-design.md](docs/sidebar-v7-design.md)。

## 已知限制

- 当前高德契约不提供营业时间、评分与实时票价（POI 图片有，见上），插件不编造这些数据。
- 公交路线必须逐城市查询，跨城交通不能伪装成本地公交结果。
- 地图默认由高德容器渲染；`amap.browserMap: off` 或容器不可用时退回按坐标投影的示意图（只用于判断顺序与折返，精确路网以高德为准）。每一站都是水滴标记、按天着色；每天的第一站是当天的锚点（`D1`…`D14`），当天其余站标站号。地点名字在**缩放 6 级及以上**（或整幅不超过 10 个点）时显示在标记上方——32 个名字铺在全国视野里只会互相压。
- POI 图片是高德 CDN 的 http 地址：在 `http://127.0.0.1` 下可直接显示，若将来从 https 打开 Sidebar，需要 Host 侧图片代理（未实现）。
- 拖拽只在同一天内生效，跨天移动需要走 Agent 或 `travel_project_patch`。
- 行程文件 `schemaVersion` 已到 2（新增 `transits`）；版本 1 的文件仍可读，只在写入时才升到 2。
- 插件注册的 HTTP 路由不受 Web GUI 的浏览器信任围栏保护（实测：`/api` 返回 401，而插件路由不校验 launch cookie），详见 [SECURITY.md](SECURITY.md)。
- 客户端文案目前只有中文。
- 首次启动需要一次真实浏览器会话确认页签渲染。

## 卸载与回滚

见 [UNINSTALL.md](UNINSTALL.md)。

## License

MIT
