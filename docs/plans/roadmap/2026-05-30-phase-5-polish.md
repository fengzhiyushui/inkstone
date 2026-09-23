# Phase 5: Polish — Implementation Plan

- 类型：路线图
- 日期：2026-05-30
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md)、[Phase 2](2026-05-30-phase-2-security-extension.md)、[Phase 4](2026-05-30-phase-4-gui.md)

## 目标

补齐延后功能（web_fetch 真实现、memory/task 工具、多测试框架探测），按 v1 架构重写 README，收口集成。

## 结果

Phase 5 填前几阶段留下的缺口，不新增 kernel 模块，只改既有文件。Tech stack：Node ≥ 20、既有 kernel 模块、`node:child_process`（测试探测）。

**web_fetch 真实现**：替换占位符，带 SSRF 保护（拦 localhost / 127.0.0.1 / 0.0.0.0 / `[::1]` / 169.254.* 与私网段 `10.*`、`172.16-31.*`、`192.168.*`），只允许 http/https，`AbortSignal.timeout(10000)`，输出截断 32000 字符，metadata 含 status / content_type / original_length。超时报 `Request timed out after 10s`。

**memory 工具**（延自 Phase 2）：read/write/list/delete，按项目哈希落在 `~/.deepseek-code/projects/<hash>/memory/`，键名 sanitize 为 `[a-zA-Z0-9._-]` 最长 64，每条记录含 time / key / value / trace_id。list 返回空时提示 `No memories stored.`。

**task 工具**（延自 Phase 2）：基础任务项实现。

**多测试框架探测**：`runTest` 从仅 `node --test` 扩展到识别 pytest / cargo / go test，经 `node:child_process` 执行。

**README**：按完整 v1 架构重写。

File structure（V1 落地）：

```text
Modify:
  src/kernel/tool-registry.js  — Real web_fetch, add memory/task tools
  src/cli.js                   — Multi test-framework detection (runTest)
  README.md                    — Rewrite with v1 architecture docs
  package.json                 — Update check with any new files
```

后续 V2 重构把工具迁到 `src/tools/builtin/*`：`web-fetch.js`、`memory.js`、`task.js`、`test.js`，SSRF 统一由 `src/security/ssrf.js` 校验。

## 关键决策 / 遗留约束

- 不新增 kernel 模块，只改既有文件。
- web_fetch 输出上限 32000 字符，避免撑爆上下文；SSRF 拦私网是安全基线。
- memory 键名 sanitize 防路径注入；记录带 trace_id 便于追踪。
- 测试框架探测是尽力识别，不保证覆盖全部 monorepo 布局。
- README 重写面向完整 v1 架构，后续 V2 演进再更新。

## 验证

V1 测试覆盖工具执行与 CLI `runTest`。手工验证 web_fetch 拦私网、memory 四操作、多框架探测。当前对应入口：`src/tools/builtin/web-fetch.js`、`src/tools/builtin/memory.js`、`src/tools/builtin/task.js`、`src/tools/builtin/test.js`、`src/security/ssrf.js`。

## 任务覆盖（as-built 映射）

Task 1 真实工具实现（web_fetch SSRF + fetch、memory 四操作、task 基础项）→ Task 2 多测试框架探测（pytest / cargo / go test）→ Task 3 README 重写 v1 架构 → Task 4 集成（check 脚本 + 全量）。不新增 kernel 模块，只改既有文件。
