# 高德 CLI 集成设计

> 目标：高德 CLI 是地点与本地路线事实的首个 Provider；DSH 右侧栏负责展示这些结构化结果。  
> 当前依据：`amap-gui` Skill 暴露的 `status`、`start`、`stop`、`searchPOI`、`route`、`mapState` 与 `getLastEvent` 命令。

## 1. 能力边界

| 命令 | 产品用途 | MVP |
|---|---|---|
| `searchPOI` | 关键词、城市、中心点和半径搜索 | 核心 |
| `route` | 驾车、步行、骑行、公交路线 | 核心 |
| `status` | 判断容器是否运行及地图是否就绪 | 核心 |
| `start` | 需要时显式启动地图容器 | 核心 |
| `stop` | 仅在本插件拥有进程时自动停止 | 核心 |
| `mapState` | 外部地图容器调试、设置视角 | 开发/辅助 |
| `getLastEvent` | 获取用户在外部高德容器中的最后选择 | 可选增强 |

当前 CLI 的 POI 结果可以提供名称、地址、坐标、电话、类别、距离和高德 POI ID。营业时间、评分、图片、票价等信息不在当前已确认契约内，不能由插件自行补造。

高德的首发覆盖面定位为中国大陆旅行。海外目的地必须通过未来 Provider 扩展，不能假设高德数据完整。

## 2. 总体结构

```text
Model Tool / Host Service
        |
        v
AmapCliGateway
  |- 参数校验
  |- 串行队列
  |- 运行状态检查
  |- 凭据注入
  |- 超时与取消
  |- JSON 解码与 schema 校验
        |
        v
amap-gui CLI -> Electron / AMap JSAPI 2.0
        |
        v
标准化 Place / RouteLeg
        |
        +--> Trip Project
        +--> Client JSON RPC / Remote
        +--> DSH 右侧栏地图与卡片
```

关键决策：

- CLI 是查询路径，不是右侧栏的 DOM 或 React 组件。
- 右侧栏地图需要独立的 Client 渲染适配器；业务事实仍以 Host 标准化结果为准。
- 不从 CLI 的 Electron 页面截图来充当产品 UI。
- Host 与 Client 之间只传最小 JSON 数据。

## 3. CLI 网关职责

建议内部接口：

```ts
interface AmapCliGateway {
  searchPlaces(input: SearchPlacesInput, signal?: AbortSignal): Promise<PlaceSearchResult>
  planRoute(input: PlanRouteInput, signal?: AbortSignal): Promise<RouteLeg>
  readMapState(signal?: AbortSignal): Promise<MapState>
  readLastEvent(signal?: AbortSignal): Promise<AmapInteraction | null>
}
```

调用方不接触 shell 命令字符串，也不直接解析 CLI 原始输出。

### 3.1 命令执行

- 使用可执行文件和参数数组，不拼接未经转义的 shell 字符串。
- 每个参数在进入网关前做长度、枚举和数值范围校验。
- CLI stdout 必须是单个 JSON 结果；stderr 只进入受控诊断。
- 进程退出码非零、JSON 无效、`success: false`、响应超时分别映射为稳定错误码。
- 取消必须终止当前子进程，并让队列继续处理下一项。

### 3.2 串行队列

`amap-gui` 连接共享、带可视状态的地图容器。搜索和路线命令会替换地图上的标记或路线，因此 MVP 默认并发度为 1。

队列需要：

- FIFO；
- 每项独立超时；
- AbortSignal；
- 插件停止时拒绝新请求并清理未开始任务；
- 不让一次失败阻塞后续任务。

后续若 CLI 提供无界面、无共享状态的查询通道，再评估提高并发度。

## 4. 生命周期

每次首次调用前：

1. 确认可执行文件存在并能返回版本；
2. 确认凭据可解析；
3. 执行 `amap-gui status`；
4. 若 `not_running`，显式执行 `amap-gui start`；
5. 仅在 `mapReady: true` 后执行查询。

插件记录：

```text
startedByPlugin: boolean
runtimeState: unknown | stopped | starting | ready | failed
```

清理规则：

- 如果容器原本已经运行，插件停止时不得擅自关闭。
- 只有 `startedByPlugin=true` 且配置允许 `autoStop` 时调用 `stop`。
- 所有子进程、监听、队列和超时都必须归属 Cordis Fiber。
- 异常退出后下一次调用重新走状态检查，不盲目重试写操作。

## 5. 凭据与配置

开发 Skill 可以从 OpenClaw 配置解析 `AMAP_KEY`，但发布的 DSH 原生插件不应硬编码读取 `~/.openclaw/openclaw.json`。

建议原生配置：

```text
amap.executable        默认：amap-gui
amap.webKeyRef         DSH credential ref，必填
amap.securityKeyRef    DSH credential ref，推荐
amap.autoStart         默认：true
amap.autoStop          默认：true，仅停止自己启动的容器
amap.commandTimeoutMs  部署相关，schema 要求显式或提供清晰默认
amap.cache.*            查询缓存策略
```

执行 CLI 时，把解析后的值仅注入当前子进程环境：

- `AMAP_KEY`
- `AMAP_SECURITY_KEY`

不得：

- 写入项目文件；
- 写入日志；
- 出现在 Tool 返回；
- 拼入命令行参数；
- 把真实 Key 放进测试 fixture。

## 6. POI 标准化

CLI `searchPOI` 映射为：

```text
Place
|- id                       插件内部稳定 id
|- provider: amap-cli
|- providerPlaceId          高德 POI id
|- name
|- address
|- point { lng, lat, crs: gcj02 }
|- telephone?
|- categories[]
|- distanceMeters?
|- fetchedAt
|- queryContext
|- status: candidate | planned | excluded | locked
```

规则：

- `[lng, lat]` 不得反转。
- 高德坐标统一标记为 `gcj02`。
- 同一个 `providerPlaceId` 在同一项目内默认去重。
- 同名不同 ID 的地点不能仅凭名字合并。
- UI 展示电话时提供复制操作，但不自动拨号。
- 不持久化不需要的 CLI 原始对象。

## 7. 路线标准化

CLI `route` 映射为：

```text
RouteLeg
|- id
|- fromPlaceId / toPlaceId
|- mode: walking | transit | riding | driving
|- distanceMeters
|- durationSeconds
|- tollsYuan?
|- steps[] { instruction, distanceMeters, durationSeconds }
|- provider: amap-cli
|- fetchedAt
|- status: fresh | stale | failed
```

规划规则：

- 步行、骑行和公交按相邻地点逐段查询。
- 公交必须传城市。
- 驾车途经点最多使用 CLI 当前允许的 16 个，并保留独立地点顺序。
- 多日路线不能合并成一个调用。
- Tool 输出中提供总距离和总时间，详细 steps 按需读取，避免挤占模型上下文。
- 结果用于旅行规划估算，不应被描述成实时导航保证。

## 8. 缓存与新鲜度

建议使用可配置 TTL：

- POI 搜索结果：默认 24 小时；
- 路线结果：默认 6 小时；
- 用户手动“重新查询”绕过缓存；
- 修改端点、出行方式、城市或策略时缓存键必须变化。

缓存记录至少包含 Provider、命令版本、标准化输入、查询时间和结果 schema 版本。过期数据可以继续展示，但必须标记 `stale`，并在进入 `ready` 前重新校验关键路线。

## 9. 右侧栏地图关系

右侧栏中的地图是展示层：

- Place 坐标产生编号 Marker；
- RouteLeg 产生路线 Polyline；
- Marker 与地点卡片共享 `placeId`；
- 选中卡片时地图居中并高亮；
- 选中路线段时只强调该段；
- 地图点击产生插件自己的 Client 交互，不依赖 `getLastEvent`。

`mapState` 和 `getLastEvent` 仅用于外部高德 GUI 联动或开发调试。把它们作为核心 UI 数据源会导致 DSH 页面与 Electron 容器状态竞争。

## 10. 错误模型

建议稳定错误码：

- `AMAP_CLI_NOT_FOUND`
- `AMAP_CREDENTIAL_MISSING`
- `AMAP_START_FAILED`
- `AMAP_NOT_READY`
- `AMAP_COMMAND_TIMEOUT`
- `AMAP_COMMAND_ABORTED`
- `AMAP_COMMAND_FAILED`
- `AMAP_INVALID_RESPONSE`
- `AMAP_NO_RESULT`
- `AMAP_UNSUPPORTED_ROUTE`

用户信息应包含下一步动作，但不得暴露密钥、完整环境或无关堆栈。

## 11. 测试策略

### 单元测试

- 参数到 argv 的映射；
- stdout JSON 校验；
- 经纬度顺序；
- CLI 错误映射；
- 缓存键；
- 串行、取消和超时；
- 仅关闭自己启动的容器。

### 契约测试

使用 fixture 模拟已确认的 CLI JSON，不访问真实凭据。

### 真实集成测试

在显式配置测试 Key 的环境中执行：

1. `status`；
2. 必要时 `start`；
3. 搜索一个固定 POI；
4. 查询一条短步行路线；
5. 校验标准化结果；
6. 按所有权规则决定是否 `stop`。

真实测试不进入默认 CI，且不得打印凭据。
