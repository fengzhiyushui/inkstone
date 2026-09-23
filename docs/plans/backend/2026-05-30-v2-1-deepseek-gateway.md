# V2-1 DeepSeek Gateway

- 类型：实施计划
- 日期：2026-05-30
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[V2-0 Skeleton](2026-05-30-v2-0-skeleton-protocol-foundation.md)

## 目标

建成 DeepSeek 原生模型网关 `src/deepseek/*`，覆盖 Flash/Pro 路由、显式 JSON mode、SSE 流式解析、tool-call 载荷保留、FIM 补全、缓存感知用量统计、API 错误分类与 V2 运行时中断。

## 结果

`src/deepseek` 成为唯一 DeepSeek API 适配层，并接入 `createKernel(root, { deepseek })`。测试继续可注入 mock `modelGateway`。gateway 接受注入 `fetch` 与可选 config，全部行为可离线验证。V2 运行时本阶段仍是单轮回复；工具、编辑、审批、repair 仍在后续计划。

### 范围

做：

- `reply`、`plan`、`act`、`review`、`repair`、`fim` 的模型路由。
- chat / 流式 chat / JSON mode / tool call / FIM 的请求体构造。
- 显式 JSON mode 守卫。
- SSE 解析。
- 含缓存 token 字段的 usage tracker。
- API 错误格式化与可重试分类。
- FIM client。
- 内核集成：真实网关与 mock 注入并存。
- 语法检查脚本更新。

不做：工具执行、diff 应用、审批 UI、持久会话、CLI/TUI/GUI 迁移。

### 文件结构

```text
src/deepseek/model-router.js
src/deepseek/json-mode.js
src/deepseek/usage-tracker.js
src/deepseek/api-errors.js
src/deepseek/streaming.js
src/deepseek/fim-client.js
src/deepseek/tool-call-repair.js
src/deepseek/prompt-assembler.js
src/deepseek/model-gateway.js
tests/unit/deepseek/model-router.test.js
tests/unit/deepseek/json-mode.test.js
tests/unit/deepseek/usage-tracker.test.js
tests/unit/deepseek/api-errors.test.js
tests/unit/deepseek/streaming.test.js
tests/unit/deepseek/fim-client.test.js
tests/unit/deepseek/model-gateway.test.js
tests/integration/v2-deepseek-gateway-runtime.test.js
```

修改：`src/index.js`、`package.json`。

### 模块契约

| 模块 | 导出与行为 |
|------|------------|
| `model-router.js` | `routeModel({ purpose, complexity, explicitModel, models })`、`buildChannelParams`、`removeUndefined`。未知 purpose 抛 `unknown DeepSeek purpose: …`。`reply` + `complexity: "high"` 映射到 plan 通道。 |
| `json-mode.js` | 仅当 system/user 消息已含 `json` 时追加 `response_format: { type: "json_object" }`；否则本地抛错。普通 chat 不加该字段。 |
| `usage-tracker.js` | 内存聚合缓存命中/未命中与 reasoning token。 |
| `api-errors.js` | `formatDeepSeekApiError`、`createDeepSeekApiError`、`isRetryableDeepSeekError`。 |
| `streaming.js` | 纯 SSE 解析与 streamed chat 组装。 |
| `fim-client.js` | FIM 请求体构造与 beta endpoint 调用。 |
| `tool-call-repair.js` | 模型 tool call 的安全解析与规范化，本阶段保留不执行。 |
| `prompt-assembler.js` | V2 轮次输入 → 稳定 DeepSeek messages。 |
| `model-gateway.js` | `reply`、`invoke`、`stream`、`fimComplete`、`getUsageStats`。 |

### 通道与默认参数

| purpose | 通道 | 默认模型 | thinking | temperature | max_tokens | stream |
|---------|------|----------|----------|-------------|------------|--------|
| `reply` | act | `deepseek-v4-flash` | disabled | 0.2 | 4096 | true |
| `act` | act | `deepseek-v4-flash` | disabled | 0.1 | 4096 | true |
| `plan` | think | `deepseek-v4-pro` | enabled + `reasoning_effort: "high"` | 0.2 | 8192 | false |
| `review` | think | `deepseek-v4-pro` | enabled + `reasoning_effort: "high"` | 0.2 | 8192 | false |
| `repair` | think | `deepseek-v4-pro` | enabled + `reasoning_effort: "high"` | 0.1 | 8192 | false |
| `fim` | fim | `deepseek-v4-pro` | 无 | — | 512 | — |

`DEFAULT_MODELS` 当时为 `act: deepseek-v4-flash`、`think: deepseek-v4-pro`、`fim: deepseek-v4-pro`。`explicitModel` 可覆盖。`buildChannelParams` 输出已去除 `undefined` 字段。

### DeepSeek 官方约束（实现时锁定）

- Chat 模型为 `deepseek-v4-flash` 与 `deepseek-v4-pro`。
- thinking 由 `thinking: { type: "enabled" }` / `{ type: "disabled" }` 控制。
- `stream: true` 返回 SSE，行以 `data:` 开头，以 `data: [DONE]` 结束。
- 流式 usage 需要 `stream_options: { include_usage: true }`。
- JSON Output 需要 `response_format: { type: "json_object" }`，且 prompt 明确含 `json`。
- tool call 的 `arguments` 是模型产出的 JSON 字符串，必须保留；本阶段不执行。
- usage 含 `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、`completion_tokens_details.reasoning_tokens`。
- FIM 打 `https://api.deepseek.com/beta/completions`，字段 `prompt`、可选 `suffix`，不带 thinking 与 chat 专属字段。

参考文档：Chat Completion、Tool Calls、JSON Output、FIM Completion（api-docs.deepseek.com）。

### 错误语义

`createDeepSeekApiError(status, text)` 生成 `DeepSeekApiError`：

| 字段 | 值 |
|------|-----|
| `name` | `"DeepSeekApiError"` |
| `code` | `"DEEPSEEK_API_ERROR"` |
| `status` | HTTP 状态码 |
| `retryable` | 布尔 |
| `message` | `DeepSeek API <status>: <parsed message>`，截断到 220 字符 |

可重试判定：

- HTTP 408、409、425、429、500、502、503、504
- `finish_reason: "insufficient_system_resource"`

错误体解析失败时退回截断后的原始 text。

### 行为锁定

- 普通 chat 经 `createKernel(..., { deepseek })` 返回模型文本，不带 `response_format`。
- JSON mode 显式 opt-in，缺 `json` 提示词时本地抛错，不发请求。
- 流式 chat 从 SSE 解析，不用 `response.json()`。
- 流式 usage chunk 更新缓存命中/未命中统计。
- `reasoning_content` 只作内部数据返回，约定隐藏，不进用户可见字符串、不进 session 事件。
- tool call 被保留并规范化，但本阶段不执行。
- `kernel.agent.interrupt()` 经 `AbortSignal` 中断在途 DeepSeek 请求。
- 被中断的陈旧 turn 不能发布 `agent:final`，也不能解锁更新的 turn。
- `options.modelGateway` 仍覆盖真实网关，V2-0 mock 注入测试继续通过。

### 验收锁定清单（当时完成标准）

- 普通 chat 不带 `response_format`。
- JSON mode 显式 opt-in，缺 `json` 本地抛错。
- 流式 chat 从 SSE 解析，不用 `response.json()`。
- 流式 usage 更新 cache hit/miss。
- `reasoning_content` 作内部数据，标记隐藏。
- tool call 保留并规范化，不执行。
- FIM 用 `/beta/completions`，不带 chat-only 字段。
- `kernel.agent.interrupt()` 经 AbortSignal 中断在途请求。
- V2-0 mock 注入测试继续通过。
- `npm.cmd test` 与 `npm.cmd run check` 通过。

## 关键决策 / 遗留约束

| 决策 | 选择 | 否决 | 原因 |
|------|------|------|------|
| 适配边界 | 单一 `src/deepseek` | 散落进 runtime/tools | wire format 只在网关变化 |
| JSON mode | 显式 opt-in | 默认常开 | DeepSeek 要求 prompt 含 `json`，默认开会误伤普通 chat |
| 流式解析 | 自研 SSE | 依赖 SDK | 无新依赖，chunk 边界可控 |
| 测试网络 | 注入 `fetchImpl` | 打真实 API | 回归离线、可重复 |
| tool call | 本阶段只规范化 | 立即执行 | 执行面留给工具平面 |
| 中断 | AbortSignal | 轮询取消标志 | 与 fetch 原生取消一致 |

遗留约束：

- 不改 legacy `src/provider.js` 与 V1 `src/kernel/model-provider.js`。
- 不加运行时依赖；`config.getPublicConfig()` 不暴露 API key。
- DeepSeek tool-call wire format 若与 mock 不一致，在网关边界适配，不改工具实现。
- 后续 V2-17 让 `modelGateway` 转发 `options.history`，prompt-assembler 接受对话历史。
- Windows 验证命令统一 `npm.cmd`。
- 无关脏文件保持不动。

## 验证

| 层 | 测试 | 锁定行为 |
|----|------|----------|
| 单测 | `model-router.test.js` | purpose 路由、thinking/temperature/max_tokens、high-complexity 升级 |
| 单测 | `json-mode.test.js` | opt-in 与缺 `json` 抛错 |
| 单测 | `usage-tracker.test.js` | cache hit/miss 与 reasoning 累计 |
| 单测 | `api-errors.test.js` | 错误形状与 retryable 矩阵 |
| 单测 | `streaming.test.js` | `data: [DONE]`、chunk 边界、reasoning/usage/tool-call delta |
| 单测 | `fim-client.test.js` | `/beta/completions` 与字段裁剪 |
| 单测 | `model-gateway.test.js` | reply/invoke/stream/fimComplete/getUsageStats |
| 集成 | `v2-deepseek-gateway-runtime.test.js` | kernel + 真网关类 + mock fetch 跑通 runtime |

当时全量 `npm.cmd test`、`npm.cmd run check` 通过。测试数量应高于 V2-0 基线（154+）。

现对应入口：

- `src/deepseek/model-gateway.js`、`src/deepseek/model-router.js`
- 中断路径 `src/core/runtime/agent-runtime.js`
- 用量 `kernel.metrics.getUsage()` → `modelGateway.getUsageStats()`
