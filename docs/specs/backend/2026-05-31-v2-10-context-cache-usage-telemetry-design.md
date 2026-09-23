# V2-10 上下文缓存与用量遥测设计

- 类型：后端 spec
- 日期：2026-05-31
- 状态：已实现
- 关联：[V2-9 上下文引擎](2026-05-31-v2-9-context-engine-design.md)

---

## 问题与目标

V2-9 每次启动全量扫盘、snippet 常驻内存，且 DeepSeek cache 用量只在 gateway 内部，界面回落为 0。V2-10 增加只存元数据的持久 manifest、增量扫描、稳定 cache 前缀记账，并把真实用量经 kernel 暴露给 GUI/TUI。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| Manifest 内容 | 仅元数据 | 存 snippet/全文 | 隐私与体积 |
| 增量判据 | path + size + mtime + 策略版本 | 只看 mtime | 减少误复用 |
| Snippet | 选中后懒读 | 扫描时全读 | 启动更快 |
| 用量出口 | `kernel.metrics` | 各端私读 gateway | 单一 facade |
| Manifest 损坏 | 忽略并重建 | 启动失败 | 可用性 |

## 设计

### Manifest

`src/context/context-manifest.js`，默认 `<root>/.deepseek-code/v2/context/manifest.json`：

```js
{
  schema_version: 1,
  project_root_hash, created_at, updated_at,
  files: { "<rel>": { path, hash, bytes, token_count, priority, reason, mtime_ms, size, indexed_at } },
  stats: { indexed_files, skipped_files, reused_files, changed_files }
}
```

禁止 snippet / content / 原文 / 明文绝对路径。原子写（临时文件 + rename）。损坏即当空。

### 增量扫描

`context-cache.js`：`load manifest → walk → stat → 未变复用元数据 / 变更安全读并重建 → save`。统计 `scanned_files`、`indexed_files`、`skipped_files`、`reused_files`、`changed_files`、`manifest_loaded/saved`、`scan_duration_ms`。

### 懒水合

`ContextRecord`（可进 manifest）与 `HydratedContextUnit`（record + snippet，仅内存）分离。`snapshot()` 先按元数据排序，再只读选中文件。读失败跳过并计 `hydrate_skipped_files`，不中断快照。

### 稳定前缀

P0 固定顺序：`package.json`、`README.md`、`environment.yml`、`pyproject.toml`、`Cargo.toml`、`go.mod`。P0 标签与分隔稳定；P1/P2 可随消息变化。`expected_cache_prefix_offset` 只计 P0。不保证供应商缓存命中，但提高同项目多轮前缀复用。

### 用量 facade

`kernel.metrics.getUsage()` / `getContext()` / `getSnapshot()`。`getUsage` 取 `modelGateway.getUsageStats()`（含 `cache_hit_tokens`、`cache_miss_tokens`、hit rate）。不暴露密钥、原始请求、snippet。GUI host 优先 `kernel.metrics.getUsage()`，TUI 同源。

### 事件与配置

事件：`context:cache_loaded`、`context:cache_saved`、`context:cache_reused`，载荷限计数与时长。

`options.context`：`disabled`、`persistent`、`cacheRoot`、`manifestName`、`maxFiles`、`maxFileBytes`、`maxSnippetBytes`、`budgets`。测试必须临时 `cacheRoot` 或 `disabled`，避免污染仓库。

## 边界与不变量

1. Manifest 仅元数据白名单字段。
2. 凭据与隐藏工具配置目录继续跳过。
3. 读文件仍走 `readWorkspaceTextFile`。
4. Cache 文件不写到选定 root 之外。
5. 事件不含文件内容。

## 与现状的差异

语义层增量缓存见 `src/context/semantic/symbol-cache.js` 与 Phase B spec。配置键如与 `src/config.js` 冲突，以代码为准。

## 验收

Manifest 无内容字段；重启可复用未变元数据；变更重读；快照仍带选中 snippet；隐藏/凭据文件不进 snapshot 与 manifest；`metrics.getUsage()` 有真实 cache 统计；GUI 走 metrics；事件无泄漏。入口 `npm test`、`npm run check`。
