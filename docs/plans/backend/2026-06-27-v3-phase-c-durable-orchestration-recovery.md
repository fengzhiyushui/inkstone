# V3 Phase C-Durable · 跨进程编排级 durable 恢复 Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** 让编排回合(orchestration round)在崩溃/重启后能从暂停点续跑 —— 重启后精确重水化被暂停的 worker turn(Option B「完整 worker turn 重水化」),审批落到其原在途工具调用,而非重派整个 subtask。

**Architecture:** 暂停时落两份 sidecar(既有 worker turn sidecar + 新增编排 sidecar,同 `approvalId` 关联);重启时 `recovery-service` 扫 `orchestration-paused/` 并与 worker sidecar 交叉校验后登记 inbox;续跑时经校验门 → `worker-factory` 确定性重建 worker → 共享 `pausedTurnStore` 让重建 worker 的 `approve` 命中恢复记录 → 重水化其 turn → 结算 → `resumeDispatchLoop` 续本回合 → `driveFrom` 续后续回合。`agent-runtime.js` 一行不改,全靠既有注入依赖(`pausedTurnPersistence` + 共享 `pausedTurnStore`)。

**Tech Stack:** Node.js 24 (ESM), `node:test` + `node:assert/strict`, 现有 recovery 原语(`atomic-file` / `recovery-faults`)、编排原语(`orchestrator` / `dispatch-loop` / `worker-factory` / `subtask-schema`)。无新第三方依赖。

---

## Global Constraints

> 每个 Task 的要求都隐含包含本节。值逐字取自 spec §5(硬约束)。

- **CST-1 `agent-runtime.js` 一行不改。** worker turn 的持久化/重水化只靠既有注入依赖:`pausedTurnPersistence`(worker 继承 → 暂停自动落 `paused/<approvalId>.json` sidecar,含 `resume_state.pending_tool_call`)与可注入的 `pausedTurnStore`(`createAgentRuntime({ pausedTurnStore })` 配置位,[agent-runtime.js:37](../../../src/core/runtime/agent-runtime.js#L37))。
- **CST-2 opt-in 零回归。** 全部新行为 gated on `options.recovery.enabled === true`([index.js:50](../../../src/index.js#L50))。`recovery.enabled=false`(默认)→ 不注入 `orchPersistence`、不注入共享 `pausedTurnStore`、不扫 `orchestration-paused/` → **C5 同进程续跑逐字节不变**,现有 **739 全绿基线**不动。`recovery-service` 仅在 recovery 开启时才被构造([index.js:384](../../../src/index.js#L384)),故 M6 改动只作用于 recovery-ON 路径。
- **CST-3 确定性。** 重建 worker 由持久化的 `subtask` 唯一确定(`worker-factory.worker(subtask)` 的工具子集 + 作用域全从 subtask 推出);续跑回合逻辑复用 C5(不重 plan、不重复派发、结算单一来源 `allCollected`)。
- **CST-4 边界①孤儿一律 blocked。** worker sidecar 带 `__orchestration` 标记但其编排 sidecar 缺失/损坏/版本不符 → `blocked_recovery`(**绝不**降级为单 agent resume);编排 sidecar 在、worker sidecar 缺/consumed/损坏 → 编排项同样 `blocked_recovery`。仅**无** `__orchestration` 标记的普通单 agent sidecar 才走既有单 agent resume。
- **CST-5 边界②不存 raw `options`。** 编排 sidecar 只存白名单(`schemaVersion`/`fingerprints`/ids/`message`/`done_when`/`autonomy`/`plan`/`round`/`env.{root,orchestrationConfig}`/`allCollected`(裁剪)/两套 seen/`budget`(配额+已花)/`adoptedExperienceIds`/`riskCues`/`pausedSubtask`/`remaining`)。**绝无** raw `options` / worker 实例 / 闭包 / `eventBus` / 回调 / 权限上下文活对象 —— 活对象恢复时由 kernel 重注入。worker sidecar 的 `resume_state.options` 仅含 orchestrator 注入的小集(`autonomy`/`projectRules`/`__orchestration`)。
- **CST-6 边界③版本/指纹门。** sidecar 存 `schemaVersion` + `fingerprints`(`workerFactory`/`toolSubset`/`subtaskSchema`);恢复前(扫描登记 **且** resume 前)校验匹配当前代码常量,不匹配 → `blocked_recovery`,**不重建、不 approve**。
- **CST-7 边界④approval 归属校验。** 共享 store 下,resume 前校验 `approvalId`(两 sidecar 同键)/`taskId`/`sessionId`/`pausedSubtask.id` 与 worker sidecar 的 `resume_state.options.__orchestration` 一致,且 worker sidecar 确带 `__orchestration`(turn owner 类型一致)。任一不符 → `blocked_recovery`。
- **CST-8 边界⑤预算续扣。** 编排 sidecar 存**原配额 + 已花计数**;恢复后 `budget` 重建为「配额 − 已花」继续扣(`createCostBudget` 新增 `initialTokens`/`initialModelCalls` 种子),**绝不重置**。
  > **注(实现细节,防误判):** 当前编排聚合 `state.budget` 只被 `.exceeded()` 读、其 `recordModelResult` 尚未被编排层调用(worker/planner 各持自己的 agent-runtime 预算),故真实 `已花` 现为 0。本片只负责**忠实序列化 + 续扣重建**(spentTokens/spentCalls 从 `budget.snapshot()` 取、恢复时 reseed);续扣**数学**由 M0/M2 单测用显式 `recordModelResult` 打点验证。M8 e2e 只断言 sidecar 携带 quota+spent **字段**,不依赖非零 spend。将来若把聚合记账接上,续扣自动生效。
- **CST-9 幂等清理。** 完成/取消 → 删编排 sidecar(consume 墓碑)+ worker sidecar 由 agent-runtime `approve` 置 consumed;启动扫描 consumed/孤儿沿用既有隔离机制。
- **CST-10 node:test。** 全部测试用 `node:test` + `node:assert/strict`,确定性优先(mock gateway/store/worker,不打真实网络)。运行:`npm test`(= `node --test test/**/*.test.js tests/**/*.test.js`);语法闸:`npm run check`(**新增源码文件必须登记进 `package.json` 的 `check` 脚本**)。

### 写序 / 崩溃窗口 —— spec §5.6 的落地澄清(实施前请 reviewer 确认)

spec §5.6 期望「先写编排 sidecar、再触发 worker 暂停落盘」。但在 **CST-1(agent-runtime 不改)** 下,worker sidecar 由 `worker.send()` 内部的 `savePausedRecord` 写出,发生在 orchestrator 重获控制权**之前**;且编排 sidecar 的键 `approvalId` 由 worker 暂停时才生成 —— 故物理上**无法**在 worker sidecar 之前写编排 sidecar。

**本计划落地的实际写序**:worker sidecar 先(`worker.send` 内,不可改)→ 编排 sidecar 后(orchestrator 见 `awaiting_approval` 时立即写)。这使崩溃窗口是「worker 在、编排缺」,而该情形正是 **CST-4 边界①的 blocked 分支**。**安全不变量(孤儿一律 blocked、绝不带病续)完全保持**;仅「哪一份先落」这一窗口最小化细节因 CST-1 而反置。两个方向的孤儿都 blocked,故写序不影响安全性。此澄清在 M5 Task 中再次标注。

### 关键契约(canonical shapes,后续 Task 反复引用)

**编排 sidecar JSON**(`orchestration-paused/<approvalId>.json`):

```json
{
  "schemaVersion": 1,
  "fingerprints": { "workerFactory": 1, "toolSubset": 1, "subtaskSchema": 1 },
  "approvalId": "ap_x",
  "taskId": "task_x",
  "sessionId": "session",
  "message": "…",
  "done_when": "…",
  "autonomy": "gated",
  "plan": { "subtasks": [ /* SubTask[] */ ] },
  "round": 1,
  "env": { "root": "/abs/root", "orchestrationConfig": { /* plain */ } },
  "allCollected": [
    { "st": { /* SubTask */ }, "status": "complete",
      "wres": { "status": "complete", "content": "…" },
      "verdict": { "pass": true, "severity": "warn", "reasons": [], "checked": [] },
      "lastFeedback": "", "change_id": null }
  ],
  "seenSubtaskIds": ["a", "b"],
  "seenFp": ["goal|files|profile"],
  "budget": { "quotaTokens": null, "quotaCalls": null, "spentTokens": 0, "spentCalls": 0 },
  "adoptedExperienceIds": [],
  "riskCues": [],
  "pausedSubtask": { /* SubTask(被暂停子任务,重建 worker 的依据) */ },
  "remaining": [ /* SubTask[](本回合暂停点之后未派) */ ]
}
```

**worker sidecar 的编排归属标记**(orchestrator 注入 worker `send` options → 经 [executor-loop.js:163](../../../src/core/execution/executor-loop.js#L163) 落 `resume_state.options.__orchestration`):

```json
{ "__orchestration": { "taskId": "task_x", "sessionId": "session", "subtaskId": "a" } }
```

> 相关性由**共享键 `approvalId`** 建立:worker sidecar 落 `paused/<approvalId>.json`,编排 sidecar 落 `orchestration-paused/<approvalId>.json`,同 `approvalId`。`__orchestration` 只需携带 `taskId`/`sessionId`/`subtaskId` 供边界④归属校验;`approvalId` 的一致性经两份 sidecar 同键隐式保证。

**契约模块公开函数**(M0,纯,无 I/O):见 M0 Task 的 Interfaces。

---

## File Structure

**新增源码:**
- `src/core/orchestration/orchestration-recovery-contract.js` —— 纯契约层:schema 版本常量、指纹常量、`serializeOrchestrationState` / `deserializeOrchestrationState` / `validateOrchestrationSidecar` / `fingerprintsMatch` / `isOrchestrationWorkerSidecar` / `ownershipOk` / `budgetContinuation`。无 I/O、无活对象。
- `src/core/recovery/orchestration-persistence.js` —— I/O 层:`createOrchestrationPersistence({ root, projectId, faults })` → `save/load/scan/consume/quarantine/delete/writeRawForTest`,镜像 [paused-turn-persistence.js](../../../src/core/recovery/paused-turn-persistence.js) 的原子写 + 损坏隔离。

**修改源码:**
- `src/core/runtime/cost-budget.js` —— 新增可选 `initialTokens`/`initialModelCalls` 种子参数(默认 0,零回归),支撑预算续扣(CST-8)。
- `src/core/orchestration/orchestrator.js` —— 新增注入位(`orchPersistence`/`makeResumedBudget`);`serializeState`/`deserializeState`;`driveFrom`/`resume` 暂停点双写(gated);`resumeDurable`/`hasDurablePaused`。
- `src/core/recovery/recovery-service.js` —— `recoverOnStartup` 扫 `orchestration-paused` + 交叉校验;`list`/`resume`/`cancel` 处理 `orchestration_paused` 项;边界①孤儿一律 blocked。
- `src/index.js` —— recovery 开启时:注入共享 `pausedTurnStore`;给 orchestrator 注入 `orchPersistence`/`makeResumedBudget`;`recovery-service` 接 orchestration resume 回调;`kernel.agent.approve` 对 durable id 也路由。
- `package.json` —— `check` 脚本登记两个新源码文件。

**新增测试:**
- `tests/core/orchestration/orchestration-recovery-contract.test.js`(M0)
- `tests/unit/core/recovery/orchestration-persistence.test.js`(M1)
- `tests/unit/core/runtime/cost-budget.test.js`(M2,扩展既有)
- `tests/core/orchestration/orchestrator-serialize.test.js`(M2)
- `tests/core/orchestration/shared-paused-store.test.js`(M3)
- `tests/core/orchestration/orchestrator-resume-durable.test.js`(M4)
- `tests/core/orchestration/orchestration-pause-persist.test.js`(M5)
- `tests/unit/core/recovery/recovery-service-orchestration.test.js`(M6)
- `tests/core/orchestration/durable-orchestration-wiring.test.js`(M7)
- `tests/core/orchestration/c-durable-e2e.test.js`(M8)

**文档(M8):** `docs/project-overview.md`(§6/§14 增补)、`docs/CHANGELOG.md`、`README.md` 中/英、`docs/README.md` 索引 —— 按 [docs 维护顺序](../../README.md#文档维护规范与更新顺序)。

---

## Milestone M0 — durable recovery contract(纯契约层,契约先行)

**目标:** 纯函数契约层,先钉死 5 边界的判据(schema 版本 + 字段白名单 + 指纹 + 归属 + 预算续扣计算)。无 I/O、无活对象、可孤立单测。

### Task M0.0: 建立绿基线

- [ ] **Step 1: 跑全量,记录基线**

Run: `npm test 2>&1 | tail -20`
Expected: 全绿(约 739 通过 / 0 失败)。记录通过数为回归基线。**若非全绿,先停,报告失败项,不动手实现。**

- [ ] **Step 2: 语法闸基线**

Run: `npm run check`
Expected: 无输出、退出码 0。

### Task M0.1: 契约常量 + 指纹 + 归属校验

**Files:**
- Create: `src/core/orchestration/orchestration-recovery-contract.js`
- Test: `tests/core/orchestration/orchestration-recovery-contract.test.js`
- Modify: `package.json`(`check` 脚本追加新文件)

**Interfaces:**
- Produces:
  - `ORCH_RECOVERY_SCHEMA_VERSION: number`(= 1)
  - `ORCH_FINGERPRINTS: { workerFactory:number, toolSubset:number, subtaskSchema:number }`(frozen)
  - `fingerprintsMatch(sidecarFingerprints) => boolean`
  - `isOrchestrationWorkerSidecar(workerRecord) => boolean`(读 `workerRecord.resume_state.options.__orchestration`)
  - `ownershipOk({ sidecar, workerRecord }) => boolean`(CST-7:approvalId 同键 + taskId/sessionId/subtaskId 一致 + marker 存在)

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/orchestration-recovery-contract.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORCH_RECOVERY_SCHEMA_VERSION, ORCH_FINGERPRINTS,
  fingerprintsMatch, isOrchestrationWorkerSidecar, ownershipOk
} from "../../../src/core/orchestration/orchestration-recovery-contract.js";

function workerRecord({ approvalId = "ap1", taskId = "task_1", sessionId = "session", subtaskId = "a", marker = true } = {}) {
  return {
    approval_id: approvalId,
    resume_state: { options: marker ? { __orchestration: { taskId, sessionId, subtaskId } } : {} }
  };
}
function sidecar(over = {}) {
  return { approvalId: "ap1", taskId: "task_1", sessionId: "session", pausedSubtask: { id: "a" }, ...over };
}

test("schema version + fingerprints are the pinned current values", () => {
  assert.equal(ORCH_RECOVERY_SCHEMA_VERSION, 1);
  assert.deepEqual({ ...ORCH_FINGERPRINTS }, { workerFactory: 1, toolSubset: 1, subtaskSchema: 1 });
});

test("fingerprintsMatch: exact match only", () => {
  assert.equal(fingerprintsMatch({ workerFactory: 1, toolSubset: 1, subtaskSchema: 1 }), true);
  assert.equal(fingerprintsMatch({ workerFactory: 2, toolSubset: 1, subtaskSchema: 1 }), false);
  assert.equal(fingerprintsMatch({ workerFactory: 1, toolSubset: 1 }), false);               // missing key
  assert.equal(fingerprintsMatch({ workerFactory: 1, toolSubset: 1, subtaskSchema: 1, extra: 9 }), false);
  assert.equal(fingerprintsMatch(null), false);
});

test("isOrchestrationWorkerSidecar reads the __orchestration marker", () => {
  assert.equal(isOrchestrationWorkerSidecar(workerRecord({ marker: true })), true);
  assert.equal(isOrchestrationWorkerSidecar(workerRecord({ marker: false })), false);
  assert.equal(isOrchestrationWorkerSidecar({}), false);
  assert.equal(isOrchestrationWorkerSidecar(null), false);
});

test("ownershipOk: passes only when key + task + session + subtask + marker all align (CST-7)", () => {
  assert.equal(ownershipOk({ sidecar: sidecar(), workerRecord: workerRecord() }), true);
  assert.equal(ownershipOk({ sidecar: sidecar({ approvalId: "other" }), workerRecord: workerRecord() }), false);
  assert.equal(ownershipOk({ sidecar: sidecar({ taskId: "task_other" }), workerRecord: workerRecord() }), false);
  assert.equal(ownershipOk({ sidecar: sidecar({ sessionId: "other" }), workerRecord: workerRecord() }), false);
  assert.equal(ownershipOk({ sidecar: sidecar({ pausedSubtask: { id: "b" } }), workerRecord: workerRecord() }), false);
  assert.equal(ownershipOk({ sidecar: sidecar(), workerRecord: workerRecord({ marker: false }) }), false);  // wrong owner type
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test tests/core/orchestration/orchestration-recovery-contract.test.js`
Expected: FAIL —— `Cannot find module … orchestration-recovery-contract.js`。

- [ ] **Step 3: 写最小实现**

```js
// src/core/orchestration/orchestration-recovery-contract.js
// Pure contract layer for durable orchestration recovery. No I/O, no live objects.
// Every function operates on plain serializable data so it is unit-testable in isolation.

export const ORCH_RECOVERY_SCHEMA_VERSION = 1;

// Version fingerprints of the code a rebuilt worker's byte-equivalence depends on.
// Bump the relevant field when that logic changes incompatibly:
//   workerFactory -> worker-factory.js rebuild wiring;  toolSubset -> tool-profiles.js filtering;
//   subtaskSchema -> subtask-schema.js SubTask shape.
export const ORCH_FINGERPRINTS = Object.freeze({ workerFactory: 1, toolSubset: 1, subtaskSchema: 1 });

export function fingerprintsMatch(sidecarFingerprints) {
  if (!sidecarFingerprints || typeof sidecarFingerprints !== "object") return false;
  const keys = Object.keys(ORCH_FINGERPRINTS);
  if (Object.keys(sidecarFingerprints).length !== keys.length) return false;
  return keys.every((k) => sidecarFingerprints[k] === ORCH_FINGERPRINTS[k]);
}

export function isOrchestrationWorkerSidecar(workerRecord) {
  return !!workerRecord?.resume_state?.options?.__orchestration;
}

export function ownershipOk({ sidecar, workerRecord }) {
  if (!sidecar || !workerRecord) return false;
  const marker = workerRecord.resume_state?.options?.__orchestration;
  if (!marker) return false;                                     // turn owner type must be orchestration-owned
  if (sidecar.approvalId !== workerRecord.approval_id) return false;   // same-key correlation
  if (sidecar.taskId !== marker.taskId) return false;
  if (sidecar.sessionId !== marker.sessionId) return false;
  if (!sidecar.pausedSubtask || sidecar.pausedSubtask.id !== marker.subtaskId) return false;
  return true;
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test tests/core/orchestration/orchestration-recovery-contract.test.js`
Expected: PASS(4 tests)。

- [ ] **Step 5: 登记 `package.json` check 脚本**

在 `package.json` 的 `check` 脚本末尾(编排文件那段 `… src/core/orchestration/iso-worker-runner.js` 之后)追加:
`src/core/orchestration/orchestration-recovery-contract.js`

Run: `npm run check`
Expected: 退出码 0(新文件语法通过)。

- [ ] **Step 6: 提交**

```bash
git add src/core/orchestration/orchestration-recovery-contract.js tests/core/orchestration/orchestration-recovery-contract.test.js package.json
git commit -m "$(printf 'feat(recovery): orchestration durable contract — fingerprints + ownership (M0.1)')"
```

### Task M0.2: serialize / deserialize / validate / budget 续扣计算

**Files:**
- Modify: `src/core/orchestration/orchestration-recovery-contract.js`
- Modify: `tests/core/orchestration/orchestration-recovery-contract.test.js`

**Interfaces:**
- Consumes: `ORCH_RECOVERY_SCHEMA_VERSION`, `ORCH_FINGERPRINTS`, `fingerprintsMatch`(同模块)
- Produces:
  - `serializeOrchestrationState(state, { approvalId, pausedSubtask, remaining }) => sidecarJson`(纯;读 `state.budget.snapshot()`;裁剪 `allCollected`;Set→数组;**不含 raw options/活对象**,CST-5)
  - `deserializeOrchestrationState(json) => { message, done_when, options:{autonomy,sessionId}, plan, round, allCollected, seenSubtaskIds:Set, seenFp:Set, riskCues:Set, adoptedExperienceIds, taskId, sessionId, env, budgetSnapshot, pausedSubtask, remaining }`(数组→Set)
  - `validateOrchestrationSidecar(json) => { ok:true } | { ok:false, error }`(**仅结构**:schema 版本 + 必填字段 + budget 计数 + 数组形状。**不含指纹**——指纹是独立的版本门,见下)
  - `orchestrationResumeGate({ sidecar, workerRecord }) => { ok:true } | { ok:false, reason }`(**权威门 CST-6+CST-7**:结构 + `fingerprintsMatch` + worker sidecar 存在 + `isOrchestrationWorkerSidecar` + `ownershipOk`;M4 resume 与 M6 扫描共用)
  - `budgetContinuation(budgetJson) => { maxTokens, maxModelCalls, initialTokens, initialModelCalls }`(CST-8:配额−已花续扣的入参)

> **设计要点:** 结构校验(`validateOrchestrationSidecar`)与版本/归属门(`orchestrationResumeGate`)分离——persistence 的 `scan`/`load` 只做结构校验,故一份**结构合法但指纹过期**的 sidecar 仍被返回(而非丢成 corrupt),让 M6 能以「fingerprint mismatch」这一**明确原因**将其登记为 `blocked_recovery`(CST-6:不匹配→blocked、不重建)。

- [ ] **Step 1: 追加失败测试**

```js
// 追加到 tests/core/orchestration/orchestration-recovery-contract.test.js
import {
  serializeOrchestrationState, deserializeOrchestrationState,
  validateOrchestrationSidecar, orchestrationResumeGate, budgetContinuation
} from "../../../src/core/orchestration/orchestration-recovery-contract.js";

function fakeState() {
  return {
    message: "m", done_when: "d",
    options: { autonomy: "supervised", sessionId: "session" },
    plan: { subtasks: [{ id: "a", goal: "g", acceptance: [], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }] },
    round: 2,
    allCollected: [
      { st: { id: "x", goal: "gx" }, status: "complete", wres: { status: "complete", content: "done x", extra: "STRIP_ME" }, verdict: { pass: true, severity: "warn", reasons: [], checked: ["read"] }, lastFeedback: "", change_id: "chg_1" },
      { st: { id: "y", goal: "gy" }, status: "failed", lastFeedback: "nope" }
    ],
    seenSubtaskIds: new Set(["a", "x", "y"]),
    seenFp: new Set(["g|a.js|edit"]),
    budget: { snapshot: () => ({ tokens: 40, model_calls: 3, max_tokens: 100, max_model_calls: 10 }) },
    adoptedExperienceIds: ["exp_1"],
    riskCues: new Set(["rm -rf"]),
    taskId: "task_1", sessionId: "session",
    env: { root: "/root", orchestrationConfig: { maxRounds: 2 } }
  };
}

test("serialize → JSON round-trip → deserialize preserves state, rebuilds Sets, computes budget continuation", () => {
  const json = serializeOrchestrationState(fakeState(), {
    approvalId: "ap1", pausedSubtask: { id: "b", goal: "gb", tool_profile: "edit", context_scope: {}, acceptance: [], depends_on: [] },
    remaining: [{ id: "c" }]
  });
  // survives JSON serialization (no functions/live objects)
  const round = JSON.parse(JSON.stringify(json));
  assert.equal(round.schemaVersion, 1);
  assert.deepEqual(round.fingerprints, { workerFactory: 1, toolSubset: 1, subtaskSchema: 1 });
  assert.equal(round.approvalId, "ap1");
  assert.equal(round.autonomy, "supervised");
  assert.equal(round.pausedSubtask.id, "b");
  assert.deepEqual(round.remaining, [{ id: "c" }]);
  // CST-5: no raw options / live objects leaked
  assert.equal(round.options, undefined);
  assert.equal(round.budget.spentTokens, 40);
  assert.equal(round.budget.quotaTokens, 100);
  // allCollected trimmed: wres keeps only {status,content}
  assert.deepEqual(round.allCollected[0].wres, { status: "complete", content: "done x" });

  const state = deserializeOrchestrationState(round);
  assert.ok(state.seenSubtaskIds instanceof Set && state.seenSubtaskIds.has("x"));
  assert.ok(state.seenFp instanceof Set && state.seenFp.has("g|a.js|edit"));
  assert.ok(state.riskCues instanceof Set && state.riskCues.has("rm -rf"));
  assert.equal(state.options.autonomy, "supervised");
  assert.deepEqual(state.budgetSnapshot, { maxTokens: 100, maxModelCalls: 10, initialTokens: 40, initialModelCalls: 3 });
  assert.equal(state.round, 2);
  assert.equal(state.taskId, "task_1");
});

test("validateOrchestrationSidecar (structural) accepts a well-formed sidecar and rejects each shape failure", () => {
  const good = serializeOrchestrationState(fakeState(), { approvalId: "ap1", pausedSubtask: { id: "b" }, remaining: [] });
  assert.deepEqual(validateOrchestrationSidecar(good), { ok: true });
  assert.equal(validateOrchestrationSidecar({ ...good, schemaVersion: 2 }).ok, false);
  assert.equal(validateOrchestrationSidecar({ ...good, taskId: undefined }).ok, false);
  assert.equal(validateOrchestrationSidecar({ ...good, budget: { quotaTokens: 1 } }).ok, false);  // missing spent counts
  assert.equal(validateOrchestrationSidecar(null).ok, false);
  // structural validation does NOT reject a fingerprint-outdated-but-well-formed sidecar (that is the gate's job)
  assert.equal(validateOrchestrationSidecar({ ...good, fingerprints: { workerFactory: 9, toolSubset: 1, subtaskSchema: 1 } }).ok, true);
});

test("orchestrationResumeGate is the authoritative CST-6+CST-7 gate (structure + fingerprint + ownership)", () => {
  const sc = serializeOrchestrationState(fakeState(), {
    approvalId: "ap1",
    pausedSubtask: { id: "b", goal: "gb", tool_profile: "edit", context_scope: {}, acceptance: [], depends_on: [] },
    remaining: []
  });
  const wr = { approval_id: "ap1", resume_state: { options: { __orchestration: { taskId: "task_1", sessionId: "session", subtaskId: "b" } } } };
  assert.deepEqual(orchestrationResumeGate({ sidecar: sc, workerRecord: wr }), { ok: true });
  // fingerprint mismatch -> blocked (CST-6)
  assert.equal(orchestrationResumeGate({ sidecar: { ...sc, fingerprints: { workerFactory: 9, toolSubset: 1, subtaskSchema: 1 } }, workerRecord: wr }).ok, false);
  // worker sidecar missing -> blocked
  assert.equal(orchestrationResumeGate({ sidecar: sc, workerRecord: null }).ok, false);
  // worker sidecar present but not orchestration-owned -> blocked
  assert.equal(orchestrationResumeGate({ sidecar: sc, workerRecord: { approval_id: "ap1", resume_state: { options: {} } } }).ok, false);
  // ownership mismatch (subtask id) -> blocked (CST-7)
  assert.equal(orchestrationResumeGate({ sidecar: sc, workerRecord: { approval_id: "ap1", resume_state: { options: { __orchestration: { taskId: "task_1", sessionId: "session", subtaskId: "WRONG" } } } } }).ok, false);
  // structurally broken sidecar -> blocked
  assert.equal(orchestrationResumeGate({ sidecar: { ...sc, budget: {} }, workerRecord: wr }).ok, false);
});

test("budgetContinuation maps quota+spent, tolerates nulls (never resets — CST-8)", () => {
  assert.deepEqual(budgetContinuation({ quotaTokens: 100, quotaCalls: 10, spentTokens: 40, spentCalls: 3 }),
    { maxTokens: 100, maxModelCalls: 10, initialTokens: 40, initialModelCalls: 3 });
  assert.deepEqual(budgetContinuation({ quotaTokens: null, quotaCalls: null, spentTokens: 0, spentCalls: 0 }),
    { maxTokens: null, maxModelCalls: null, initialTokens: 0, initialModelCalls: 0 });
  assert.deepEqual(budgetContinuation(undefined), { maxTokens: null, maxModelCalls: null, initialTokens: 0, initialModelCalls: 0 });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test tests/core/orchestration/orchestration-recovery-contract.test.js`
Expected: FAIL —— 新导出未定义。

- [ ] **Step 3: 追加实现**

```js
// 追加到 src/core/orchestration/orchestration-recovery-contract.js
const REQUIRED_TOP_FIELDS = ["approvalId", "taskId", "sessionId", "message", "done_when", "plan", "round", "pausedSubtask", "remaining", "budget", "seenSubtaskIds", "seenFp"];

// Structural validation only — NOT the version gate. A fingerprint-outdated but
// well-formed sidecar passes here (so the caller can present it as blocked with a
// clear "fingerprint mismatch" reason via orchestrationResumeGate).
export function validateOrchestrationSidecar(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, error: "sidecar not an object" };
  if (json.schemaVersion !== ORCH_RECOVERY_SCHEMA_VERSION) return { ok: false, error: "unsupported schemaVersion" };
  for (const f of REQUIRED_TOP_FIELDS) {
    if (json[f] === undefined || json[f] === null) return { ok: false, error: `missing field: ${f}` };
  }
  if (!Array.isArray(json.plan?.subtasks)) return { ok: false, error: "plan.subtasks not array" };
  if (typeof json.pausedSubtask.id !== "string") return { ok: false, error: "pausedSubtask.id missing" };
  if (!Array.isArray(json.remaining)) return { ok: false, error: "remaining not array" };
  if (!Array.isArray(json.seenSubtaskIds) || !Array.isArray(json.seenFp)) return { ok: false, error: "seen sets not arrays" };
  const b = json.budget;
  if (!b || typeof b !== "object" || !("spentTokens" in b) || !("spentCalls" in b)) return { ok: false, error: "budget counts missing" };
  return { ok: true };
}

// Authoritative resume gate (CST-6 version + CST-7 ownership). Used by both the
// scan-time presentation (M6) and the resume-time gate (M4). Fails closed.
export function orchestrationResumeGate({ sidecar, workerRecord }) {
  const shape = validateOrchestrationSidecar(sidecar);
  if (!shape.ok) return { ok: false, reason: shape.error };
  if (!fingerprintsMatch(sidecar.fingerprints)) return { ok: false, reason: "fingerprint mismatch" };
  if (!workerRecord) return { ok: false, reason: "worker sidecar missing" };
  if (!isOrchestrationWorkerSidecar(workerRecord)) return { ok: false, reason: "worker sidecar not orchestration-owned" };
  if (!ownershipOk({ sidecar, workerRecord })) return { ok: false, reason: "ownership mismatch" };
  return { ok: true };
}

export function serializeOrchestrationState(state, { approvalId, pausedSubtask, remaining }) {
  const bs = state.budget.snapshot();
  return {
    schemaVersion: ORCH_RECOVERY_SCHEMA_VERSION,
    fingerprints: { ...ORCH_FINGERPRINTS },
    approvalId,
    taskId: state.taskId,
    sessionId: state.sessionId,
    message: state.message,
    done_when: state.done_when,
    autonomy: state.options?.autonomy || "gated",
    plan: { subtasks: (state.plan?.subtasks || []).map((s) => ({ ...s })) },
    round: state.round,
    env: { root: state.env?.root ?? null, orchestrationConfig: state.env?.orchestrationConfig ?? null },
    allCollected: (state.allCollected || []).map(serializeCollected),
    seenSubtaskIds: [...state.seenSubtaskIds],
    seenFp: [...state.seenFp],
    budget: {
      quotaTokens: bs.max_tokens ?? null,
      quotaCalls: bs.max_model_calls ?? null,
      spentTokens: bs.tokens || 0,
      spentCalls: bs.model_calls || 0
    },
    adoptedExperienceIds: [...(state.adoptedExperienceIds || [])],
    riskCues: [...(state.riskCues || [])],
    pausedSubtask: { ...pausedSubtask },
    remaining: (remaining || []).map((s) => ({ ...s }))
  };
}

function serializeCollected(c) {
  return {
    st: c.st,
    status: c.status,
    wres: c.wres ? { status: c.wres.status, content: String(c.wres.content ?? "") } : undefined,
    verdict: c.verdict ? { pass: !!c.verdict.pass, severity: c.verdict.severity, reasons: c.verdict.reasons || [], checked: c.verdict.checked || [] } : undefined,
    lastFeedback: c.lastFeedback,
    change_id: c.change_id ?? null
  };
}

export function deserializeOrchestrationState(json) {
  return {
    message: json.message,
    done_when: json.done_when,
    options: { autonomy: json.autonomy || "gated", sessionId: json.sessionId },
    plan: { subtasks: (json.plan?.subtasks || []).map((s) => ({ ...s })) },
    round: json.round,
    allCollected: (json.allCollected || []).map((c) => ({ ...c })),
    seenSubtaskIds: new Set(json.seenSubtaskIds || []),
    seenFp: new Set(json.seenFp || []),
    riskCues: new Set(json.riskCues || []),
    adoptedExperienceIds: [...(json.adoptedExperienceIds || [])],
    taskId: json.taskId,
    sessionId: json.sessionId,
    env: json.env || { root: null, orchestrationConfig: null },
    budgetSnapshot: budgetContinuation(json.budget),
    pausedSubtask: { ...json.pausedSubtask },
    remaining: (json.remaining || []).map((s) => ({ ...s }))
  };
}

export function budgetContinuation(budgetJson) {
  const b = budgetJson || {};
  return {
    maxTokens: b.quotaTokens ?? null,
    maxModelCalls: b.quotaCalls ?? null,
    initialTokens: b.spentTokens || 0,
    initialModelCalls: b.spentCalls || 0
  };
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test tests/core/orchestration/orchestration-recovery-contract.test.js`
Expected: PASS(8 tests)。

- [ ] **Step 5: 提交**

```bash
git add src/core/orchestration/orchestration-recovery-contract.js tests/core/orchestration/orchestration-recovery-contract.test.js
git commit -m "$(printf 'feat(recovery): orchestration state serialize/deserialize/validate + budget continuation (M0.2)')"
```

---

## Milestone M1 — orchestration-persistence(I/O 层,镜像 paused-turn-persistence)

**目标:** `orchestration-paused/<approvalId>.json` 的原子写 + 损坏隔离 + consumed 墓碑,API 与语义与 [paused-turn-persistence.js](../../../src/core/recovery/paused-turn-persistence.js) 对齐(reviewer 熟悉的形状)。

### Task M1.1: createOrchestrationPersistence(save/load/scan/consume/quarantine)

**Files:**
- Create: `src/core/recovery/orchestration-persistence.js`
- Test: `tests/unit/core/recovery/orchestration-persistence.test.js`
- Modify: `package.json`(`check` 追加新文件)

**Interfaces:**
- Consumes: `atomicReadJson`/`atomicWriteJson`/`safeRecoverySegment`([atomic-file.js](../../../src/core/recovery/atomic-file.js))、`createRecoveryFaults`([recovery-faults.js](../../../src/core/recovery/recovery-faults.js))、`validateOrchestrationSidecar`/`ORCH_RECOVERY_SCHEMA_VERSION`(M0)
- Produces: `createOrchestrationPersistence({ root, projectId, faults }) => { baseDir, save(approvalId, stateJson), load(approvalId), delete(approvalId), consume(approvalId), quarantine(approvalId, reason), scan(), writeRawForTest(approvalId, raw) }`
  - `baseDir = <root>/.deepseek-code/v2/sessions/<projectId>/orchestration-paused`
  - `scan()` 返回数组:合法记录(原样,无 `status`)/ `{status:"corrupt", approvalId, path, reason}` / `{status:"consumed", approvalId, path}`,按 `approvalId` 排序。
  - `save` 前做**结构**校验(`validateOrchestrationSidecar`);`load`/`scan` 结构合法即返回(指纹门留给 M4/M6 的 `orchestrationResumeGate`)。

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/core/recovery/orchestration-persistence.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOrchestrationPersistence } from "../../../../src/core/recovery/orchestration-persistence.js";
import { serializeOrchestrationState } from "../../../../src/core/orchestration/orchestration-recovery-contract.js";
import { createRecoveryFaults } from "../../../../src/core/recovery/recovery-faults.js";

function sidecar(approvalId = "ap1") {
  const state = {
    message: "m", done_when: "d", options: { autonomy: "gated", sessionId: "s" },
    plan: { subtasks: [] }, round: 1, allCollected: [],
    seenSubtaskIds: new Set(["a"]), seenFp: new Set(["fp"]),
    budget: { snapshot: () => ({ tokens: 0, model_calls: 0, max_tokens: null, max_model_calls: null }) },
    adoptedExperienceIds: [], riskCues: new Set(), taskId: "task_1", sessionId: "s",
    env: { root: "/r", orchestrationConfig: null }
  };
  return serializeOrchestrationState(state, { approvalId, pausedSubtask: { id: "b" }, remaining: [] });
}
const tmp = () => mkdtemp(path.join(tmpdir(), "orch-persist-"));
async function exists(p) { try { await stat(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }

test("save then load round-trips the orchestration sidecar", async () => {
  const store = createOrchestrationPersistence({ root: await tmp(), projectId: "proj" });
  await store.save("ap1", sidecar("ap1"));
  const loaded = await store.load("ap1");
  assert.equal(loaded.approvalId, "ap1");
  assert.equal(loaded.taskId, "task_1");
});

test("save rejects a structurally invalid sidecar", async () => {
  const store = createOrchestrationPersistence({ root: await tmp(), projectId: "proj" });
  await assert.rejects(() => store.save("ap1", { schemaVersion: 1 }), /invalid orchestration sidecar/);
});

test("scan returns valid records, flags corrupt, and marks consumed", async () => {
  const store = createOrchestrationPersistence({ root: await tmp(), projectId: "proj" });
  await store.save("ap_ok", sidecar("ap_ok"));
  await store.writeRawForTest("ap_bad", "{ not json");
  await store.writeRawForTest("ap_consumed", JSON.stringify({ schemaVersion: 1, approvalId: "ap_consumed", status: "consumed", consumed_at: new Date().toISOString(), reason: "consumed" }));
  const scanned = await store.scan();
  const byId = Object.fromEntries(scanned.map((s) => [s.approvalId, s]));
  assert.equal(byId.ap_ok.status, undefined);      // valid record returned as-is
  assert.equal(byId.ap_ok.taskId, "task_1");
  assert.equal(byId.ap_bad.status, "corrupt");
  assert.equal(byId.ap_consumed.status, "consumed");
});

test("consume writes a tombstone then deletes the sidecar", async () => {
  const root = await tmp();
  const store = createOrchestrationPersistence({ root, projectId: "proj" });
  await store.save("ap1", sidecar("ap1"));
  const res = await store.consume("ap1");
  assert.equal(res.status, "deleted");
  assert.equal(await exists(path.join(store.baseDir, "ap1.json")), false);
});

test("quarantine moves a corrupt sidecar aside", async () => {
  const root = await tmp();
  const store = createOrchestrationPersistence({ root, projectId: "proj" });
  await store.writeRawForTest("ap_bad", "{ not json");
  const res = await store.quarantine("ap_bad", "operator cancelled");
  assert.equal(res.status, "quarantined");
  assert.equal(await exists(path.join(store.baseDir, "ap_bad.json")), false);
  assert.equal(await exists(path.join(store.baseDir, "quarantine", "ap_bad.json")), true);
});

test("crash-after-write fault: file persists but save rejects (recoverable orphan window)", async () => {
  const faults = createRecoveryFaults({ labels: ["after-orchestration-sidecar-write"] });
  const root = await tmp();
  const store = createOrchestrationPersistence({ root, projectId: "proj", faults });
  await assert.rejects(() => store.save("ap1", sidecar("ap1")), /recovery fault/);
  assert.equal(await exists(path.join(store.baseDir, "ap1.json")), true);
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test tests/unit/core/recovery/orchestration-persistence.test.js`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

```js
// src/core/recovery/orchestration-persistence.js
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicReadJson, atomicWriteJson, safeRecoverySegment } from "./atomic-file.js";
import { createRecoveryFaults } from "./recovery-faults.js";
import { validateOrchestrationSidecar, ORCH_RECOVERY_SCHEMA_VERSION } from "../orchestration/orchestration-recovery-contract.js";

export function createOrchestrationPersistence({ root, projectId, faults = createRecoveryFaults() }) {
  if (!root) throw new Error("root is required");
  const projectSegment = safeRecoverySegment(projectId);
  const baseDir = path.join(root, ".deepseek-code", "v2", "sessions", projectSegment, "orchestration-paused");
  const quarantineDir = path.join(baseDir, "quarantine");

  const sidecarPath = (approvalId) => path.join(baseDir, `${safeRecoverySegment(approvalId)}.json`);

  async function save(approvalId, state) {
    const id = safeRecoverySegment(approvalId);
    const check = validateOrchestrationSidecar(state);
    if (!check.ok) throw new Error(`invalid orchestration sidecar: ${check.error}`);
    if (state.approvalId !== id) throw new Error("approvalId must match sidecar path");
    await atomicWriteJson(sidecarPath(id), state);
    await faults.maybe("after-orchestration-sidecar-write");
    return state;
  }

  async function load(approvalId) {
    const id = safeRecoverySegment(approvalId);
    const record = await atomicReadJson(sidecarPath(id));
    if (record?.status === "consumed") return { status: "consumed", approvalId: id };
    const check = validateOrchestrationSidecar(record);
    if (!check.ok) throw new Error(`invalid orchestration sidecar: ${check.error}`);
    if (record.approvalId !== id) throw new Error("approvalId must match sidecar path");
    return record;
  }

  async function deleteSidecar(approvalId) {
    try { await unlink(sidecarPath(approvalId)); return true; }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  }

  async function consume(approvalId) {
    const id = safeRecoverySegment(approvalId);
    const filePath = sidecarPath(id);
    const consumed = { schemaVersion: ORCH_RECOVERY_SCHEMA_VERSION, approvalId: id, status: "consumed", consumed_at: new Date().toISOString(), reason: "consumed" };
    try {
      await atomicWriteJson(filePath, consumed);
    } catch (writeError) {
      const deleted = await deleteSidecar(id).catch(() => false);
      return { status: deleted ? "deleted" : "missing", approvalId: id, path: filePath, reason: sanitizeReason(writeError?.message) };
    }
    try {
      const deleted = await deleteSidecar(id);
      return { status: deleted ? "deleted" : "missing", approvalId: id, path: filePath };
    } catch (error) {
      const reason = sanitizeReason(error?.message);
      await atomicWriteJson(filePath, { ...consumed, reason }).catch(() => {});
      return { status: "consumed", approvalId: id, path: filePath, reason };
    }
  }

  async function quarantine(approvalId, reason = "quarantined") {
    const id = safeRecoverySegment(approvalId);
    const source = sidecarPath(id);
    const target = path.join(quarantineDir, `${id}.json`);
    try {
      await mkdir(quarantineDir, { recursive: true });
      await rename(source, target);
      return { status: "quarantined", approvalId: id, path: target, reason: sanitizeReason(reason) };
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "missing", approvalId: id, path: source, reason: "sidecar not found" };
      throw error;
    }
  }

  async function scan() {
    let entries;
    try { entries = await readdir(baseDir, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    const scanned = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const approvalId = entry.name.slice(0, -".json".length);
      const filePath = path.join(baseDir, entry.name);
      try {
        safeRecoverySegment(approvalId);
        const record = await atomicReadJson(filePath);
        if (record?.status === "consumed") { scanned.push({ status: "consumed", approvalId, path: filePath }); continue; }
        const check = validateOrchestrationSidecar(record);
        if (!check.ok) { scanned.push({ status: "corrupt", approvalId, path: filePath, reason: check.error }); continue; }
        if (record.approvalId !== approvalId) { scanned.push({ status: "corrupt", approvalId, path: filePath, reason: "approvalId mismatch" }); continue; }
        scanned.push(record);
      } catch (error) {
        scanned.push({ status: "corrupt", approvalId, path: filePath, reason: sanitizeReason(error?.message || "invalid orchestration sidecar") });
      }
    }
    return scanned.sort((a, b) => String(a.approvalId).localeCompare(String(b.approvalId)));
  }

  async function writeRawForTest(approvalId, raw) {
    const filePath = sidecarPath(approvalId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, raw);
  }

  return { baseDir, save, load, delete: deleteSidecar, consume, quarantine, scan, writeRawForTest };
}

function sanitizeReason(reason) {
  const text = String(reason || "invalid orchestration sidecar");
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test tests/unit/core/recovery/orchestration-persistence.test.js`
Expected: PASS(6 tests)。

- [ ] **Step 5: 登记 check + 跑闸**

在 `package.json` 的 `check` 脚本 recovery 段(`… src/core/recovery/recovery-service.js`)追加:`src/core/recovery/orchestration-persistence.js`

Run: `npm run check`
Expected: 退出码 0。

- [ ] **Step 6: 提交**

```bash
git add src/core/recovery/orchestration-persistence.js tests/unit/core/recovery/orchestration-persistence.test.js package.json
git commit -m "$(printf 'feat(recovery): orchestration-paused sidecar persistence (atomic write + quarantine) (M1)')"
```

---

## Milestone M2 — 预算续扣种子 + orchestrator serialize/deserialize

**目标:** (a) `createCostBudget` 支持 `initialTokens`/`initialModelCalls` 种子(CST-8,默认 0 零回归);(b) orchestrator 暴露 `serializeState`/`deserializeState`,把编排状态往返为 sidecar JSON 并重建**续扣的活预算**。

### Task M2.1: cost-budget 续扣种子

**Files:**
- Modify: `src/core/runtime/cost-budget.js`
- Modify: `tests/unit/core/runtime/cost-budget.test.js`

**Interfaces:**
- Produces: `createCostBudget({ maxTokens, maxModelCalls, initialTokens=0, initialModelCalls=0 }) => { recordModelResult, check, exceeded, snapshot }`(种子默认 0 → 现有行为逐字节不变)

- [ ] **Step 1: 追加失败测试**

```js
// 追加到 tests/unit/core/runtime/cost-budget.test.js
test("initial seeds continue deducting from prior spend (durable resume — CST-8)", () => {
  const b = createCostBudget({ maxTokens: 100, initialTokens: 90 });
  assert.equal(b.snapshot().tokens, 90);
  assert.equal(b.exceeded(), null);
  b.recordModelResult({ usage: { total_tokens: 15 } }); // 90 + 15 = 105 >= 100
  assert.equal(b.exceeded().reason, "max_tokens");
});

test("initial model-call seed can already be at cap on resume", () => {
  const b = createCostBudget({ maxModelCalls: 3, initialModelCalls: 3 });
  assert.equal(b.snapshot().model_calls, 3);
  assert.equal(b.exceeded().reason, "max_model_calls");
});

test("default seeds are zero (no regression)", () => {
  const b = createCostBudget({ maxTokens: 100 });
  assert.deepEqual(b.snapshot(), { tokens: 0, model_calls: 0, max_tokens: 100, max_model_calls: null });
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test tests/unit/core/runtime/cost-budget.test.js`
Expected: FAIL —— 前两个新测试(种子未生效,snapshot.tokens=0)。

- [ ] **Step 3: 改实现(仅头两行)**

在 [cost-budget.js:1-3](../../../src/core/runtime/cost-budget.js#L1-L3) 把:
```js
export function createCostBudget({ maxTokens = null, maxModelCalls = null } = {}) {
  let tokens = 0;
  let modelCalls = 0;
```
改为:
```js
export function createCostBudget({ maxTokens = null, maxModelCalls = null, initialTokens = 0, initialModelCalls = 0 } = {}) {
  let tokens = initialTokens;
  let modelCalls = initialModelCalls;
```
其余不动。

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test tests/unit/core/runtime/cost-budget.test.js`
Expected: PASS(全部,含原 5 + 新 3)。

- [ ] **Step 5: 提交**

```bash
git add src/core/runtime/cost-budget.js tests/unit/core/runtime/cost-budget.test.js
git commit -m "$(printf 'feat(runtime): cost-budget initial spend seeds for durable resume continuation (M2.1)')"
```

### Task M2.2: orchestrator serializeState / deserializeState

**Files:**
- Modify: `src/core/orchestration/orchestrator.js`
- Test: `tests/core/orchestration/orchestrator-serialize.test.js`

**Interfaces:**
- Consumes: `serializeOrchestrationState`/`deserializeOrchestrationState`(M0)、`makeResumedBudget`(注入,M7 wires;M2 test 注入)、`env`(注入)
- Produces(挂到 orchestrator 返回对象):
  - `serializeState(state, { approvalId, pausedSubtask, remaining }) => sidecarJson`
  - `deserializeState(json) => state`(含**活预算** `budget`,经 `makeResumedBudget(budgetSnapshot)` 续扣;Set 已重建;`stoppedByCap:false`)
- **零回归:** 新增参数 `orchPersistence=null` / `makeResumedBudget=null` / `env` 全有默认;`run` 的 state 仅**多一个 `env` 字段**,off 路径永不读它。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/orchestrator-serialize.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../../../src/core/orchestration/orchestrator.js";
import { createCostBudget } from "../../../src/core/runtime/cost-budget.js";

function build() {
  return createOrchestrator({
    planner: { plan: async () => ({ subtasks: [] }) },
    makeWorkerFactory: () => ({ worker: () => ({}) }),
    makeReviewerFor: () => ({ review: async () => ({}) }),
    synthesizer: { synthesize: async () => "" },
    makeBudget: () => createCostBudget({ maxTokens: 100, maxModelCalls: 10 }),
    makeResumedBudget: (s) => createCostBudget({ maxTokens: s.maxTokens, maxModelCalls: s.maxModelCalls, initialTokens: s.initialTokens, initialModelCalls: s.initialModelCalls }),
    maxSubtasks: 8, maxWorkerAttempts: 1, eventBus: { publish() {} }, makeContext: async () => null, maxRounds: 2,
    env: { root: "/root", orchestrationConfig: { maxRounds: 2 } }
  });
}

function fakeState() {
  const budget = createCostBudget({ maxTokens: 100, maxModelCalls: 10 });
  budget.recordModelResult({ usage: { total_tokens: 40 } }); // spent 40 tokens / 1 call
  return {
    message: "m", done_when: "d", options: { autonomy: "gated", sessionId: "s" },
    plan: { subtasks: [{ id: "a", goal: "g", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }] },
    round: 1, allCollected: [], seenSubtaskIds: new Set(["a"]), seenFp: new Set(["fp"]),
    budget, adoptedExperienceIds: [], riskCues: new Set(), taskId: "task_1", sessionId: "s",
    env: { root: "/root", orchestrationConfig: { maxRounds: 2 } }
  };
}

test("serializeState → deserializeState rebuilds a live budget that CONTINUES from spend (CST-8)", () => {
  const orch = build();
  const json = orch.serializeState(fakeState(), {
    approvalId: "ap1",
    pausedSubtask: { id: "b", goal: "gb", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] },
    remaining: []
  });
  assert.equal(json.budget.spentTokens, 40);
  assert.equal(json.budget.quotaTokens, 100);

  const state = orch.deserializeState(JSON.parse(JSON.stringify(json)));
  assert.equal(state.budget.snapshot().tokens, 40);            // continues, not reset
  assert.equal(state.budget.exceeded(), null);
  state.budget.recordModelResult({ usage: { total_tokens: 65 } }); // 40 + 65 = 105 >= 100
  assert.equal(state.budget.exceeded().reason, "max_tokens");
  assert.ok(state.seenSubtaskIds.has("a"));
  assert.equal(state.taskId, "task_1");
  assert.equal(state.pausedSubtask.id, "b");
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test tests/core/orchestration/orchestrator-serialize.test.js`
Expected: FAIL —— `orch.serializeState is not a function`。

- [ ] **Step 3: 改 orchestrator.js**

(a) 顶部 import 追加(在 [orchestrator.js:4](../../../src/core/orchestration/orchestrator.js#L4) 后):
```js
import { serializeOrchestrationState, deserializeOrchestrationState } from "./orchestration-recovery-contract.js";
```

(b) 参数解构([orchestrator.js:9](../../../src/core/orchestration/orchestrator.js#L9))末尾追加三项:
```js
  crossTaskLearning = "off", experienceRetrieval = null, experienceConsolidator = null, now = () => Date.now(),
  orchPersistence = null, makeResumedBudget = null, env = { root: null, orchestrationConfig: null }
```

(c) `run` 的 `state` 对象([orchestrator.js:31-38](../../../src/core/orchestration/orchestrator.js#L31-L38))追加 `env` 字段:
```js
    const state = {
      message, options, plan, round: 1, allCollected: [],
      seenSubtaskIds: new Set(plan.subtasks.map((s) => s.id)),
      seenFp: new Set(plan.subtasks.map(fingerprint)),
      budget: makeBudget(), stoppedByCap: false, done_when: plan.done_when,
      adoptedExperienceIds, riskCues,
      taskId: "task_" + Math.trunc(now()).toString(36), sessionId: options.sessionId || "session",
      env
    };
```

(d) 在 `resume` 函数后(约 [orchestrator.js:141](../../../src/core/orchestration/orchestrator.js#L141),`return { run, resume, ... }` 之前)加两个方法:
```js
  // Durable recovery (opt-in): serialize the wrapper state to a sidecar JSON, and
  // rebuild it after restart with a live budget that continues from prior spend.
  function serializeState(state, pauseInfo) {
    return serializeOrchestrationState(state, pauseInfo);
  }
  function deserializeState(json) {
    const s = deserializeOrchestrationState(json);
    const budget = makeResumedBudget ? makeResumedBudget(s.budgetSnapshot) : makeBudget();
    return { ...s, budget, stoppedByCap: false };
  }
```

(e) 返回对象([orchestrator.js:143](../../../src/core/orchestration/orchestrator.js#L143))追加两项:
```js
  return { run, resume, hasPaused: (id) => orchPaused.has(id), flushExperience, serializeState, deserializeState };
```

- [ ] **Step 4: 跑测试,确认通过 + 编排回归**

Run: `node --test tests/core/orchestration/orchestrator-serialize.test.js tests/core/orchestration/orchestrator-resume.test.js tests/core/orchestration/orchestrator.test.js tests/core/orchestration/orchestrator-rounds.test.js`
Expected: PASS(新测试 + 既有编排测试不回归)。

- [ ] **Step 5: 提交**

```bash
git add src/core/orchestration/orchestrator.js tests/core/orchestration/orchestrator-serialize.test.js
git commit -m "$(printf 'feat(orchestration): serializeState/deserializeState with budget-continuation rebuild (M2.2)')"
```

---

## Milestone M3 — 共享 pausedTurnStore 注入(仅 recovery.enabled)

**目标:** recovery 开启时,给 `runtimeConfig` 注入**单一共享** `pausedTurnStore`,使主 runtime + 所有 worker + 将来重建的 worker 共享同一内存 store(重建 worker 的 `approve` 才能命中 recovery `restore` 进来的记录)。关闭时不注入 → 各自默认独立(CST-2 零回归)。

> **接线依据:** `createAgentRuntime({ pausedTurnStore = createPausedTurnStore() })`([agent-runtime.js:37](../../../src/core/runtime/agent-runtime.js#L37))本就是可注入配置位;`createRuntime = (o) => createAgentRuntime({ ...runtimeConfig, ...o })`([index.js:190](../../../src/index.js#L190))自动把 runtimeConfig 的 store 传给每个 worker。**agent-runtime 不改。**关闭时必须传 `undefined`(非 `null`)——`null` 会绕过默认参数导致 `null.size()` 崩溃。

### Task M3.1: 注入 + 共享/独立断言

**Files:**
- Modify: `src/index.js`
- Test: `tests/core/orchestration/shared-paused-store.test.js`

**Interfaces:**
- Consumes: `createPausedTurnStore`([paused-turn-store.js](../../../src/core/approval/paused-turn-store.js))
- Produces: recovery 开启时 `runtimeConfig.pausedTurnStore` = 单一共享实例;关闭时 = `undefined`(默认 per-instance)。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/shared-paused-store.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createAgentRuntime } from "../../../src/core/runtime/agent-runtime.js";
import { createPausedTurnStore } from "../../../src/core/approval/paused-turn-store.js";
import { createKernel } from "../../../src/index.js";

const REC = { approval_id: "ap1", turn_id: "t1", approval: { id: "ap1" }, turn: {}, resume_state: {} };

test("mechanism: a record restored via one runtime is visible to another sharing the store", () => {
  const shared = createPausedTurnStore();
  const a = createAgentRuntime({ pausedTurnStore: shared });
  const b = createAgentRuntime({ pausedTurnStore: shared });
  a.restorePaused(REC);
  assert.equal(b.listPaused().some((r) => r.approval_id === "ap1"), true);
});

test("mechanism: default (unshared) stores stay independent — off-path parity", () => {
  const a = createAgentRuntime({});
  const b = createAgentRuntime({});
  a.restorePaused(REC);
  assert.equal(b.listPaused().some((r) => r.approval_id === "ap1"), false);
});

// Orchestration worker (singleton in-main, gated) calls diff_apply -> needs approval -> pauses.
function mockGateway() {
  return {
    invoke: async (messages) => {
      const text = (messages || []).map((m) => m.content).join("\n");
      if (text.includes("Break the user's request")) return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
        { id: "st_a", goal: "edit a.js", acceptance: ["a edited"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }
      ] }), tool_calls: [] };
      if (text.includes("revising a multi-agent plan")) return { content: '{"done":true,"subtasks":[]}', tool_calls: [] };
      if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
      if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
      if (text.includes("Sub-task: edit a.js") && !text.includes("Applied change")) return { content: "", tool_calls: [{ id: "t1", name: "diff_apply", arguments: { diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-base a\n+edited a\n" } }] };
      return { content: "done", tool_calls: [] };
    },
    reply: async () => ({ content: "single" }), getUsageStats: () => ({})
  };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m3-shared-"));
  await fs.writeFile(path.join(root, "a.js"), "base a\n");
  return root;
}

test("recovery ON: orchestration worker pause is visible in the shared main-runtime store", async () => {
  const root = await fixture();
  const kernel = await createKernel(root, {
    modelGateway: mockGateway(), sessionLog: null, branchStore: null, verifyMode: "off",
    projectId: "proj", sessionId: "s", recovery: { enabled: true, lock: false, surface: "cli" }
  });
  const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  assert.equal(kernel.runtime.listPaused().some((r) => r.approval_id === p.approval.id), true);
  await kernel.dispose?.();
});

test("recovery OFF: orchestration worker pause is NOT in the main-runtime store (C5 in-memory only)", async () => {
  const root = await fixture();
  const kernel = await createKernel(root, {
    modelGateway: mockGateway(), eventBus: { publish() {}, subscribe: () => () => {} },
    sessionLog: null, branchStore: null, verifyMode: "off"
  });
  const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  assert.equal(kernel.runtime.listPaused().some((r) => r.approval_id === p.approval.id), false);
  await kernel.dispose?.();
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test tests/core/orchestration/shared-paused-store.test.js`
Expected: 「recovery ON」用例 FAIL —— 当前主 runtime 与 worker 各持独立 store,`kernel.runtime.listPaused()` 看不到 worker 的暂停(mechanism 两条与 OFF 条会先过)。

- [ ] **Step 3: 改 index.js**

(a) import 段([index.js:20](../../../src/index.js#L20) 附近)追加:
```js
import { createPausedTurnStore } from "./core/approval/paused-turn-store.js";
```

(b) 在 `pausedTurnPersistence` 定义后([index.js:70-72](../../../src/index.js#L70-L72))追加:
```js
  // Durable orchestration recovery: main runtime + all workers + rebuilt workers
  // share ONE paused-turn store so a recovery-restored record is visible to the
  // rebuilt worker's approve(). Off => undefined => each runtime keeps its own
  // default store (byte-for-byte today's behavior). Never null (null bypasses the
  // createAgentRuntime default param and would crash on .size()).
  const sharedPausedTurnStore = recoveryEnabled ? createPausedTurnStore() : null;
```

(c) `runtimeConfig` 内 `pausedTurnPersistence,` 一行([index.js:141](../../../src/index.js#L141))后追加:
```js
    pausedTurnStore: sharedPausedTurnStore || undefined,
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test tests/core/orchestration/shared-paused-store.test.js`
Expected: PASS(4 tests)。

- [ ] **Step 5: 局部回归(确认默认路径未动)**

Run: `node --test tests/core/orchestration/c5-rounds-e2e.test.js tests/integration/v2-durable-paused-turn.test.js`
Expected: PASS(C5 内存续跑 + 单 agent durable 未回归)。

- [ ] **Step 6: 提交**

```bash
git add src/index.js tests/core/orchestration/shared-paused-store.test.js
git commit -m "$(printf 'feat(orchestration): shared pausedTurnStore when recovery enabled (M3)')"
```

---

## Milestone M4 — orchestrator.resumeDurable(校验门 → 重建 → 重水化 → 续跑)

**目标:** 跨进程续跑的核心。给定 `approvalId`:过校验门(CST-6+CST-7)→ 反序列化状态 → 确定性重建 worker → 经共享 store 重水化其 turn 的 `approve` → 结算子任务 → `resumeDispatchLoop` 续本回合 → `driveFrom` 续后续回合。指纹/归属不符 → `ORCH_RECOVERY_BLOCKED`,**不重建、不 approve**。纯 mock 单测(不落真盘)。

### Task M4.1: resumeDurable + hasDurablePaused + persistDurablePause

**Files:**
- Modify: `src/core/orchestration/orchestrator.js`
- Test: `tests/core/orchestration/orchestrator-resume-durable.test.js`

**Interfaces:**
- Consumes(注入,M4 test 提供 mock;M7 wires 真件):
  - `orchPersistence: { load(approvalId), consume(approvalId), save(approvalId, json) }`
  - `pausedTurnStore: { get(approvalId), delete(approvalId) }`(共享 store)
  - `pausedTurnPersistence: { consume(approvalId) }`(worker sidecar,deny 路径清理)
  - `makeWorkerFactory`(重建 worker)、`orchestrationResumeGate`(M0)、`resumeDispatchLoop`(既有)
- Produces(orchestrator 内新增):
  - `resumeDurable(approvalId, decision="approve") => { status:"complete"|"awaiting_approval", ... }`(挂到返回;blocked → throw `code:"ORCH_RECOVERY_BLOCKED"`)
  - `hasDurablePaused(approvalId) => Promise<boolean>`(挂到返回)
  - `persistDurablePause(state, roundResult)` / `consumeWorkerSidecar(approvalId)`(内部闭包,不导出;M5 的 driveFrom/resume 复用)

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/orchestrator-resume-durable.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../../../src/core/orchestration/orchestrator.js";
import { serializeOrchestrationState } from "../../../src/core/orchestration/orchestration-recovery-contract.js";

function stub(id) { return { id, goal: id, acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }; }
function noBudget() { return { exceeded: () => null, snapshot: () => ({ tokens: 0, model_calls: 0, max_tokens: null, max_model_calls: null }) }; }

function makeSidecar({ approvalId = "ap1", taskId = "task_1", sessionId = "s", subtaskId = "a", remaining = [] } = {}) {
  const state = {
    message: "m", done_when: "d", options: { autonomy: "gated", sessionId },
    plan: { subtasks: [stub(subtaskId)] }, round: 1, allCollected: [],
    seenSubtaskIds: new Set([subtaskId]), seenFp: new Set(["fp"]), budget: noBudget(),
    adoptedExperienceIds: [], riskCues: new Set(), taskId, sessionId, env: { root: "/root", orchestrationConfig: {} }
  };
  return serializeOrchestrationState(state, { approvalId, pausedSubtask: stub(subtaskId), remaining });
}
function makeWorkerRecord({ approvalId = "ap1", taskId = "task_1", sessionId = "s", subtaskId = "a", marker = true } = {}) {
  return { approval_id: approvalId, turn_id: "t", approval: { id: approvalId }, turn: {}, resume_state: { options: marker ? { __orchestration: { taskId, sessionId, subtaskId } } : {} } };
}

function buildDurable(opts = {}) {
  const {
    workerFor, replan = async () => ({ done: true, subtasks: [] }), onPlan = () => {},
    sidecar = makeSidecar(), workerRecord = makeWorkerRecord(), reviewerPass = true, onWorkerBuild = () => {},
    orchConsumeSpy = () => {}, orchSaveSpy = () => {}, workerConsumeSpy = () => {}
  } = opts;
  return createOrchestrator({
    planner: { plan: async () => { onPlan(); return { subtasks: [] }; }, replan },
    makeWorkerFactory: () => ({ worker: (st) => { onWorkerBuild(st); return workerFor(st); } }),
    makeReviewerFor: () => ({ review: async () => ({ pass: reviewerPass, severity: "warn", reasons: [], checked: [] }) }),
    synthesizer: { synthesize: async ({ collected }) => collected.map((c) => `${c.st.id}=${c.status}`).join(",") },
    makeBudget: () => noBudget(), makeResumedBudget: () => noBudget(),
    maxSubtasks: 8, maxWorkerAttempts: 1, eventBus: { publish() {} }, makeContext: async () => null, maxRounds: 2,
    orchPersistence: { load: async () => sidecar, consume: async (id) => orchConsumeSpy(id), save: async (id, json) => orchSaveSpy(id, json) },
    pausedTurnStore: { get: () => workerRecord, delete: () => {} },
    pausedTurnPersistence: { consume: async (id) => workerConsumeSpy(id) },
    env: { root: "/root", orchestrationConfig: {} }
  });
}

test("resumeDurable: gate passes → rebuild + approve → settle → complete (no re-plan)", async () => {
  let planCalls = 0, approveCalls = 0, orchConsumed = null;
  const orch = buildDurable({
    workerFor: () => ({ approve: async () => { approveCalls += 1; return { status: "complete", content: "did a" }; } }),
    onPlan: () => { planCalls += 1; }, orchConsumeSpy: (id) => { orchConsumed = id; }
  });
  const done = await orch.resumeDurable("ap1", "approve");
  assert.equal(done.status, "complete");
  assert.match(done.content, /a=complete/);
  assert.equal(approveCalls, 1);
  assert.equal(planCalls, 0);          // durable resume never re-plans
  assert.equal(orchConsumed, "ap1");   // orchestration sidecar consumed on completion
});

test("resumeDurable: fingerprint mismatch → ORCH_RECOVERY_BLOCKED, no rebuild, no approve (CST-6)", async () => {
  let built = 0, approveCalls = 0;
  const bad = makeSidecar(); bad.fingerprints = { workerFactory: 9, toolSubset: 1, subtaskSchema: 1 };
  const orch = buildDurable({
    sidecar: bad, onWorkerBuild: () => { built += 1; },
    workerFor: () => ({ approve: async () => { approveCalls += 1; return { status: "complete" }; } })
  });
  await assert.rejects(() => orch.resumeDurable("ap1", "approve"), (e) => e.code === "ORCH_RECOVERY_BLOCKED");
  assert.equal(built, 0);
  assert.equal(approveCalls, 0);
});

test("resumeDurable: ownership mismatch → blocked (CST-7)", async () => {
  const orch = buildDurable({
    workerRecord: makeWorkerRecord({ subtaskId: "WRONG" }),
    workerFor: () => ({ approve: async () => ({ status: "complete" }) })
  });
  await assert.rejects(() => orch.resumeDurable("ap1", "approve"), (e) => e.code === "ORCH_RECOVERY_BLOCKED");
});

test("resumeDurable: missing worker record → blocked (orphan, CST-4)", async () => {
  const orch = buildDurable({ workerRecord: null, workerFor: () => ({ approve: async () => ({ status: "complete" }) }) });
  await assert.rejects(() => orch.resumeDurable("ap1", "approve"), (e) => e.code === "ORCH_RECOVERY_BLOCKED");
});

test("resumeDurable: deny → paused subtask failed, worker sidecar consumed, round continues", async () => {
  let workerConsumed = null;
  const orch = buildDurable({
    workerFor: () => ({ approve: async () => { throw new Error("approve must not be called on deny"); } }),
    workerConsumeSpy: (id) => { workerConsumed = id; }
  });
  const done = await orch.resumeDurable("ap1", "deny");
  assert.match(done.content, /a=failed/);
  assert.equal(done.outcome, "partial");
  assert.equal(workerConsumed, "ap1");   // deny path consumes the worker sidecar (agent-runtime didn't)
});

test("resumeDurable: re-pause writes a new durable sidecar and consumes the old", async () => {
  let saved = null, orchConsumed = null;
  const workers = {
    a: { approve: async () => ({ status: "complete", content: "a" }) },
    b: { send: async () => ({ status: "awaiting_approval", approval: { id: "ap2" } }) }
  };
  const orch = buildDurable({
    sidecar: makeSidecar({ subtaskId: "a", remaining: [stub("b")] }),
    workerFor: (st) => (st.id === "a" ? workers.a : workers.b),
    orchSaveSpy: (id) => { saved = id; }, orchConsumeSpy: (id) => { orchConsumed = id; }
  });
  const res = await orch.resumeDurable("ap1", "approve");
  assert.equal(res.status, "awaiting_approval");
  assert.equal(res.approval.id, "ap2");
  assert.equal(saved, "ap2");          // new durable sidecar written
  assert.equal(orchConsumed, "ap1");   // old consumed
  assert.equal(orch.hasPaused("ap2"), true);  // also tracked in-memory for same-process re-resume
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test tests/core/orchestration/orchestrator-resume-durable.test.js`
Expected: FAIL —— `orch.resumeDurable is not a function`。

- [ ] **Step 3: 改 orchestrator.js**

(a) M2 加的 import 行改为(追加 `orchestrationResumeGate`):
```js
import { serializeOrchestrationState, deserializeOrchestrationState, orchestrationResumeGate } from "./orchestration-recovery-contract.js";
```

(b) 参数解构追加两项(接 M2 已加的三项之后):
```js
  orchPersistence = null, makeResumedBudget = null, env = { root: null, orchestrationConfig: null },
  pausedTurnStore = null, pausedTurnPersistence = null
```

(c) 在 `resume` 函数之后、`return { ... }` 之前追加:
```js
  function blocked(reason) {
    const e = new Error(`orchestration recovery blocked: ${reason}`);
    e.code = "ORCH_RECOVERY_BLOCKED";
    return e;
  }

  // Consume a worker sidecar the deny path leaves behind (resumeDispatchLoop never
  // calls the worker's approve on deny, so agent-runtime never consumed it). No-op
  // primitives when recovery is off. Reused by the same-process resume (M5).
  async function consumeWorkerSidecar(approvalId) {
    await pausedTurnPersistence?.consume?.(approvalId);
    pausedTurnStore?.delete?.(approvalId);
  }

  // Persist a durable snapshot of a fresh pause (initial or re-pause). Opt-in: no-op
  // unless orchPersistence is injected (recovery.enabled). Used by driveFrom/resume (M5)
  // and resumeDurable's re-pause branch.
  async function persistDurablePause(state, roundResult) {
    if (!orchPersistence) return;
    const json = serializeState(state, {
      approvalId: roundResult.approval.id,
      pausedSubtask: roundResult.resume.pausedSubtask,
      remaining: roundResult.resume.remaining
    });
    await orchPersistence.save(roundResult.approval.id, json);
  }

  // Cross-process orchestration resume. Rebuild the paused worker from the persisted
  // subtask, rehydrate its turn via the shared store, settle, then continue the round
  // loop from saved state — no re-plan, no duplicate dispatch (CST-3).
  async function resumeDurable(approvalId, decision = "approve") {
    let sidecar;
    try { sidecar = await orchPersistence.load(approvalId); }
    catch (e) { throw blocked(`orchestration sidecar unreadable: ${e.message}`); }
    if (sidecar?.status === "consumed") throw blocked("orchestration sidecar already consumed");
    const workerRecord = pausedTurnStore?.get?.(approvalId) || null;
    const gate = orchestrationResumeGate({ sidecar, workerRecord });   // CST-6 + CST-7, fail-closed
    if (!gate.ok) throw blocked(gate.reason);

    const state = deserializeState(sidecar);
    const pausedWorker = makeWorkerFactory().worker(state.pausedSubtask);   // deterministic rebuild (CST-3)
    const dispatchResume = {
      pausedWorker, pausedApprovalId: approvalId,
      pausedSubtask: state.pausedSubtask, remaining: state.remaining, deps: dispatchDeps(state)
    };
    const res = await resumeDispatchLoop(dispatchResume, decision);
    state.allCollected.push(...res.collected);
    if (decision === "deny") await consumeWorkerSidecar(approvalId);
    if (res.status === "awaiting_approval") {
      await persistDurablePause(state, res);                // re-pause: new durable sidecar
      await orchPersistence.consume(approvalId);            // consume the old one
      orchPaused.set(res.approval.id, { state, dispatchResume: res.resume });   // same-process re-resume too
      return { status: "awaiting_approval", approval: res.approval, collected: state.allCollected };
    }
    await orchPersistence.consume(approvalId);              // round settled: consume this sidecar
    return driveFrom(state, { afterPausedRound: true });
  }

  function hasDurablePaused(approvalId) {
    if (!orchPersistence) return Promise.resolve(false);
    return orchPersistence.load(approvalId).then((r) => !!r && r.status !== "consumed").catch(() => false);
  }
```

(d) 返回对象追加两项(`persistDurablePause`/`consumeWorkerSidecar` 是内部闭包,不导出):
```js
  return { run, resume, hasPaused: (id) => orchPaused.has(id), flushExperience, serializeState, deserializeState, resumeDurable, hasDurablePaused };
```

- [ ] **Step 4: 跑测试,确认通过 + 编排回归**

Run: `node --test tests/core/orchestration/orchestrator-resume-durable.test.js tests/core/orchestration/orchestrator-resume.test.js tests/core/orchestration/orchestrator-serialize.test.js`
Expected: PASS(6 新 + 既有不回归)。

- [ ] **Step 5: 提交**

```bash
git add src/core/orchestration/orchestrator.js tests/core/orchestration/orchestrator-resume-durable.test.js
git commit -m "$(printf 'feat(orchestration): resumeDurable — gate + rebuild worker + rehydrate approve + continue (M4)')"
```

---

## Milestone M5 — 暂停时双写 sidecar(`__orchestration` 标记 + 编排 sidecar)

**目标:** worker 暂停时,(a) worker sidecar 带上 `__orchestration` 归属标记(经 send options → `resume_state.options`);(b) orchestrator 在 `driveFrom`/`resume` 的暂停点写编排 sidecar、在 resume 处消旧。全部 gated on `orchPersistence` 注入(recovery 开启)。

> **写序澄清(见 Global Constraints):** worker sidecar 由 `worker.send` 内部先写(CST-1 不可改),编排 sidecar 由 orchestrator 见 `awaiting_approval` 后写。故崩溃窗口是「worker 在、编排缺」= CST-4 边界①的 blocked 分支。安全不变量(孤儿一律 blocked)不受写序影响。

### Task M5.1: dispatch-loop 注入 `__orchestration` 标记

**Files:**
- Modify: `src/core/orchestration/dispatch-loop.js`
- Modify: `src/core/orchestration/orchestrator.js`(`dispatchDeps` 供给 marker base)
- Test: `tests/core/orchestration/orchestration-pause-persist.test.js`

**Interfaces:**
- Produces:`runDispatchLoop`/`runBatched`/`processSubtask` 接受 `orchestrationMarker = null`;marker 存在时 worker `send` options 带 `__orchestration: { ...marker, subtaskId: st.id }`。**null → send options 与今日逐字节相同(CST-2)。**
- Consumes:`dispatchDeps` 产出 `orchestrationMarker: orchPersistence ? { taskId, sessionId } : null`。

- [ ] **Step 1: 写失败测试(新建测试文件,先放 marker 两条)**

```js
// tests/core/orchestration/orchestration-pause-persist.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDispatchLoop } from "../../../src/core/orchestration/dispatch-loop.js";

function st(id) { return { id, goal: id, acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }; }
const reviewerOk = () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) });

test("worker send options carry __orchestration marker when durable", async () => {
  let captured = null;
  const worker = { send: async (_p, opts) => { captured = opts; return { status: "awaiting_approval", approval: { id: "apX" } }; }, approve: async () => ({}) };
  await runDispatchLoop({
    plan: { subtasks: [st("a")] }, workerFactory: { worker: () => worker }, makeReviewer: reviewerOk,
    synthesizer: { synthesize: async () => "" }, budget: { exceeded: () => null }, maxWorkerAttempts: 1, autonomy: "gated",
    orchestrationMarker: { taskId: "task_1", sessionId: "s" }
  });
  assert.deepEqual(captured.__orchestration, { taskId: "task_1", sessionId: "s", subtaskId: "a" });
});

test("no __orchestration marker when not durable (off parity)", async () => {
  let captured = null;
  const worker = { send: async (_p, opts) => { captured = opts; return { status: "complete", content: "ok" }; } };
  await runDispatchLoop({
    plan: { subtasks: [st("a")] }, workerFactory: { worker: () => worker }, makeReviewer: reviewerOk,
    synthesizer: { synthesize: async () => "" }, budget: { exceeded: () => null }, maxWorkerAttempts: 1, autonomy: "gated"
  });
  assert.equal("__orchestration" in captured, false);
  assert.deepEqual(Object.keys(captured).sort(), ["autonomy", "projectRules"]);
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test tests/core/orchestration/orchestration-pause-persist.test.js`
Expected: FAIL —— 第一条(`captured.__orchestration` 为 undefined)。

- [ ] **Step 3: 改 dispatch-loop.js**

(a) `runDispatchLoop` 参数解构([dispatch-loop.js:5-8](../../../src/core/orchestration/dispatch-loop.js#L5-L8))追加 `orchestrationMarker = null`;并把它加入内部 `deps` 对象([dispatch-loop.js:16](../../../src/core/orchestration/dispatch-loop.js#L16))、`runBatched` 调用([dispatch-loop.js:12](../../../src/core/orchestration/dispatch-loop.js#L12))、`processSubtask` 调用([dispatch-loop.js:20](../../../src/core/orchestration/dispatch-loop.js#L20)):
```js
export async function runDispatchLoop({
  plan, workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, onEvent,
  toBatches, maxParallelWorkers = 1, runIsolatedWorker, mergeSubtask, removeIso, projectRules = [], orchestrationMarker = null
}) {
  if (maxParallelWorkers > 1 && typeof toBatches === "function" && typeof runIsolatedWorker === "function") {
    return runBatched({ plan, workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, toBatches, maxParallelWorkers, runIsolatedWorker, mergeSubtask, removeIso, onEvent, projectRules, orchestrationMarker });
  }
  const order = orderOf(plan);
  const deps = { workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, onEvent, toBatches, maxParallelWorkers, runIsolatedWorker, mergeSubtask, removeIso, projectRules, orchestrationMarker };
  const collected = [];
  for (let i = 0; i < order.length; i += 1) {
    const st = order[i];
    const r = await processSubtask(st, { workerFactory, makeReviewer, maxWorkerAttempts, autonomy, onEvent, projectRules, orchestrationMarker });
```

(b) `processSubtask`([dispatch-loop.js:68-73](../../../src/core/orchestration/dispatch-loop.js#L68-L73))加 `orchestrationMarker` 参数 + 构造 sendOptions:
```js
async function processSubtask(st, { workerFactory, makeReviewer, maxWorkerAttempts, autonomy, onEvent, projectRules = [], orchestrationMarker = null }) {
  let priorFeedback = null;
  for (let attempt = 1; attempt <= maxWorkerAttempts; attempt += 1) {
    onEvent?.("subtask_started", { subtask_id: st.id, attempt, tool_profile: st.tool_profile });
    const worker = workerFactory.worker(st);
    const sendOptions = { autonomy, projectRules };
    if (orchestrationMarker) sendOptions.__orchestration = { ...orchestrationMarker, subtaskId: st.id };
    const wres = await worker.send(workerPrompt(st, priorFeedback), sendOptions);
```

(c) `runBatched`([dispatch-loop.js:86](../../../src/core/orchestration/dispatch-loop.js#L86))解构追加 `orchestrationMarker = null`,并把它加入其内部 size-1 分支的 `processSubtask` 调用([dispatch-loop.js:95](../../../src/core/orchestration/dispatch-loop.js#L95))与暂停 `deps` 对象([dispatch-loop.js:99](../../../src/core/orchestration/dispatch-loop.js#L99)):
```js
async function runBatched({ plan, workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, toBatches, maxParallelWorkers, runIsolatedWorker, mergeSubtask, removeIso, onEvent, projectRules = [], orchestrationMarker = null }) {
  // ... 在 batch.length === 1 分支:
      const r = await processSubtask(batch[0], { workerFactory, makeReviewer, maxWorkerAttempts, autonomy, onEvent, projectRules, orchestrationMarker });
  // ... 其暂停时的 deps 对象追加 orchestrationMarker（与非批 deps 对齐）
```

(d) orchestrator `dispatchDeps`([orchestrator.js:42-53](../../../src/core/orchestration/orchestrator.js#L42-L53))返回对象追加:
```js
      projectRules: learningOn ? riskRules(state.riskCues) : [],
      orchestrationMarker: orchPersistence ? { taskId: state.taskId, sessionId: state.sessionId } : null
```

- [ ] **Step 4: 跑测试,确认通过 + dispatch 回归**

Run: `node --test tests/core/orchestration/orchestration-pause-persist.test.js tests/core/orchestration/dispatch-loop.test.js tests/core/orchestration/dispatch-resume.test.js tests/core/orchestration/dispatch-parallel.test.js`
Expected: PASS(marker 2 条 + dispatch 既有不回归)。

- [ ] **Step 5: 提交**

```bash
git add src/core/orchestration/dispatch-loop.js src/core/orchestration/orchestrator.js tests/core/orchestration/orchestration-pause-persist.test.js
git commit -m "$(printf 'feat(orchestration): inject __orchestration ownership marker into worker send options (M5.1)')"
```

### Task M5.2: driveFrom / resume 暂停点双写编排 sidecar

**Files:**
- Modify: `src/core/orchestration/orchestrator.js`
- Modify: `tests/core/orchestration/orchestration-pause-persist.test.js`(追加)

**Interfaces:**
- Consumes: `persistDurablePause`/`consumeWorkerSidecar`(M4)、`orchPersistence`
- Produces: `driveFrom` 初次暂停 → `orchPersistence.save`;`resume`(同进程)→ 消旧 sidecar(`orchPersistence.consume(id)`)+ 再暂停写新 + deny 清 worker sidecar。**全 gated;off 逐字节不变。**

- [ ] **Step 1: 追加失败测试**

```js
// 追加到 tests/core/orchestration/orchestration-pause-persist.test.js
import { createOrchestrator } from "../../../src/core/orchestration/orchestrator.js";

function noBudget() { return { exceeded: () => null, snapshot: () => ({ tokens: 0, model_calls: 0, max_tokens: null, max_model_calls: null }) }; }
function buildOrch({ subtasks, workerFor, orchPersistence = null }) {
  return createOrchestrator({
    planner: { plan: async () => ({ task_summary: "t", done_when: "d", subtasks }), replan: async () => ({ done: true, subtasks: [] }) },
    makeWorkerFactory: () => ({ worker: (s) => workerFor(s) }),
    makeReviewerFor: () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) }),
    synthesizer: { synthesize: async ({ collected }) => collected.map((c) => `${c.st.id}=${c.status}`).join(",") },
    makeBudget: () => noBudget(), makeResumedBudget: () => noBudget(),
    maxSubtasks: 8, maxWorkerAttempts: 1, eventBus: { publish() {} }, makeContext: async () => null, maxRounds: 2,
    orchPersistence, pausedTurnStore: { get: () => null, delete: () => {} }, pausedTurnPersistence: { consume: async () => {} },
    env: { root: "/root", orchestrationConfig: {} }
  });
}

test("initial pause writes a durable orchestration sidecar (driveFrom, recovery on)", async () => {
  let saved = null;
  const orch = buildOrch({
    subtasks: [st("a"), st("b")],
    workerFor: (s) => (s.id === "a"
      ? { send: async () => ({ status: "awaiting_approval", approval: { id: "ap1" } }), approve: async () => ({ status: "complete", content: "a" }) }
      : { send: async () => ({ status: "complete", content: "b" }) }),
    orchPersistence: { save: async (id, json) => { saved = { id, json }; }, consume: async () => {}, load: async () => null }
  });
  const p = await orch.run({ message: "m", options: { autonomy: "gated" } });
  assert.equal(p.status, "awaiting_approval");
  assert.equal(saved.id, "ap1");
  assert.equal(saved.json.pausedSubtask.id, "a");
  assert.deepEqual(saved.json.remaining.map((s) => s.id), ["b"]);
});

test("off: no durable sidecar written, C5 in-memory path unchanged", async () => {
  const orch = buildOrch({
    subtasks: [st("a")],
    workerFor: () => ({ send: async () => ({ status: "awaiting_approval", approval: { id: "ap1" } }) })
    // orchPersistence omitted -> null
  });
  const p = await orch.run({ message: "m", options: { autonomy: "gated" } });
  assert.equal(p.status, "awaiting_approval");
  assert.equal(orch.hasPaused("ap1"), true);   // held in memory only (C5)
});

test("same-process resume consumes the old durable sidecar", async () => {
  const consumed = [];
  const orch = buildOrch({
    subtasks: [st("a"), st("b")],
    workerFor: (s) => (s.id === "a"
      ? { send: async () => ({ status: "awaiting_approval", approval: { id: "ap1" } }), approve: async () => ({ status: "complete", content: "a" }) }
      : { send: async () => ({ status: "complete", content: "b" }) }),
    orchPersistence: { save: async () => {}, consume: async (id) => { consumed.push(id); }, load: async () => null }
  });
  await orch.run({ message: "m", options: { autonomy: "gated" } });
  const done = await orch.resume("ap1", "approve");
  assert.equal(done.status, "complete");
  assert.ok(consumed.includes("ap1"));   // old sidecar consumed on resume
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test tests/core/orchestration/orchestration-pause-persist.test.js`
Expected: FAIL —— 「initial pause」`saved` 仍为 null(driveFrom 未写)。

- [ ] **Step 3: 改 orchestrator.js**

(a) `driveFrom` 暂停分支([orchestrator.js:63-66](../../../src/core/orchestration/orchestrator.js#L63-L66))在 `return` 前插入 `persistDurablePause`:
```js
        if (result.status === "awaiting_approval") {
          orchPaused.set(result.approval.id, { state, dispatchResume: result.resume });
          await persistDurablePause(state, result);      // M5: durable double-write (no-op when off)
          return { status: "awaiting_approval", approval: result.approval, collected: state.allCollected };
        }
```

(b) `resume`([orchestrator.js:129-141](../../../src/core/orchestration/orchestrator.js#L129-L141))整体替换为(加消旧 + deny 清 worker + 再暂停写新;全 gated):
```js
  async function resume(id, decision = "approve") {
    const saved = orchPaused.get(id);
    if (!saved) { const e = new Error(`no paused orchestration: ${id}`); e.code = "ORCH_NOT_PAUSED"; throw e; }
    orchPaused.delete(id);                                  // consume in-memory
    const { state, dispatchResume } = saved;
    const res = await resumeDispatchLoop(dispatchResume, decision);
    state.allCollected.push(...res.collected);
    if (decision === "deny") await consumeWorkerSidecar(dispatchResume.pausedApprovalId);   // M5: deny cleans worker sidecar
    if (orchPersistence) await orchPersistence.consume(id).catch(() => {});                  // M5: consume old durable sidecar
    if (res.status === "awaiting_approval") {
      orchPaused.set(res.approval.id, { state, dispatchResume: res.resume });   // re-pause: new id
      await persistDurablePause(state, res);                                    // M5: new durable sidecar
      return { status: "awaiting_approval", approval: res.approval, collected: state.allCollected };
    }
    return driveFrom(state, { afterPausedRound: true });    // round done -> gate + further rounds
  }
```

- [ ] **Step 4: 跑测试,确认通过 + 编排回归**

Run: `node --test tests/core/orchestration/orchestration-pause-persist.test.js tests/core/orchestration/orchestrator-resume.test.js tests/core/orchestration/c5-rounds-e2e.test.js`
Expected: PASS(新 3 条 + C5 同进程续跑不回归)。

- [ ] **Step 5: 提交**

```bash
git add src/core/orchestration/orchestrator.js tests/core/orchestration/orchestration-pause-persist.test.js
git commit -m "$(printf 'feat(orchestration): durable sidecar double-write on pause + consume-on-resume (M5.2)')"
```

---

## Milestone M6 — recovery-service 扫 orchestration-paused + 孤儿一律 blocked

**目标:** `recoverOnStartup` 除既有事务日志 + 单 agent paused sidecar,新扫 `orchestration-paused/` 并与 worker sidecar 交叉校验;`resume`/`cancel` 处理 `rec_orch_` 项;**边界①(CST-4):orchestration-marked worker 孤儿一律 blocked,绝不降级单 agent**。

> recovery-service 仅在 recovery 开启时构造([index.js:384](../../../src/index.js#L384)),故本 M 改动只作用于 recovery-ON;单 agent(无 `__orchestration` 标记)路径逐字节不变。

### Task M6.1: 扫描 + 交叉校验 + resume/cancel 路由

**Files:**
- Modify: `src/core/recovery/recovery-service.js`
- Test: `tests/unit/core/recovery/recovery-service-orchestration.test.js`

**Interfaces:**
- Consumes(注入,M7 wires): `orchPersistence: { scan, consume, quarantine }`(nullable)、`resumeOrchestration(approvalId, decision)`(nullable)、`isOrchestrationWorkerSidecar`/`orchestrationResumeGate`(M0)
- Produces: inbox 项 `rec_orch_<approvalId>`(type `orchestration_paused`,resume/cancel)或 `blocked_recovery`(cancel);`resume(rec_orch_...)` → `resumeOrchestration`;`cancel(rec_orch_...)` → 隔离两份 sidecar。

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/core/recovery/recovery-service-orchestration.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createRecoveryService } from "../../../../src/core/recovery/recovery-service.js";
import { serializeOrchestrationState } from "../../../../src/core/orchestration/orchestration-recovery-contract.js";

function noBudget() { return { snapshot: () => ({ tokens: 0, model_calls: 0, max_tokens: null, max_model_calls: null }) }; }
function orchSidecar({ approvalId = "ap_orch", taskId = "task_1", sessionId = "s", subtaskId = "a" } = {}) {
  const state = { message: "m", done_when: "d", options: { autonomy: "gated", sessionId }, plan: { subtasks: [] }, round: 1, allCollected: [],
    seenSubtaskIds: new Set(), seenFp: new Set(), budget: noBudget(), adoptedExperienceIds: [], riskCues: new Set(), taskId, sessionId, env: { root: "/r", orchestrationConfig: {} } };
  return serializeOrchestrationState(state, { approvalId, pausedSubtask: { id: subtaskId, goal: "g", acceptance: [], context_scope: {}, tool_profile: "edit", depends_on: [] }, remaining: [] });
}
function workerRec({ approvalId = "ap_orch", taskId = "task_1", sessionId = "s", subtaskId = "a", marker = true } = {}) {
  return { approval_id: approvalId, turn_id: "t", session_id: sessionId, surface: "cli", approval: { id: approvalId, summary: "edit" }, turn: {}, permission_context: {}, resume_state: { options: marker ? { __orchestration: { taskId, sessionId, subtaskId } } : {} } };
}
function fakeInbox(items) {
  return {
    upsert: async (it) => { const i = items.findIndex((x) => x.id === it.id); if (i >= 0) items[i] = { ...items[i], ...it }; else items.push({ ...it }); },
    list: async () => items, get: async (id) => items.find((x) => x.id === id) || null,
    mark: async (id, patch) => { const it = items.find((x) => x.id === id); if (it) Object.assign(it, patch); }
  };
}
function svc({ pausedScan = [], orchScan = [], restored = [], items = [], resumeOrchestration = null }) {
  return createRecoveryService({
    projectId: "proj", lock: { assertOwner: async () => {}, epoch: 1 },
    paused: { baseDir: "/base", scan: async () => pausedScan, quarantine: async () => ({ status: "quarantined" }) },
    orchPersistence: { scan: async () => orchScan, consume: async () => {}, quarantine: async () => ({ status: "quarantined" }) },
    pausedTurnStore: { restore: (r) => restored.push(r), list: () => [] },
    inbox: fakeInbox(items), appendMarker: async () => {}, resumeOrchestration
  });
}

test("matched orchestration sidecar + worker -> orchestration_paused inbox, worker restored", async () => {
  const restored = [], items = [];
  await svc({ pausedScan: [workerRec()], orchScan: [orchSidecar()], restored, items }).recoverOnStartup();
  const item = items.find((x) => x.id === "rec_orch_ap_orch");
  assert.equal(item.type, "orchestration_paused");
  assert.equal(item.status, "pending");
  assert.deepEqual(item.allowed_actions, ["resume", "cancel"]);
  assert.equal(restored.some((r) => r.approval_id === "ap_orch"), true);
});

test("orphan orchestration worker (no orchestration sidecar) -> blocked, NEVER single-agent (CST-4)", async () => {
  const restored = [], items = [];
  await svc({ pausedScan: [workerRec({ approvalId: "ap_orphan", subtaskId: "a" })], orchScan: [], restored, items }).recoverOnStartup();
  const item = items.find((x) => x.id === "rec_pause_ap_orphan");
  assert.equal(item.type, "blocked_recovery");
  assert.equal(item.status, "blocked");
  assert.deepEqual(item.allowed_actions, ["cancel"]);
  assert.equal(restored.length, 0);
});

test("orchestration sidecar with fingerprint mismatch -> blocked (CST-6)", async () => {
  const items = [];
  const bad = orchSidecar(); bad.fingerprints = { workerFactory: 9, toolSubset: 1, subtaskSchema: 1 };
  await svc({ pausedScan: [workerRec()], orchScan: [bad], items }).recoverOnStartup();
  assert.equal(items.find((x) => x.id === "rec_orch_ap_orch").type, "blocked_recovery");
});

test("plain single-agent sidecar (no marker) still restores as paused_turn (no regression)", async () => {
  const restored = [], items = [];
  await svc({ pausedScan: [workerRec({ approvalId: "ap_single", marker: false })], orchScan: [], restored, items }).recoverOnStartup();
  assert.equal(items.find((x) => x.id === "rec_pause_ap_single").type, "paused_turn");
  assert.equal(restored.some((r) => r.approval_id === "ap_single"), true);
});

test("resume(rec_orch_...) routes to resumeOrchestration", async () => {
  const calls = [];
  const items = [{ id: "rec_orch_ap_orch", type: "orchestration_paused", status: "pending", source_id: "ap_orch" }];
  const s = svc({ items, resumeOrchestration: async (approvalId, decision) => { calls.push([approvalId, decision]); return { status: "complete" }; } });
  const res = await s.resume("rec_orch_ap_orch", { decision: "approve" });
  assert.deepEqual(calls, [["ap_orch", "approve"]]);
  assert.equal(res.status, "resumed");
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test tests/unit/core/recovery/recovery-service-orchestration.test.js`
Expected: FAIL —— orchestration join 未实现(rec_orch 项不存在;orphan 走了单 agent restore)。

- [ ] **Step 3: 改 recovery-service.js**

(a) 文件顶部加 import:
```js
import { isOrchestrationWorkerSidecar, orchestrationResumeGate } from "../orchestration/orchestration-recovery-contract.js";
```

(b) 工厂参数([recovery-service.js:1-11](../../../src/core/recovery/recovery-service.js#L1-L11))追加两项:
```js
export function createRecoveryService({
  projectId, lock, paused, pausedTurnStore, inbox, appendMarker,
  resumePaused = null, cancelPaused = null, transactionJournal = null,
  orchPersistence = null, resumeOrchestration = null
}) {
```

(c) 把 paused-scan 循环([recovery-service.js:80-130](../../../src/core/recovery/recovery-service.js#L80-L130))**整段替换**为(单 agent 分支加 `__orchestration` 守卫 + 收集 worker + 编排 join + 孤儿 blocked):
```js
    // Scan paused sidecars. Orchestration-owned worker sidecars are deferred to the
    // orchestration join below (never treated as single-agent — CST-4).
    const scanned = await paused.scan();
    const orchWorkers = new Map();   // approvalId -> valid orchestration worker sidecar
    for (const item of scanned) {
      if (item.status === "corrupt") {
        found.push({ type: "paused_turn", summary: `Corrupt paused sidecar: ${item.approval_id}` });
        blocked.push({ type: "paused_turn", summary: `Corrupt paused sidecar: ${item.approval_id}`, reason: item.reason });
        await inbox.upsert({ id: `rec_pause_${item.approval_id}`, type: "blocked_recovery", status: "blocked", source_id: item.approval_id,
          summary: `Corrupt paused sidecar: ${item.approval_id}`, evidence: { sidecar_path: item.path }, allowed_actions: ["cancel"] });
        await appendMarker("recovery:blocked", { item_id: `rec_pause_${item.approval_id}`, source_id: item.approval_id, reason: item.reason || "corrupt sidecar" });
        continue;
      }
      if (item.status === "consumed") continue;
      if (isOrchestrationWorkerSidecar(item)) { orchWorkers.set(item.approval_id, item); continue; }  // defer to join
      // Valid single-agent paused record (unchanged path)
      found.push({ type: "paused_turn", summary: `Paused approval: ${item.approval_id}` });
      pausedTurnStore.restore(item);
      await inbox.upsert({ id: `rec_pause_${item.approval_id}`, type: "paused_turn", status: "pending", source_id: item.approval_id,
        summary: `Paused ${item.surface || "turn"}: ${item.approval?.summary || "approval required"}`, evidence: { sidecar_path: paused.baseDir },
        allowed_actions: ["resume", "cancel"], metadata: { turn_id: item.turn_id, autonomy: item.permission_context?.autonomy || item.turn?.autonomy, surface: item.surface } });
      await appendMarker("turn:rehydrated", { approval_id: item.approval_id, turn_id: item.turn_id, original_session_id: item.session_id, marker_status: "ok" });
      done.push({ type: "paused_turn", summary: `Rehydrated approval: ${item.approval_id}` });
      next.push(`/recovery resume rec_pause_${item.approval_id}`);
    }

    // Orchestration join: match each orchestration sidecar to its worker sidecar under
    // the authoritative gate (CST-6 + CST-7). Everything that fails -> blocked (CST-4).
    const handledOrchWorkers = new Set();
    const orchScanned = orchPersistence ? await orchPersistence.scan() : [];
    for (const oc of orchScanned) {
      if (oc.status === "consumed") continue;
      const approvalId = oc.approvalId;
      const workerRecord = orchWorkers.get(approvalId) || null;
      if (workerRecord) handledOrchWorkers.add(approvalId);
      if (oc.status === "corrupt") { await blockOrchestration(approvalId, oc.reason || "corrupt orchestration sidecar"); continue; }
      const gate = orchestrationResumeGate({ sidecar: oc, workerRecord });
      if (!gate.ok) { await blockOrchestration(approvalId, gate.reason); continue; }
      // OK: restore the worker turn into the shared store so the rebuilt worker's approve sees it.
      pausedTurnStore.restore(workerRecord);
      const completed = (oc.allCollected || []).filter((c) => c.status === "complete").length;
      found.push({ type: "orchestration_paused", summary: `Paused orchestration ${oc.taskId} round ${oc.round}` });
      await inbox.upsert({ id: `rec_orch_${approvalId}`, type: "orchestration_paused", status: "pending", source_id: approvalId,
        summary: `Paused orchestration task ${oc.taskId} (round ${oc.round})`, evidence: { taskId: oc.taskId, round: oc.round, completed },
        allowed_actions: ["resume", "cancel"], metadata: { taskId: oc.taskId, round: oc.round, session_id: oc.sessionId } });
      await appendMarker("turn:rehydrated", { approval_id: approvalId, turn_id: workerRecord.turn_id, original_session_id: oc.sessionId, marker_status: "ok" });
      done.push({ type: "orchestration_paused", summary: `Rehydrated orchestration: ${approvalId}` });
      next.push(`/recovery resume rec_orch_${approvalId}`);
    }
    // Orphan orchestration workers: marked but no matching (valid) orchestration sidecar -> blocked (CST-4).
    for (const [approvalId] of orchWorkers) {
      if (handledOrchWorkers.has(approvalId)) continue;
      const reason = orchPersistence ? "orphaned orchestration worker sidecar (no matching orchestration sidecar)" : "orchestration recovery unavailable";
      blocked.push({ type: "paused_turn", summary: `Blocked orphan orchestration worker: ${approvalId}`, reason });
      await inbox.upsert({ id: `rec_pause_${approvalId}`, type: "blocked_recovery", status: "blocked", source_id: approvalId,
        summary: `Blocked orphan orchestration worker: ${approvalId}`, evidence: { reason }, allowed_actions: ["cancel"] });
      await appendMarker("recovery:blocked", { item_id: `rec_pause_${approvalId}`, source_id: approvalId, reason });
    }
```

(d) 在 `recoverOnStartup` 内部(或工厂内)加一个私有 helper(放 `recoverOnStartup` 上方即可,闭包可见 `blocked`/`inbox`/`appendMarker`)——**注意** `blocked` 是 `recoverOnStartup` 内的局部数组,故把 helper 定义为 `recoverOnStartup` 内的内嵌函数:
```js
    async function blockOrchestration(approvalId, reason) {
      blocked.push({ type: "orchestration_paused", summary: `Blocked orchestration: ${approvalId}`, reason });
      await inbox.upsert({ id: `rec_orch_${approvalId}`, type: "blocked_recovery", status: "blocked", source_id: approvalId,
        summary: `Blocked orchestration recovery: ${approvalId}`, evidence: { reason }, allowed_actions: ["cancel"] });
      await appendMarker("recovery:blocked", { item_id: `rec_orch_${approvalId}`, source_id: approvalId, reason });
    }
```
> 把 `blockOrchestration` 定义在 `recoverOnStartup` 顶部(`const found = []; ... const next = [];` 之后),使其闭包捕获这四个局部数组与注入的 `inbox`/`appendMarker`。

(e) `resume`([recovery-service.js:177-192](../../../src/core/recovery/recovery-service.js#L177-L192))开头加 `rec_orch_` 分支:
```js
  async function resume(id, { decision = "approve" } = {}) {
    if (id.startsWith("rec_orch_")) {
      const approvalId = id.replace(/^rec_orch_/, "");
      if (!resumeOrchestration) throw new Error("orchestration recovery resume not wired");
      const result = await resumeOrchestration(approvalId, decision);
      const item = await inbox.get(id);
      if (item) await inbox.mark(id, { status: "resumed" });
      return { status: "resumed", item, result };
    }
    if (!id.startsWith("rec_pause_")) throw new Error(`invalid resume target: ${id}`);
    // ... 既有 rec_pause_ 逻辑不变 ...
```

(f) `cancel`([recovery-service.js:194-218](../../../src/core/recovery/recovery-service.js#L194-L218))开头加 `rec_orch_` 分支:
```js
  async function cancel(id) {
    if (id.startsWith("rec_orch_")) {
      const approvalId = id.replace(/^rec_orch_/, "");
      const item = await inbox.get(id);
      const orchResult = orchPersistence ? await orchPersistence.quarantine(approvalId, "operator cancelled orchestration recovery").catch(() => null) : null;
      await paused.quarantine(approvalId, "operator cancelled orchestration recovery").catch(() => {});   // best-effort worker sidecar
      if (item) await inbox.mark(id, { status: "cancelled" });
      return { status: "cancelled", item, result: orchResult };
    }
    if (!id.startsWith("rec_pause_")) throw new Error(`invalid cancel target: ${id}`);
    // ... 既有 rec_pause_ 逻辑不变(含 blocked corrupt 隔离 + 普通 cancelPaused)...
```

- [ ] **Step 4: 跑测试,确认通过 + recovery 回归**

Run: `node --test tests/unit/core/recovery/recovery-service-orchestration.test.js tests/unit/core/recovery/recovery-service.test.js`
Expected: PASS(新 5 条 + 既有 recovery-service 单测不回归)。

- [ ] **Step 5: 提交**

```bash
git add src/core/recovery/recovery-service.js tests/unit/core/recovery/recovery-service-orchestration.test.js
git commit -m "$(printf 'feat(recovery): scan orchestration-paused + orphan-blocked policy + orch resume/cancel routing (M6)')"
```

---

## Milestone M7 — index.js 接线(注入 + recovery 路由 + durable approve)

**目标:** recovery 开启时把所有真件接上:orchestrator 拿到 `orchPersistence`/`makeResumedBudget`/`env`/共享 store/worker sidecar consume;`recovery-service` 拿到 `orchPersistence` + `resumeOrchestration`;`kernel.agent.approve` 对 durable id 路由到 `resumeDurable`。关闭时全部为 null/undefined,逐字节零回归。

### Task M7.1: 全链路接线

**Files:**
- Modify: `src/index.js`
- Test: `tests/core/orchestration/durable-orchestration-wiring.test.js`

**Interfaces:**
- Consumes: `createOrchestrationPersistence`(M1)、`createCostBudget`(已 import)、`orchestrator.resumeDurable`/`hasDurablePaused`(M4)
- Produces: 暂停时磁盘同时出现 worker + orchestration 两份 sidecar;重启 kernel 的 `recovery.list()` 含 `orchestration_paused` 项;`kernel.agent.approve(rawApprovalId)` 对 durable id 路由。

- [ ] **Step 1: 写失败测试**

```js
// tests/core/orchestration/durable-orchestration-wiring.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createKernel } from "../../../src/index.js";

function mockGateway() {
  return {
    invoke: async (messages) => {
      const text = (messages || []).map((m) => m.content).join("\n");
      if (text.includes("Break the user's request")) return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
        { id: "st_a", goal: "edit a.js", acceptance: ["a edited"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }
      ] }), tool_calls: [] };
      if (text.includes("revising a multi-agent plan")) return { content: '{"done":true,"subtasks":[]}', tool_calls: [] };
      if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
      if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
      if (text.includes("Sub-task: edit a.js") && !text.includes("Applied change")) return { content: "", tool_calls: [{ id: "t1", name: "diff_apply", arguments: { diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-base a\n+edited a\n" } }] };
      return { content: "done", tool_calls: [] };
    },
    reply: async () => ({ content: "single" }), getUsageStats: () => ({})
  };
}
const exists = async (p) => { try { await fs.stat(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "m7-wire-")); await fs.writeFile(path.join(root, "a.js"), "base a\n"); return root; }
const sidecars = (root) => ({
  worker: (id) => path.join(root, ".deepseek-code", "v2", "sessions", "proj", "paused", `${id}.json`),
  orch: (id) => path.join(root, ".deepseek-code", "v2", "sessions", "proj", "orchestration-paused", `${id}.json`),
  orchDir: path.join(root, ".deepseek-code", "v2", "sessions", "proj", "orchestration-paused")
});

test("recovery ON: orchestration worker pause writes BOTH worker and orchestration sidecars", async () => {
  const root = await fixture();
  const kernel = await createKernel(root, { modelGateway: mockGateway(), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "s", recovery: { enabled: true, lock: false, surface: "cli" } });
  const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  const s = sidecars(root);
  assert.equal(await exists(s.worker(p.approval.id)), true, "worker sidecar written");
  assert.equal(await exists(s.orch(p.approval.id)), true, "orchestration sidecar written");
  await kernel.dispose?.();
});

test("recovery OFF: no orchestration-paused dir created (zero regression)", async () => {
  const root = await fixture();
  const kernel = await createKernel(root, { modelGateway: mockGateway(), eventBus: { publish() {}, subscribe: () => () => {} }, sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj" });
  const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  assert.equal(await exists(sidecars(root).orchDir), false);
  await kernel.dispose?.();
});

test("recovery ON: a restart kernel lists the orchestration_paused recovery item", async () => {
  const root = await fixture();
  const a = await createKernel(root, { modelGateway: mockGateway(), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "sA", recovery: { enabled: true, lock: false, surface: "cli" } });
  const p = await a.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  await a.dispose?.();

  const b = await createKernel(root, { modelGateway: mockGateway(), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "sB", recovery: { enabled: true, lock: false, surface: "cli" } });
  const items = await b.recovery.list();
  assert.ok(items.some((i) => i.type === "orchestration_paused" && i.source_id === p.approval.id));
  assert.equal(items.some((i) => i.type === "paused_turn" && i.source_id === p.approval.id), false, "orchestration worker never leaks as single-agent (CST-4)");
  await b.dispose?.();
});
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test tests/core/orchestration/durable-orchestration-wiring.test.js`
Expected: FAIL —— 「recovery ON 双写」用例(orchestration sidecar 未写,orchestrator 未接 orchPersistence);「restart lists」用例(recovery-service 未接 orchPersistence)。

- [ ] **Step 3: 改 index.js**

(a) import 段追加:
```js
import { createOrchestrationPersistence } from "./core/recovery/orchestration-persistence.js";
```

(b) 在 M3 的 `sharedPausedTurnStore` 定义后追加 `orchPersistence`:
```js
  const orchPersistence = recoveryEnabled
    ? createOrchestrationPersistence({ root, projectId, faults: options.recovery?.faults || options.recoveryFaults })
    : null;
```

(c) orchestrator 构造([index.js:230-270](../../../src/index.js#L230-L270))追加注入项(放在 `now: experienceNow` 之后):
```js
    now: experienceNow,
    orchPersistence,
    makeResumedBudget: (s) => createCostBudget({ maxTokens: s.maxTokens, maxModelCalls: s.maxModelCalls, initialTokens: s.initialTokens, initialModelCalls: s.initialModelCalls }),
    env: { root, orchestrationConfig: orch },
    pausedTurnStore: sharedPausedTurnStore || undefined,
    pausedTurnPersistence
```

(d) `kernel.agent.approve`([index.js:404](../../../src/index.js#L404))改为 durable-aware:
```js
      approve: async (id, decision) => {
        if (orchestrator.hasPaused(id)) return orchestrator.resume(id, decision);
        if (recoveryEnabled && await orchestrator.hasDurablePaused(id)) return orchestrator.resumeDurable(id, decision);
        return runtime.approve(id, decision);
      },
```

(e) recovery facade 调用([index.js:384-396](../../../src/index.js#L384-L396))追加两项:
```js
    ? await createRecoveryServiceFacade({
        projectId, projectLock, pausedTurnPersistence, recoveryInbox, runtime,
        sessionManager, eventBus, options, transactionJournal,
        orchPersistence,
        resumeOrchestration: (approvalId, decision) => orchestrator.resumeDurable(approvalId, decision)
      })
```

(f) `createRecoveryServiceFacade`([index.js:473-500](../../../src/index.js#L473-L500))签名 + `createRecoveryService` 调用透传:
```js
async function createRecoveryServiceFacade({
  projectId, projectLock, pausedTurnPersistence, recoveryInbox, runtime,
  sessionManager, eventBus, options, transactionJournal,
  orchPersistence = null, resumeOrchestration = null
}) {
  const recoveryService = createRecoveryService({
    projectId,
    lock: projectLock || { assertOwner: async () => {}, epoch: 0 },
    paused: pausedTurnPersistence,
    pausedTurnStore: { restore: runtime.restorePaused, list: runtime.listPaused },
    inbox: recoveryInbox,
    appendMarker: async (type, data) => { eventBus.publish(type, data); await sessionManager.flush(); },
    resumePaused: async (approvalId, decision) => runtime.approve(approvalId, decision),
    cancelPaused: async (approvalId) => runtime.cancelPaused(approvalId),
    transactionJournal,
    orchPersistence,
    resumeOrchestration
  });
  // ... 其余不变 ...
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test tests/core/orchestration/durable-orchestration-wiring.test.js`
Expected: PASS(3 tests)。

- [ ] **Step 5: 局部回归(kernel 路由 + 单 agent durable + C5)**

Run: `node --test tests/core/orchestration/kernel-routing-e2e.test.js tests/integration/v2-durable-paused-turn.test.js tests/core/orchestration/c5-rounds-e2e.test.js tests/core/orchestration/shared-paused-store.test.js`
Expected: PASS(路由 / 单 agent durable / C5 / 共享 store 全不回归)。

- [ ] **Step 6: 提交**

```bash
git add src/index.js tests/core/orchestration/durable-orchestration-wiring.test.js
git commit -m "$(printf 'feat(orchestration): wire durable orchestration recovery (persistence + resume routing + durable approve) (M7)')"
```

---

## Milestone M8 — 跨实例 e2e + 739 回归 + 文档

**目标:** 真链路跨实例 e2e(kernel A 暂停落盘 → **新 kernel B** 重启扫描 → resume 重水化 approve → 编辑落主区 → 续跑完成);off 零回归;全量 739 回归;收口文档。

### Task M8.1: 跨实例 e2e + off 零回归 e2e

**Files:**
- Test: `tests/core/orchestration/c-durable-e2e.test.js`

- [ ] **Step 1: 写 e2e 测试**

```js
// tests/core/orchestration/c-durable-e2e.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createKernel } from "../../../src/index.js";
import { createOrchestrationPersistence } from "../../../src/core/recovery/orchestration-persistence.js";

function mockGateway(counters) {
  return {
    invoke: async (messages) => {
      const text = (messages || []).map((m) => m.content).join("\n");
      if (text.includes("Break the user's request")) { counters.plan += 1; return { content: JSON.stringify({ task_summary: "t", done_when: "d", subtasks: [
        { id: "st_a", goal: "edit a.js", acceptance: ["a edited"], context_scope: { files: ["a.js"] }, tool_profile: "edit", depends_on: [] }
      ] }), tool_calls: [] }; }
      if (text.includes("revising a multi-agent plan")) return { content: '{"done":true,"subtasks":[]}', tool_calls: [] };
      if (text.includes("INDEPENDENT reviewer")) return { content: '{"pass":true,"severity":"warn","reasons":[],"checked":["read"]}', tool_calls: [] };
      if (text.includes("Synthesize a final answer")) return { content: "final", tool_calls: [] };
      if (text.includes("Sub-task: edit a.js") && !text.includes("Applied change")) return { content: "", tool_calls: [{ id: "t1", name: "diff_apply", arguments: { diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-base a\n+edited a\n" } }] };
      return { content: "done", tool_calls: [] };
    },
    reply: async () => ({ content: "single" }), getUsageStats: () => ({})
  };
}
const exists = async (p) => { try { await fs.stat(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };

test("cross-instance: worker pauses in A, resumes to completion in B (plan once, edit merged, budget persisted)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "c-durable-e2e-"));
  await fs.writeFile(path.join(root, "a.js"), "base a\n");
  const cA = { plan: 0 }, cB = { plan: 0 };

  const a = await createKernel(root, { modelGateway: mockGateway(cA), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "sA", recovery: { enabled: true, lock: false, surface: "cli" } });
  const p = await a.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  assert.equal(cA.plan, 1);

  const store = createOrchestrationPersistence({ root, projectId: "proj" });
  const sidecar = await store.load(p.approval.id);
  assert.ok("quotaTokens" in sidecar.budget && "spentTokens" in sidecar.budget && "spentCalls" in sidecar.budget, "budget quota+spend serialized (edge⑤ shape)");

  await a.dispose?.();   // preserve sidecars, release lock

  const b = await createKernel(root, { modelGateway: mockGateway(cB), sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj", sessionId: "sB", recovery: { enabled: true, lock: false, surface: "cli" } });
  const items = await b.recovery.list();
  assert.ok(items.find((i) => i.type === "orchestration_paused" && i.source_id === p.approval.id), "orchestration_paused registered on restart");

  const resumed = await b.recovery.resume(`rec_orch_${p.approval.id}`, { decision: "approve" });
  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.result.status, "complete");
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "edited a\n");   // edit merged to main
  assert.equal(cB.plan, 0, "no re-plan on durable resume (plan across instances = 1)");

  const after = await store.scan();
  assert.ok(after.every((s) => s.approvalId !== p.approval.id || s.status === "consumed"), "orchestration sidecar consumed");
  await b.dispose?.();
});

test("recovery off: orchestration pause stays in-memory (C5), no durable sidecar, same-process approve completes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "c-durable-off-"));
  await fs.writeFile(path.join(root, "a.js"), "base a\n");
  const counters = { plan: 0 };
  const kernel = await createKernel(root, { modelGateway: mockGateway(counters), eventBus: { publish() {}, subscribe: () => () => {} }, sessionLog: null, branchStore: null, verifyMode: "off", projectId: "proj" });
  const p = await kernel.agent.send("逐一处理 a.js 的输入校验", { autonomy: "supervised" });
  assert.equal(p.status, "awaiting_approval");
  assert.equal(await exists(path.join(root, ".deepseek-code", "v2", "sessions", "proj", "orchestration-paused")), false);
  const done = await kernel.agent.approve(p.approval.id, "approve");   // C5 in-memory resume
  assert.equal(done.status, "complete");
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "edited a\n");
  assert.equal(counters.plan, 1);
  await kernel.dispose?.();
});
```

- [ ] **Step 2: 跑 e2e,确认通过**

Run: `node --test tests/core/orchestration/c-durable-e2e.test.js`
Expected: PASS(2 tests)。若「cross-instance」失败,用 systematic-debugging:先确认 kernel B 的 `recovery.list()` 有 orchestration 项(scan/join 对);再确认共享 store 有被 restore 的 worker 记录(M3/M6 接线对);再确认 rebuilt worker 的 `approve` 命中记录(shared store 引用一致)。

- [ ] **Step 3: 提交**

```bash
git add tests/core/orchestration/c-durable-e2e.test.js
git commit -m "$(printf 'test(orchestration): cross-instance durable orchestration recovery e2e + off parity (M8.1)')"
```

### Task M8.2: 全量回归 + 语法闸

- [ ] **Step 1: 全量测试**

Run: `npm test 2>&1 | tail -25`
Expected: **全绿,失败 0**;通过数 = 739 基线 + 新增(约 40+)。若有回归,`recovery.enabled=false` 是零回归逃生口 —— 对照失败项确认是否误改默认路径。

- [ ] **Step 2: 语法闸**

Run: `npm run check`
Expected: 退出码 0(含 M0/M1 两个新文件)。

- [ ] **Step 3: `git diff --check`(空白/冲突标记)**

Run: `git diff --check`
Expected: 无输出。

> 本任务无独立提交(纯验证);若前序遗漏 check 登记或有空白问题,在此修正并 `git commit -m "chore: ..."`。

### Task M8.3: 文档收口(按 docs 维护顺序)

**Files:**
- Modify: `docs/project-overview.md`(§6 尾 + 新增 §14.5)
- Modify: `docs/CHANGELOG.md`
- Modify: `README.md` / `README.en.md`(若含恢复/编排能力速览)
- Modify: `docs/README.md`(索引:本 spec + 本 plan 链接)
- Modify: `docs/specs/backend/2026-06-27-v3-phase-c-durable-orchestration-recovery-design.md`(状态改「已实施」,加实施 plan 链接)

**Interfaces:** 无代码;纯文档,以当前 `src/` 为准。

- [ ] **Step 1: project-overview §14 增补 §14.5**

在 [§14.4](../../project-overview.md#144-跨任务经验记忆c4默认关) 后追加:
```markdown
### 14.5 跨进程编排级 durable 恢复(C-Durable,默认关)

> 设计见 [C-Durable spec](specs/backend/2026-06-27-v3-phase-c-durable-orchestration-recovery-design.md);实施见 [C-Durable plan](plans/backend/2026-06-27-v3-phase-c-durable-orchestration-recovery.md)。

C5 的同进程编排续跑之上,增加**跨进程**恢复:崩溃/重启后从暂停的编排回合续跑。**gated on `recovery.enabled`(默认关)**——关闭时 C5 同进程续跑逐字节不变、不落编排 sidecar、不注入共享 store。

- **暂停时双写**(同 `approvalId` 关联):worker turn sidecar(既有机制,worker 继承 `pausedTurnPersistence` 自动落 `paused/<id>.json`,含 `resume_state.pending_tool_call` + `__orchestration` 归属标记)+ 编排 sidecar(新 `orchestration-paused/<id>.json`,只存**白名单可序列化**编排状态:plan/round/allCollected/两套 seen/budget 配额+已花/pausedSubtask/remaining;**绝无** raw options/活对象)。
- **重启扫描**:`recovery-service` 新扫 `orchestration-paused/`,与 worker sidecar 交叉过**校验门**(schema+指纹+归属)→ 登记 `orchestration_paused` inbox(resume/cancel)。**孤儿一律 blocked**:orchestration-marked worker sidecar 缺其编排 sidecar(或版本/归属不符)→ `blocked_recovery`,绝不降级单 agent。
- **续跑**:`recovery.resume(rec_orch_<id>)` → 校验门 → 反序列化状态(budget「配额−已花」续扣,绝不重置)→ `worker-factory` 确定性重建 worker → 经**共享 `pausedTurnStore`** 重水化其 turn 的 `approve`(审批落到待执行写工具)→ 结算 → `resumeDispatchLoop` 续本回合 → `driveFrom` 续后续回合,**不重 plan**。
- **`agent-runtime.js` 一行未改**:worker 持久化/重水化全靠既有注入依赖(`pausedTurnPersistence` + 可注入共享 `pausedTurnStore`)。
- 组件:[`src/core/orchestration/orchestration-recovery-contract.js`](../src/core/orchestration/orchestration-recovery-contract.js)(纯契约:serialize/deserialize/validate/fingerprint/ownership 门)· [`src/core/recovery/orchestration-persistence.js`](../src/core/recovery/orchestration-persistence.js)(原子写 + 隔离);接线 `orchestrator`(resumeDurable/serializeState)· `dispatch-loop`(`__orchestration` 标记)· `recovery-service`(扫描 + 孤儿 blocked)· `cost-budget`(续扣种子)· `index.js`(共享 store + 注入 + durable approve 路由)。
```

- [ ] **Step 2: project-overview §6 尾补一句**

在 [§6 持久化恢复](../../project-overview.md#6-持久化恢复)末尾「详见设计文档 …」前补:
```markdown
- **编排级 durable 恢复**(C-Durable,`recovery.enabled` 开启时):编排回合中串行主区 worker 命中审批暂停 → 除 worker turn sidecar 外另落 `orchestration-paused/<approvalId>.json`;重启后 `/recovery` 呈现 `orchestration_paused` 项,resume 精确重水化被暂停的 worker turn 并续编排回合。详见 [§14.5](#145-跨进程编排级-durable-恢复c-durable默认关)。
```

- [ ] **Step 3: CHANGELOG + README(中/英)+ 索引**

- `docs/CHANGELOG.md`:新增一条 `V3 Phase C-Durable — 跨进程编排级 durable 恢复(opt-in,默认关;agent-runtime 未改;5 边界:孤儿 blocked / 不存 raw options / 版本指纹门 / approval 归属校验 / 预算续扣)`。
- `README.md` / `README.en.md`:若有「持久化恢复 / 多智能体」能力速览,补一句「编排级跨进程恢复(opt-in)」中英对照。
- `docs/README.md`:文档索引补本 spec + 本 plan 的链接(backend 区)。
- 本 spec 头部状态 `已评审(…待转实施计划)` → `已实施(见 plan)`,加 plan 链接。

- [ ] **Step 4: 文档一致性自检**

Run: `npm run check && npm test 2>&1 | tail -5`
Expected: 全绿(文档改动不应影响测试;此为收口双保险)。

- [ ] **Step 5: 提交**

```bash
git add docs/
git commit -m "$(printf 'docs: ship V3 Phase C-Durable cross-process orchestration recovery (overview 14.5/6 + CHANGELOG + README zh/en + index)')"
```

---

## 自检清单(实施完成后逐条核对 spec)

**Spec §5 硬约束覆盖:**
1. `agent-runtime.js` 一行不改 → M1–M8 无一处改它(仅注入 `pausedTurnStore`/`pausedTurnPersistence`);M8 Step `git diff` 不含 agent-runtime.js。✅ CST-1
2. opt-in 零回归 → M3/M5/M7 全 gated on `recoveryEnabled`/`orchPersistence`;M3/M7/M8 均有 off-parity 断言;M8.2 全量 739。✅ CST-2
3. 确定性重建 → M4 `worker-factory.worker(pausedSubtask)`;续跑复用 C5(M8 plan-once 断言)。✅ CST-3
4. 安全(暂停=写前门 / deny 失败 / 损坏 blocked)→ M4 deny 路径 + M6 corrupt/gate blocked。✅
5. 幂等清理 → M4/M5 consume;M6 consumed 跳过。✅
6. 崩溃窗口孤儿一律 blocked → M6 两方向 blocked(orphan worker + 缺 worker);写序澄清见 Global Constraints。✅ CST-4
7. 不存 raw options → M0 serialize 白名单;M0 test 断言 `round.options === undefined`。✅ CST-5
8. 版本/指纹门 → M0 `orchestrationResumeGate` + M4/M6 调用;不符→blocked。✅ CST-6
9. approval 归属校验 → M0 `ownershipOk`;M4/M6 门。✅ CST-7
10. 预算续扣 → M2 cost-budget 种子 + M0 `budgetContinuation` + M7 `makeResumedBudget`;M8 sidecar spend 断言。✅ CST-8

**Spec §6 里程碑映射:** M0→M0.1/M0.2 · M1→M1.1 · M2→M2.1/M2.2 · M3→M3.1 · M4→M4.1 · M5→M5.1/M5.2 · M6→M6.1 · M7→M7.1 · M8→M8.1/M8.2/M8.3。全覆盖。

**类型一致性核对:** `orchestrationResumeGate`/`serializeOrchestrationState`/`deserializeOrchestrationState`/`isOrchestrationWorkerSidecar`/`ownershipOk`/`budgetContinuation`(M0 定义)在 M1/M4/M6 的调用签名一致;`resumeDurable`/`hasDurablePaused`/`persistDurablePause`/`consumeWorkerSidecar`(M4 定义)在 M5/M7 的调用一致;`orchestrationMarker`(M5)字段 `{taskId,sessionId,subtaskId}` 与 `ownershipOk` 读取一致;inbox id 前缀 `rec_orch_`/`rec_pause_` 在 M6 scan/resume/cancel 一致。

