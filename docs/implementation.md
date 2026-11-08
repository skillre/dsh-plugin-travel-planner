# 实现说明

> 记录日期：2026-09-15 · DSH `0.1.5-rc.2`
> 本文是实现记录，不是运行时契约缓存。升级 DSH 后必须重新 Inspect。

## 1. 已实现范围

| 设计文档 | 实现状态 |
|---|---|
| `docs/product-design.md` | Trip Project 领域模型、增量 patch、确定性校验与告警、预算、导出、`travel_*` 工具 |
| `docs/amap-cli-integration.md` | CLI 网关（串行队列、超时、取消、缓存、错误码）、POI 与路线标准化、容器生命周期 |
| `docs/right-sidebar-ux.md` | 右侧栏页签类型、普通/全屏布局、逐日时间轴、地点卡片、路线段、提醒、示意图地图 |

尚未实现（有意为之）：预订与支付、实时票价、多人协作、真实地图瓦片渲染、i18n 多语言。

## 2. 运行时契约（实现所依赖的最小集合）

查询方式：`cordis_inspect_list` + `cordis_inspect_query`，日期 2026-09-14/15，DSH `0.1.5-rc.2`。

### Host

- `tools.register(ToolDefinition)`；工具用 `@deepseek-ai/dsh-tools` 的 `defineTool` 声明。
- `fs`：`resolve` / `readText` / `writeText` / `listDir` / `stat`。`writeText` 会递归创建父目录，因此无需单独的 mkdir。
- `subprocess.spawn(SubprocessSpawnSpec)`：`argv`、`cwd`、`stdio`（collect 模式有界缓冲）、`graceMs`、`env`、`signal`；句柄提供 `done`、`collected.*.readFrom(0)`、`terminate()`。
- `timer` 混入：`ctx.timeout(ms)` 用于每次 CLI 调用的超时预算。
- `credentials.resolve(ref)` → `{ value, source } | undefined`；空值视为未配置。
- `sessions.get(id).header.cwd` 作为会话工作区根目录。
- `webServer.register({ kind: 'prefix', path, handler })` 与 `webServer.tapIndex(transform)`；`tapIndex` 必须绑定到服务实例调用。

### Client

- 页签类型两段式注册：`ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })`，正文与标题分别注册到 keyed 席位 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`，key 均为本实现的 `id`。
- 基础模块表只有 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。本插件的客户端 bundle 只 `require("react")`。
- bundle 形态：`window.__ModuleLoader__.load({ id, factory: (require) => module.exports })`（lazy-CJS）。

## 3. 两行行级组成

```yaml
- id: skillre-travel-planner        # 工具、Trip Store、CLI 网关、travelPlanner 能力
- id: skillre-travel-planner-web    # 浏览器 API（依赖 webServer + travelPlanner）
```

拆分原因（由隔离 profile 挂载测试发现）：

1. Loader 行并行 apply，任何用 `ctx.get` 在 apply 时读取的服务都可能尚未注册；硬依赖必须写进 `inject`。
2. 嵌套 `ctx.inject` 在 loaden 行内可能绑定到已被替换的 `webServer` 实例，路由随后被销毁。
3. 若主行硬依赖 `webServer`，无 Web GUI 的 profile 将永远不挂载。

因此：主行硬依赖 `tools/timer/fs/subprocess`；Web 行硬依赖 `webServer/travelPlanner`。`credentials` 与 `sessions` 在调用时读取，缺失时降级而不是阻止挂载。

## 4. Host 面

### 工具

| 工具 | 作用 |
|---|---|
| `travel_project_create` | 建立 Trip Project 与逐日骨架 |
| `travel_project_read` | 读取与侧边栏一致的投影（headline / days / places / alerts） |
| `travel_project_patch` | 增量修改，带 `expectedRevision` 与锁定保护 |
| `travel_place_search` | 高德 POI 搜索，可选写入地点库 |
| `travel_route_plan` | 高德路线查询，返回事实而非行程 |
| `travel_day_rebuild_legs` | 重建一天相邻地点的交通段并持久化 |
| `travel_itinerary_validate` | 确定性校验并回落告警 |
| `travel_project_export` | 导出 Markdown / JSON |
| `travel_map_focus` | 让高德容器定位到某天或某点 |

### 浏览器 JSON API

前缀可配置，默认 `/api/skillre-travel`：

- `GET  /state?sessionId=&tripId=` → `{ ok, view, amap }`
- `GET  /health` → `{ ok, configured, missing, amap }`
- `POST /patch` → `{ ok, changed, applied, rejected, violations, revision?, view? }`；revision 冲突返回 409 `REVISION_MISMATCH`
- `POST /focus` → `{ ok, center }`
- `POST /rebuild-legs` → `{ ok, checked, updated, … }`；按天重算已有交通段
- `POST /fill-transits` → `{ ok, planned, skipped, days }`；把「标题声明跨城、当天没有转场」的赶路日批量规划成转场并落盘（请求 `{ sessionId?, tripId?, dayId? }`，省略 `dayId` 即全部天）。走 Web 服务 `/v5/direction/driving`，没有 Key 时才退到 CLI，且**不允许**隐式启动高德容器（容器未运行则该天给出 reason）。

同源校验：请求带 `Origin` 时必须与 `Host` 同源；JSON 边界只传最小数据。

### 存储

`<session cwd>/<workspaceSubdirectory>/projects/<tripId>/trip.json`（默认 `.travel`），导出写入同目录 `exports/`。写入经由 `ctx.fs`，因此继承 DSH 的文件策略。

## 5. Client 面

- 一个 page tab，kind `skillre-travel`，实现 id `@skillre/dsh-plugin-travel-planner`，priority `extension`，并贡献一个引导页入口。
- 内部四个视图：行程 / 地图 / 地点 / 提醒；窄栏只渲染时间轴，面板宽于 560px（全屏或拖宽）时用 container query 增加示意图地图与详情面板，不读 `sidebar.fullscreen`。
- 数据只经 `GET /state` 获取，写操作经 `POST /patch`，全部为最小 JSON。
- 地图是坐标投影示意图（用于判断顺序与折返），精确路网交由高德容器：`在高德地图中查看` 调用 `POST /focus`。
- 样式内联在组件树中，颜色由 `currentColor` 派生，不覆盖全局主题 token。

## 6. 验证证据

已在隔离 profile（`DSH_HOME` 指向临时目录，从 shipped `web` 模板创建）验证：

1. `dsh plugin --profile travel-test add <tarball>` 安装成功；
2. `dsh --profile travel-test --dump-config` 显示两行及配置；
3. 有界真实启动：两行均激活，无 package load / pending activation / client module 失败；
4. `GET /api/skillre-travel/health` 与 `/state` 返回 200；
5. 索引注入了 `window.__SKILLRE_TRAVEL__`；
6. 客户端 bundle 出现在 boot graph 与 `/plugins` combo 响应中；
7. 在一个真实 Trip 文档上验证了投影、`REVISION_MISMATCH` 409、`ITEM_LOCKED` 拒绝与输入校验违规上报。

未完成：在真实浏览器会话中打开该页签的人工视觉确认（本机未运行可被 CDP 接管的 Chrome）。发布前必须补做。

仓库内验证：`npm run check`（typecheck ×2 + 158 个测试 + publint + pack 视图）与 `npm pack --dry-run`。

## 7. 已知限制

- 高德当前契约不含营业时间、评分、图片与实时票价，插件不编造这些数据。
- 公交必须逐城市查询；跨城交通不能伪装成本地公交结果。
- 地图为示意图，不含瓦片或控件。
- 客户端文案仅中文，未接入 `locale` 命名空间。
- 「让 Agent 调整」目前通过模型工具完成，未直接写入输入框。
- 高德容器由插件启动时才会被插件停止（`autoStop`），他人启动的容器不会被关闭。
