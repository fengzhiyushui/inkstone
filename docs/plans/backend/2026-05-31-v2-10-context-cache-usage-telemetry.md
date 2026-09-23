# V2-10 Context Cache & Usage Telemetry

- 类型：实施计划
- 日期：2026-05-31
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[V2-9 Context Engine](2026-05-31-v2-9-context-engine.md)、[设计](../../specs/backend/2026-05-31-v2-10-context-cache-usage-telemetry-design.md)

## 目标

补上仅元数据的 context 缓存、增量工作区扫描、稳定快照 hydration，并把真实 DeepSeek 用量遥测经 V2 内核暴露。

## 结果

V2-9 公开 context API 保持不变。索引记录拆成仅元数据 manifest 与内存内 hydrated unit。GUI/TUI 改为读 `kernel.metrics`，不再摸私有 gateway。

### 文件结构

创建：

| 路径 | 职责 |
|------|------|
| `src/context/context-manifest.js` | 仅元数据 manifest 读写与消毒 |
| `src/context/context-cache.js` | manifest 增量扫描与惰性 hydration |
| `tests/unit/context/context-manifest.test.js` | schema、消毒、原子写、损坏容忍 |
| `tests/unit/context/context-cache.test.js` | 增量复用、变更重读、hydrate |
| `tests/integration/v2-context-cache-kernel.test.js` | 内核级缓存行为 |
| `tests/integration/v2-usage-metrics.test.js` | metrics 门面 |

修改：`workspace-indexer.js`（导出 skip/元数据帮助函数）、`context-unit.js`（元数据记录与 hydrate）、`context-snapshot.js`（保持形状并带 cache stats）、`context/index.js`（默认走缓存扫描）、`src/index.js`（metrics 门面）、`src/sessions/event-types.js`、`gui/kernel-host.js`、`src/tui.js`、相关既有测试、`package.json`。

### Manifest 契约

`createEmptyManifest({ root, now })` / `loadContextManifest` / `saveContextManifest` / `sanitizeManifestRecord` / `projectRootHash`。

| 字段 | 说明 |
|------|------|
| `schema_version` | 当时为 1 |
| `project_root_hash` | `projectRootHash(root)` |
| `created_at` | 时间戳 |
| `files` | path → 元数据记录 |

`sanitizeManifestRecord` 允许字段包括 `path`、`hash`、`bytes`、`token_count`、`priority`、`reason`、`mtime_ms`、`size`、`indexed_at`。强制剥离 `snippet`、`content`、绝对路径等。

行为锁定：

- 原子写；损坏 manifest 可容忍重建。
- manifest 不含源码、API key、绝对路径。
- 隐藏 IDE/工具配置目录与凭据形态文件不进 manifest。

### Cache 与快照

`scanContextWithCache()` 为默认扫描路径：

- 未变文件复用 manifest 元数据。
- 变更文件重读并更新元数据。
- snippet 只在选中 hydration 时读入内存。
- 快照 `summary` 仍为选中文件保留有界 snippet。
- 快照公开形状与 V2-9 保持稳定，并附带 cache stats。

### 指标门面

| API | 行为 |
|-----|------|
| `kernel.metrics.getUsage()` | 有网关时返回 `modelGateway.getUsageStats()`，否则零值 |
| `kernel.metrics.getContext()` | `contextEngine.getStats()` |
| `kernel.metrics.getSnapshot(input)` | 脱敏后的 context 快照 |

GUI `kernel-host.js` 优先读 `kernel.metrics.getUsage()`，不再访问私有 gateway。TUI 在指标缺失时可渲染 token/cache 字段而不抛错。

### 事件

| 事件 | 载荷 |
|------|------|
| `context:cache_loaded` | 计数、耗时 |
| `context:cache_saved` | 计数、耗时 |
| `context:cache_reused` | 计数、耗时 |

事件只含 counts/durations。

### 验收锁定清单（当时完成标准）

- manifest 不含 `snippet`、`content`、源码、API key、绝对路径。
- 二次扫描复用未变文件。
- 修改文件重读并更新 manifest 元数据。
- 快照 summary 仍为选中文件含有限 snippet。
- 隐藏 IDE/工具配置目录与凭据形态文件不在 manifest 与快照中。
- `kernel.metrics.getUsage()` 有网关时返回用量。
- `gui/kernel-host.js` 经 `kernel.metrics` 读用量。
- `src/tui.js` 在指标缺失时不抛错。
- 缓存事件已注册，且只含计数/耗时。
- 全量测试、语法检查、空白检查、污染检查通过。

## 关键决策 / 遗留约束

| 决策 | 选择 | 否决 | 原因 |
|------|------|------|------|
| 缓存内容 | 仅元数据 | 缓存文件正文 | 降低泄漏面 |
| 加载时机 | 选中后惰性 hydrate | 全量进内存 | 大仓可扩展 |
| API 稳定性 | 保持 V2-9 对外 API | 另开第二套 context API | 调用方不改 |
| 遥测入口 | `kernel.metrics` | UI 直摸 gateway | 单一事实来源 |
| manifest 修复 | 损坏重建 | 启动失败 | 可用性优先 |

遗留约束：

- 不改 V0/V1 context 文件。
- 测试用临时 `root` 与 `context: { cacheRoot: ... }`，不污染仓库。
- 指标为零值时不把「无数据」渲染成错误。
- 语义上下文扩展见后续 V3 计划。
- 不加依赖。
- Windows 命令统一 `npm.cmd`。

## 验证

| 测试 | 锁定行为 |
|------|----------|
| `tests/unit/context/context-manifest.test.js` | schema v1、消毒剥离、原子写、损坏容忍 |
| `tests/unit/context/context-cache.test.js` | 二次扫描复用、变更重读、惰性 hydrate |
| `tests/unit/context/context-engine.test.js` | 默认走缓存路径后 API 不变 |
| `tests/integration/v2-context-cache-kernel.test.js` | 内核事件与 stats |
| `tests/integration/v2-usage-metrics.test.js` | `metrics.getUsage/getContext/getSnapshot` |
| `tests/unit/gui/kernel-host.test.js` | 经 metrics 读用量 |
| TUI metrics 测试 | 缺指标不抛错 |

当时全量 `npm.cmd test`、`npm.cmd run check`、`git diff --check` 通过。测试数量应高于 V2-9 基线（406）。

现对应入口：

- `src/context/context-manifest.js`
- `src/context/context-cache.js`
- `kernel.metrics`
