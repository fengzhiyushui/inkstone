// src/sessions/event-schemas.js — 已登记事件类型 ↔ 载荷 schema 注册表(M1 契约冻结)。
// 与 src/sessions/event-types.js(登记表)、src/apps/event-contract.js(展示契约)共同构成
// 「已登记事件类型 ↔ 载荷 schema ↔ 展示处理」三角不变量:新事件漏登记 schema 或漏登记展示
// 分支,都会由 tests/unit/sessions/event-schema-coverage.test.js 变红,不再静默降级。
//
// 判定规则(每一类都对照全仓 publish 站点逐一核对得出,注释标明依据):
//   1. required 只收「生产者恒定发射」的键;条件发射(如 ...(branch_id ? { branch_id } : {}))
//      一律降级为 optional;nullable 的常量键标 "any"(具体标量类型会误报 null)。
//   2. optional 收录「已知但非恒定」的键 + E2 新字段(model:response 的
//      reasoning / tps / session_id / latency_ms,字段名以本文件为冻结规格)。
//   3. 当前无 src 生产者的规格事件(tx:opened / tx:committed / tx:recovered /
//      takeover:requested / takeover:completed,见 v2.18 耐久恢复设计文档):无恒定发射
//      证据 → required 为空,optional 仅登记文档/展示层已消费的键。
//   4. 额外未知键一律放行(前向兼容):validateEvent 不因未知键报错,只校验已登记键。
//
// 零第三方依赖:仅手写校验器 + 同包内 ./event-types.js 登记表(非外部依赖)。

import { isSessionEventType } from "./event-types.js";

function entry(required = [], optional = []) {
  const pairs = (list) => list.map(([key, type]) => Object.freeze([key, type]));
  return deepFreeze({
    required: Object.freeze(pairs(required)),
    optional: Object.freeze(pairs(optional))
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export const SESSION_EVENT_SCHEMAS = deepFreeze({
  // 生产者:src/sessions/event-log.js:35 append("session:start", meta)。meta 由调用方注入
  //(index.js:99 传 { root, runtime: "v2" }),不同接入路径形状不一 → 无必填,仅登记已知键。
  "session:start": entry([], [["root", "string"], ["runtime", "string"]]),

  // 生产者:index.js:359 { session_id: id, root }。两键恒定。
  "session:resume": entry([["session_id", "string"], ["root", "string"]]),

  // 生产者:rewind-service.js:244-250。五键恒定;parent_branch_id / forked_from_event_id /
  // forked_from_turn_id 对 main 分支为 null → "any"。
  "session:branch_created": entry([
    ["branch_id", "string"],
    ["parent_branch_id", "any"],
    ["forked_from_event_id", "any"],
    ["forked_from_seq", "number"],
    ["forked_from_turn_id", "any"]
  ]),

  // 生产者:index.js:318-321 与 rewind-service.js:266-269,形状一致;parent_branch_id 可空。
  "session:branch_activated": entry([["branch_id", "string"], ["parent_branch_id", "any"]]),

  // 生产者:rewind-service.js:48 safeRewindPayload() 七键恒定。
  "session:rewind_preview": entry([
    ["target", "object"],
    ["current_branch_id", "string"],
    ["planned_branch_id", "string"],
    ["rollback_change_ids", "array"],
    ["rollback_count", "number"],
    ["files", "array"],
    ["force_required", "boolean"]
  ]),

  // 生产者:rewind-service.js:166-171。四键恒定。
  "session:rewind_started": entry([
    ["current_branch_id", "string"],
    ["target", "object"],
    ["rollback_change_ids", "array"],
    ["forced", "boolean"]
  ]),

  // 生产者:rewind-service.js:293-303。八键恒定。
  "session:rewind_applied": entry([
    ["status", "string"],
    ["previous_branch_id", "string"],
    ["branch_id", "string"],
    ["target", "object"],
    ["rollback_change_ids", "array"],
    ["applied_rollbacks", "array"],
    ["files", "array"],
    ["forced", "boolean"]
  ]),

  // 生产者:rewind-service.js:111(无 remaining 时)与 128(restored 形状)。两形状共同恒定键:
  // status/current_branch_id/attempted_branch_id/failed_change_id/applied_rollbacks/conflicts/forced;
  // remaining_change_ids 仅前者发射,phase/reason/restored_files 仅后者 → optional。
  "session:rewind_conflict": entry(
    [
      ["status", "string"],
      ["current_branch_id", "string"],
      ["attempted_branch_id", "string"],
      ["failed_change_id", "any"],
      ["applied_rollbacks", "array"],
      ["conflicts", "array"],
      ["forced", "boolean"]
    ],
    [["remaining_change_ids", "array"], ["phase", "string"], ["reason", "string"], ["restored_files", "array"]]
  ),

  // 生产者:rewind-service.js:77 与 87。八键共同恒定;restore_error 仅 failed_unrestorable 形状发射。
  "session:rewind_failed": entry(
    [
      ["status", "string"],
      ["current_branch_id", "string"],
      ["attempted_branch_id", "string"],
      ["phase", "string"],
      ["applied_rollbacks", "array"],
      ["forced", "boolean"],
      ["reason", "string"],
      ["restored_files", "array"]
    ],
    [["restore_error", "string"]]
  ),

  // 生产者:rewind-service.js:60-68(base)。六键恒定。
  "session:rewind_restore_started": entry([
    ["current_branch_id", "string"],
    ["attempted_branch_id", "string"],
    ["phase", "string"],
    ["applied_rollbacks", "array"],
    ["forced", "boolean"],
    ["reason", "string"]
  ]),

  // 生产者:rewind-service.js:71-77。八键恒定。
  "session:rewind_restored": entry([
    ["status", "string"],
    ["current_branch_id", "string"],
    ["attempted_branch_id", "string"],
    ["phase", "string"],
    ["applied_rollbacks", "array"],
    ["forced", "boolean"],
    ["reason", "string"],
    ["restored_files", "array"]
  ]),

  // 生产者:rewind-service.js:80-86。九键恒定。
  "session:rewind_recovery_failed": entry([
    ["status", "string"],
    ["current_branch_id", "string"],
    ["attempted_branch_id", "string"],
    ["phase", "string"],
    ["applied_rollbacks", "array"],
    ["forced", "boolean"],
    ["reason", "string"],
    ["restored_files", "array"],
    ["restore_error", "string"]
  ]),

  // 生产者:recovery-service.js:21。三键恒定。
  "recovery:started": entry([
    ["recovery_id", "string"],
    ["project_id", "string"],
    ["lock_epoch", "number"]
  ]),

  // 生产者:recovery-service.js:32/101/147 与 agent-runtime.js:941,四站形状一致,三键恒定。
  "recovery:blocked": entry([
    ["item_id", "string"],
    ["source_id", "string"],
    ["reason", "string"]
  ]),

  // 生产者:recovery-service.js:151-157。五键恒定。
  "recovery:report": entry([
    ["recovery_id", "string"],
    ["found_count", "number"],
    ["done_count", "number"],
    ["blocked_count", "number"],
    ["next_actions", "array"]
  ]),

  // 规格事件(v2.18 设计文档「追加 flush tx:opened」),当前无 src 生产者 → 无必填;
  // optional 登记日志 journal 已承载的键。
  "tx:opened": entry([], [["tx_id", "string"], ["kind", "string"], ["session_id", "string"], ["turn_id", "string"]]),

  // 规格事件(v2.18 设计文档「提交点 flush tx:committed」),当前无 src 生产者 → 无必填。
  "tx:committed": entry([], [["tx_id", "string"], ["commit_id", "string"], ["change_id", "string"], ["kind", "string"]]),

  // 规格事件;展示契约(event-contract.js:136)与 CLI 消费 kind/tx_id/preserved_count,
  // 当前无 src 生产者 → 无必填。
  "tx:recovered": entry([], [["kind", "string"], ["tx_id", "string"], ["preserved_count", "number"]]),

  // 生产者:agent-runtime.js:973-978。record 恒带 approval_id/turn_id/session_id(回落 sessionId)
  // 与 surface(恢复面标记,默认 "cli")→ 四键恒定。
  "turn:paused": entry([
    ["approval_id", "string"],
    ["turn_id", "string"],
    ["original_session_id", "string"],
    ["surface", "string"]
  ]),

  // 生产者:recovery-service.js:112 与 136,两站形状一致,四键恒定。
  "turn:rehydrated": entry([
    ["approval_id", "string"],
    ["turn_id", "string"],
    ["original_session_id", "string"],
    ["marker_status", "string"]
  ]),

  // 生产者:agent-runtime.js:964-968。三键恒定。
  "turn:resumed": entry([
    ["approval_id", "string"],
    ["turn_id", "string"],
    ["original_session_id", "string"]
  ]),

  // 生产者:agent-runtime.js:297-302 与 529-534,两站形状一致,四键恒定。
  "turn:cancelled": entry([
    ["approval_id", "string"],
    ["turn_id", "string"],
    ["original_session_id", "string"],
    ["reason", "string"]
  ]),

  // 规格事件(v2.18 单写者接管设计),当前无 src 生产者 → 无必填;展示层消费 request_id。
  "takeover:requested": entry([], [["request_id", "string"]]),

  // 规格事件(v2.18 单写者接管设计),当前无 src 生产者 → 无必填;展示层消费 request_id。
  "takeover:completed": entry([], [["request_id", "string"]]),

  // 生产者:agent-runtime.js:73。三键恒定(options 为发送选项对象)。
  "user:message": entry([
    ["turn_id", "string"],
    ["content", "string"],
    ["options", "object"]
  ]),

  // 生产者:agent-runtime.js:74。turn 为 agent-turn 协议对象,恒定。
  "agent:turn_started": entry([["turn", "object"]]),

  // 生产者:agent-runtime.js:82。三键恒定。
  "agent:step": entry([
    ["turn_id", "string"],
    ["step", "object"],
    ["classification", "object"]
  ]),

  // 生产者:executor-loop.js:45/287 与 repair-executor.js:28,三站一致,三键恒定。
  "model:request": entry([
    ["turn_id", "string"],
    ["purpose", "string"],
    ["iteration", "number"]
  ]),

  // 生产者:executor-loop.js:55-66/297-306 与 repair-executor.js:39-48,三站一致。
  // required 收三站恒定发射的标量键。usage 恒发射但可为 null(modelResult.usage || null)、
  // model/channel 依赖网关回包 → optional "any"/"string"。E2 冻结新字段(均 optional):
  // reasoning / tps / session_id / latency_ms——生产点改造中以本文件字段名为准。
  "model:response": entry(
    [
      ["turn_id", "string"],
      ["purpose", "string"],
      ["iteration", "number"],
      ["content", "string"],
      ["tool_call_count", "number"]
    ],
    [
      ["usage", "any"],
      ["model", "string"],
      ["channel", "string"],
      ["reasoning", "string"],
      ["tps", "number"],
      ["session_id", "string"],
      ["latency_ms", "number"]
    ]
  ),

  // 生产者:tools/executor.js:42。call 为 secured tool-call,tool 为公开工具定义,恒定。
  "tool:call": entry([["call", "object"], ["tool", "object"]]),

  // 生产者:tools/executor.js:104。result 为 tool-result 协议对象,恒定。
  "tool:result": entry([["result", "object"]]),

  // 生产者:tools/executor.js:45。四键恒定;category 由 registry.secureToolCall 产出,
  // 内置工具全部返回字符串分类(read/execute/write_update/destructive/...)。
  "permission:decision": entry([
    ["call_id", "string"],
    ["tool", "string"],
    ["category", "string"],
    ["permission", "object"]
  ]),

  // 生产者:tools/executor.js:65。approval 为协议对象、call 为 secured tool-call,恒定。
  "approval:requested": entry([["approval", "object"], ["call", "object"]]),

  // 生产者:agent-runtime.js:291。两键恒定。
  "approval:resolved": entry([["approval_id", "string"], ["decision", "string"]]),

  // 生产者:context/index.js:52-60 与 90-98,两站形状一致,七键恒定。
  "context:snapshot": entry([
    ["snapshot_id", "string"],
    ["channel", "string"],
    ["task_type", "string"],
    ["unit_count", "number"],
    ["unit_paths", "array"],
    ["budget", "object"],
    ["stats", "object"]
  ]),

  // 生产者:context/index.js:105 / 111 / 117。path 恒定;warm 另恒发 reason(默认 "warm")。
  "context:pin": entry([["path", "string"]]),
  "context:unpin": entry([["path", "string"]]),
  "context:warm": entry([["path", "string"], ["reason", "string"]]),

  // 生产者:context-cache.js:50。仅持久化模式发射,files 为清单条目计数,恒定。
  "context:cache_loaded": entry([["files", "number"]]),

  // 生产者:context-cache.js:108-114 与 116-121,两站形状一致,五个计数恒定。
  "context:cache_saved": entry([
    ["files", "number"],
    ["reused_files", "number"],
    ["changed_files", "number"],
    ["skipped_files", "number"],
    ["duration_ms", "number"]
  ]),
  "context:cache_reused": entry([
    ["files", "number"],
    ["reused_files", "number"],
    ["changed_files", "number"],
    ["skipped_files", "number"],
    ["duration_ms", "number"]
  ]),

  // 生产者:semantic-engine.js:66。reason 为降级原因(截断后字符串),恒定。
  "context:semantic_degraded": entry([["reason", "string"]]),

  // 生产者:edit-service.js:38-43。summary 为 diff 汇总数组、files 为路径数组,四键恒定。
  "file:diff_preview": entry([
    ["summary", "array"],
    ["files", "array"],
    ["diff_hash", "string"],
    ["diff_size", "number"]
  ]),

  // 生产者:edit-service.js:163-170。六键恒定;approval_id 默认 null → "any"。
  "file:diff_applied": entry([
    ["change_id", "string"],
    ["approval_id", "any"],
    ["summary", "array"],
    ["files", "array"],
    ["diff_hash", "string"],
    ["diff_size", "number"]
  ]),

  // 生产者:edit-service.js:209-216。五键恒定;branch_id 条件发射 → optional。
  "file:rollback_applied": entry(
    [
      ["change_id", "string"],
      ["summary", "array"],
      ["files", "array"],
      ["forced", "boolean"],
      ["conflicts", "array"]
    ],
    [["branch_id", "string"]]
  ),

  // 生产者:edit-service.js:75-81。五键恒定。
  "file:transaction_started": entry([
    ["transaction_id", "string"],
    ["files", "array"],
    ["summary", "array"],
    ["diff_hash", "string"],
    ["diff_size", "number"]
  ]),

  // 生产者:edit-service.js:152-159。六键恒定(transaction.transaction_id 与开启时一致)。
  "file:transaction_committed": entry([
    ["transaction_id", "string"],
    ["change_id", "string"],
    ["summary", "array"],
    ["files", "array"],
    ["diff_hash", "string"],
    ["diff_size", "number"]
  ]),

  // 生产者:edit-service.js:94-100/113-119/131-137,三站形状一致;transaction_id 为
  // error.transaction_id || null → "any",其余四键恒定。
  "file:transaction_failed": entry([
    ["transaction_id", "any"],
    ["files", "array"],
    ["restored_files", "array"],
    ["restored", "boolean"],
    ["message", "string"]
  ]),

  // 生产者:edit-service.js:201-208。五键恒定;branch_id 条件发射 → optional。
  "file:transaction_rolled_back": entry(
    [
      ["change_id", "string"],
      ["files", "array"],
      ["restored_files", "array"],
      ["forced", "boolean"],
      ["conflicts", "array"]
    ],
    [["branch_id", "string"]]
  ),

  // 生产者:edit-service.js:183-189。四键恒定;branch_id 条件发射 → optional。
  "file:rollback_conflict": entry(
    [
      ["change_id", "string"],
      ["files", "array"],
      ["conflicts", "array"],
      ["force_available", "boolean"]
    ],
    [["branch_id", "string"]]
  ),

  // 生产者:verifier.js:20/30/42,三站形状一致,两键恒定(result 为 verification 对象)。
  "verification:result": entry([["turn_id", "string"], ["result", "object"]]),

  // 生产者:repair-loop.js:35。turn_id/max_attempts 恒定;verification_status 为
  // verification?.status,初始校验可能缺省 → optional。
  "repair:started": entry(
    [["turn_id", "string"], ["max_attempts", "number"]],
    [["verification_status", "string"]]
  ),

  // 生产者:repair-loop.js:58。同 started 的可空性判定。
  "repair:attempt": entry(
    [["turn_id", "string"], ["attempt", "number"]],
    [["verification_status", "string"]]
  ),

  // 生产者:repair-loop.js:150-158。五键恒定(循环内 verification 已保证非空)。
  "repair:result": entry([
    ["turn_id", "string"],
    ["attempt", "number"],
    ["status", "string"],
    ["verification_status", "string"],
    ["tool_result_count", "number"]
  ]),

  // 生产者:repair-loop.js:171。turn_id/attempts 恒定;verification_status 可空 → optional。
  "repair:exhausted": entry(
    [["turn_id", "string"], ["attempts", "number"]],
    [["verification_status", "string"]]
  ),

  // 生产者:orchestrator.js:32。subtasks 为计划数量;done_when 经 subtask-schema 校验为非空串。
  "orchestration:planned": entry([["subtasks", "number"], ["done_when", "string"]]),

  // 生产者:orchestrator.js:65。两键恒定。
  "orchestration:round_started": entry([["round", "number"], ["subtasks", "number"]]),

  // 生产者:orchestrator.js:102。三键恒定(done 恒为 false)。
  "orchestration:replanned": entry([["round", "number"], ["done", "boolean"], ["new_subtasks", "number"]]),

  // 生产者:dispatch-loop.js:81。tool_profile 经 validateSubTask 限定 edit/readonly,三键恒定。
  "orchestration:subtask_started": entry([
    ["subtask_id", "string"],
    ["attempt", "number"],
    ["tool_profile", "string"]
  ]),

  // 生产者:dispatch-loop.js:90。severity 经 validateVerdict 限定 block/warn,三键恒定。
  "orchestration:subtask_reviewed": entry([
    ["subtask_id", "string"],
    ["pass", "boolean"],
    ["severity", "string"]
  ]),

  // 生产者:orchestrator.js:110。四键恒定(status 来自 classifyOutcome)。
  "orchestration:completed": entry([
    ["rounds", "number"],
    ["completed", "number"],
    ["failed", "number"],
    ["status", "string"]
  ]),

  // 生产者:index.js:303。decision(task-router decide() 产出)恒带 lane/reason/signals;
  // score/band 同源但不进事件 → optional。
  "orchestration:routed": entry(
    [["lane", "string"], ["reason", "string"], ["signals", "array"]],
    [["score", "number"], ["band", "string"]]
  ),

  // 生产者:agent-runtime.js 各 agent:final 站点(stopped/complete/cancelled),三键恒定。
  "agent:final": entry([["turn_id", "string"], ["content", "string"], ["status", "string"]]),

  // 生产者:agent-runtime.js:144 与 501,两站形状一致,两键恒定。
  "agent:error": entry([["turn_id", "string"], ["message", "string"]]),

  // ── 跨任务经验记忆(C4)事件族:v1.9.0 M1 登记闭环 ──
  // 四类此前有生产者却未登记(schema/回放守卫发现),逐类对照 publish 站点补 required。
  // 生产者:orchestrator.js:28(learningOn 时)。count 恒定;tiers/riskCueCount 随检索结果。
  "experience:retrieved": entry(
    [["count", "number"]],
    [["tiers", "array"], ["riskCueCount", "number"]]
  ),

  // 生产者:orchestrator.js:123(后台巩固完成回执)。两键恒定。
  "experience:consolidated": entry([["taskId", "string"], ["written", "number"]]),

  // 生产者:experience-consolidator.js:43 onPending({ pendingId, kind })。两键恒定。
  "experience:pending_approval": entry([["pendingId", "string"], ["kind", "string"]]),

  // 生产者:index.js:453 experience.resolvePending。decision 由调用方(CLI/TUI/GUI 审批面)
  // 传入,取值集不在内核定义 → "any"(不在 schema 猜枚举)。
  "experience:pending_resolved": entry([["pendingId", "string"], ["decision", "any"]])
});

function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value, typeName) {
  switch (typeName) {
    case "any":
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      // 未识别的类型名不阻断(注册表自身由覆盖守卫测试锁定形状)。
      return true;
  }
}

/**
 * 校验单个事件载荷。永不抛错:未知类型、非对象载荷、缺必填、类型不符全部收集进 errors。
 * 额外未知键放行(前向兼容);optional 键缺失不报错,存在但类型不符仍报错。
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateEvent(type, payload) {
  const errors = [];
  if (!isSessionEventType(type)) {
    errors.push(`unknown session event type: ${String(type)}`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    errors.push(`payload must be a plain object, got ${describeValue(payload)}`);
    return { ok: false, errors };
  }
  const schema = SESSION_EVENT_SCHEMAS[type];
  if (!schema) {
    // 未知类型已在上面记录,无需按 schema 继续校验。
    return { ok: false, errors };
  }
  for (const [key, typeName] of schema.required) {
    const value = payload[key];
    if (value === undefined) {
      errors.push(`missing required key "${key}" (expected ${typeName})`);
      continue;
    }
    if (!matchesType(value, typeName)) {
      errors.push(`type mismatch for required key "${key}": expected ${typeName}, got ${describeValue(value)}`);
    }
  }
  for (const [key, typeName] of schema.optional) {
    const value = payload[key];
    if (value === undefined) continue;
    if (!matchesType(value, typeName)) {
      errors.push(`type mismatch for optional key "${key}": expected ${typeName}, got ${describeValue(value)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
