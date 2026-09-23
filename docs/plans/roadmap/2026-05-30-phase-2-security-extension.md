# Phase 2: Security & Extension — Implementation Plan

- 类型：路线图
- 日期：2026-05-30
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[Phase 1](2026-05-29-phase-1-core-intelligence.md)、[Phase 5](2026-05-30-phase-5-polish.md)

## 目标

建权限引擎（信任层级、策略矩阵、autonomy 门控、shell 匹配、TTL 指纹）与工具注册表（内置工具、ToolDefinition/ToolCall/ToolResult、经权限引擎的执行链）。

## 结果

依赖顺序 Permission Engine（独立）→ Tool Registry（依赖 Permission Engine）。Tech stack：Node ≥ 20 ESM、`node:crypto`（指纹哈希）、Phase 0 EventBus（审计事件）。`memory` 与 `task` 工具延到 Phase 3/5。

**Permission Engine**（`src/kernel/permission-engine.js`）：独立决策函数。给定 ToolCall + 上下文（autonomy level、project root、trust store），返回 allow/deny/ask 与命中规则信息。含信任层级、8×4 策略矩阵、autonomy 门控、shell 路径匹配、TTL 指纹缓存放行。`DEFAULT_POLICY_MATRIX` 按 category × autonomy 定默认。

**Tool Registry**（`src/kernel/tool-registry.js`）：维护 ToolDefinition 映射，执行链走 Permission Engine → Executor。内置工具带 `category` / `risk_level` / `side_effect` / `params` schema，工作区边界保护。

File structure（V1 落地）：

```text
Create:
  src/kernel/permission-engine.js   — Decision engine (trust hierarchy, matrix, shell matching)
  src/kernel/tool-registry.js       — Tool registry + built-in tools + execution chain
  test/kernel/permission-engine.test.js
  test/kernel/tool-registry.test.js
Modify:
  package.json                      — Add new kernel files to "check" script
```

测试 105 项：permission-engine 13（含完整 8×4 矩阵）、tool-registry 9（含工作区边界保护）、既有 83。

后续 V2 对应能力：

| V1 模块 | V2 承接 |
|---------|---------|
| permission-engine | `src/tools/permissions/permission-engine.js`（`DEFAULT_POLICY_MATRIX`、`createPermissionEngine`、`globMatch`）、`approval-cache.js`、`policy-loader.js` |
| tool-registry | `src/tools/registry.js`、`executor.js`、`schema.js`、`src/tools/builtin/*` |

命令级策略在 v1.3.0 #7 补 `src/security/command-policy.js`（`classifyCommand` → safe/dangerous/forbidden）。V1 的 `src/kernel/*` 已于 V2-19 删除。

## 关键决策 / 遗留约束

- 权限决策是纯函数，便于单测；信任层级与 TTL 指纹缓存放行演进为 `approval-cache`。
- 策略矩阵按 category × autonomy 定默认；未知类别回落 `ask`。
- 工具执行必须过权限门；工作区边界由 `path-safety` 兜底。
- `memory` / `task` 不在本阶段，见 Phase 5；sub-agent 委托另议。
- 审计事件经 Phase 0 EventBus 发出，便于后续 SessionLog 落盘。

## 验证

V1 测试 `test/kernel/{permission-engine,tool-registry}.test.js`（随 V2-19 删除）。`node --test test/patch.test.js test/kernel/*.test.js` 105 PASS。当前对应入口：`src/tools/permissions/permission-engine.js`、`src/tools/registry.js`、`src/tools/executor.js`、`src/tools/builtin/index.js`、`src/workspace/path-safety.js`、`src/security/command-policy.js`。

## 任务覆盖（as-built 映射）

Task 1 Permission Engine（13 测试：gated 允许 write_update、8×4 矩阵、信任层级、shell 匹配、TTL 指纹）→ Task 2 Tool Registry（9 测试：注册、执行链过权限门、工作区边界保护）→ Task 3 集成（check 脚本 + 105 全绿）。依赖顺序 Permission Engine → Tool Registry。Deferred：memory 与 task 工具到 Phase 3/5。
