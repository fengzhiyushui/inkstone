# V2-19 删除 V1 Legacy 架构 Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** 删除与 V2 并存的**死掉的 V1 架构**,在**不影响任何在用功能**的前提下消除双重代码库。

**依据审计(2026-06-25):**
- 完全无引用(死):`src/agent.js`、`src/chat.js`;`src/ui.js`(仅 agent.js 用)。
- `src/kernel/*`(V1 内核 10 文件):V2 子系统**完全不引用**;唯一外部引用是 `config.js:157` re-export `DEFAULT_MODEL_PROFILES`,而该 re-export **无 V2 消费者**(仅 `test/kernel/*` 直接从 kernel 导入)。
- `test/kernel/*`(9 个 V1 内核测试):随 kernel 一起删。

**保留(被 V2 共享或在用命令依赖,删除会丢功能):**
`config.js`、`provider.js`、`context.js`、`patch.js`、`changes.js`、`search.js`、`git.js`、`tui.js`、`theme.js`、`test/patch.test.js`。
(其中 `patch.js`/`changes.js`/`git.js` 已被 `src/edits/*`、`src/tools/builtin/git.js` 依赖——属 V2 共享,**非** legacy。)

**不影响的命令:** `scan`(context)、`search`(search)、`diff`(git)、`changes`/`rollback`(changes)、`config`(config/provider)、`tui`(tui);`ask`/`edit`/`chat`/`test` 已走 V2。

---

### Task 1: 删除死 legacy + 修正引用

**Files:**
- Delete: `src/agent.js`、`src/chat.js`、`src/ui.js`
- Delete: `src/kernel/`(config-provider, context-engine, event-bus, kernel-api, model-provider, permission-engine, session-log, session-manager, task-orchestrator, tool-registry)
- Delete: `test/kernel/`(9 个测试)
- Modify: `src/config.js`(删除第 157 行 `DEFAULT_MODEL_PROFILES` re-export)
- Modify: `package.json`(check 脚本删除 10 个 `src/kernel/*.js` 引用)

- [ ] **Step 1: 删除文件**

```bash
git rm src/agent.js src/chat.js src/ui.js
git rm -r src/kernel test/kernel
```

- [ ] **Step 2: 删除 config.js 的 re-export**

删除 `src/config.js` 末行:
```js
export { DEFAULT_MODEL_PROFILES } from "./kernel/config-provider.js";
```

- [ ] **Step 3: package.json check 脚本去除 kernel**

从 `scripts.check` 中删掉这一段(及其 `&&` 连接):
```
node --check src/kernel/event-bus.js src/kernel/session-log.js src/kernel/config-provider.js src/kernel/kernel-api.js src/kernel/model-provider.js src/kernel/context-engine.js src/kernel/task-orchestrator.js src/kernel/permission-engine.js src/kernel/tool-registry.js src/kernel/session-manager.js &&
```

- [ ] **Step 4: 验证 —— 语法 + 全量测试 + CLI 启动**

Run: `npm run check` → 退出码 0(不再引用 kernel)。
Run: `npm test` → 全绿(总数下降:移除 test/kernel/* 的若干用例;其余无回归)。
Run: `node bin/deepseek-code.js help` → 正常打印帮助(证明 cli.js 及其保留依赖链完好)。
Run: `node bin/deepseek-code.js config show` → 正常(证明 config.js 改动无碍)。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor(v2-19): delete dead V1 legacy architecture"
```

---

### Task 2: 文档同步

- [ ] **Step 1: README**
更新「目录导览」「已知限制」——移除 V1 `src/kernel/*`、`src/agent.js` 仍保留的表述;说明 V1 并存架构已删除,保留的工具模块(patch/changes/context/git 等)现属 V2 共享依赖。

- [ ] **Step 2: CHANGELOG**
在 `## V1 — 原始实现(legacy)` 段标注:V1 内核与 agent/chat/ui 已于 V2-19 删除;`## [Unreleased]` 追加 V2-19 条目。

- [ ] **Step 3: 提交**

```bash
git add README.md docs/CHANGELOG.md docs/README.md
git commit -m "docs: record V2-19 legacy removal"
```

---

## 范围说明

- 本切片**只删验证为死的 V1 架构**,不动任何在用命令的实现模块——严格遵守"主体功能不受影响"。
- `apps/` 目录收敛、共享工具模块(patch/changes/context)从 legacy 位置迁入更合适的 V2 目录,属可选的后续整理,不在本切片(避免扩大改动面与风险)。
- `provider.js` 的 `askDeepSeek`(删 agent.js 后变死代码)暂留;可在后续清理中移除其死导出。

> 依据:[V3 路线图 §5](../../specs/architecture/2026-06-24-v3-roadmap-design.md)。
