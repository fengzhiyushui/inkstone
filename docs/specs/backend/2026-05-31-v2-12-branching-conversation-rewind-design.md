# V2-12 分支对话 Rewind 设计

- 类型：后端 spec
- 日期：2026-05-31
- 状态：已实现
- 关联：[V2-11 事务编辑](2026-05-31-v2-11-transactional-edit-dirty-workspace-design.md) · [V2-13 rewind 加固](2026-05-31-v2-13-rewind-hardening-recovery-design.md)

---

## 问题与目标

选中更早时间线节点不能只回滚文件，还要开出新对话分支、把工作区恢复到该节点，后续 turn 在新分支继续，旧分支仍可查看。V2-12 采用分支/fork 模型，不做破坏性时间线删除。

## 决策

| 决策点 | 选择 | 否决项 | 理由 |
|---|---|---|---|
| 模型 | 分支 + 激活分支 | 改写/截断 JSONL | 审计链不破，旧线可查 |
| 文件恢复 | 复用 V2-11 rollback 逆序 | 直接写盘 | 冲突检测与 force 语义已就绪 |
| 检查点 | 从事件日志推导 | 另存权威副本 | 单一事实来源 |
| 冲突 | 默认拒绝 + 部分进度如实报告 | 假装已切换分支 | 不制造“已回退”错觉 |
| 交付 | 分阶段（分支库→索引→apply→界面钩子） | 一次大爆炸 | 数据模型仍是 branch-first |

## 设计

### 模块

```
src/sessions/
  branch-store.js       # 分支元数据与激活分支
  checkpoint-index.js   # buildCheckpointIndex / resolveRewindTarget / computeRollbackPlan
  rewind-service.js     # preview / apply / rollback 编排
  session-manager.js    # 事件盖 branch_id
```

### 分支模型

`BR_MAIN = "br_main"`，`BRANCH_SCHEMA_VERSION = 1`，分支 id 形如 `br_[a-zA-Z0-9._-]+`。记录含 `branch_id`、`parent_branch_id`、`forked_from_event_id`、`forked_from_seq`、`forked_from_turn_id`、`created_at`、`label`。无分支文件的旧会话惰性建 `br_main`，缺 `branch_id` 的事件视作主分支。

运行时事件盖当前 `branch_id`；分支控制事件可同时带 `parent_branch_id`。

### 检查点

从时间线推导：`checkpoint_id`、`branch_id`、`event_id`、`seq`、`turn_id`、`type`、`label`、`change_ids`、`cumulative_change_ids`。支持按 event_id / seq / turn_id 定位，并计算目标之后要回滚的 change 列表。

### Rewind

**preview**（只读）：解析目标、给出 `planned_branch_id`、`rollback_change_ids`、`files`、`force_required`，发 `session:rewind_preview`。不写文件、不切分支。

**apply**：冲刷事件 → 解析检查点 → 逆序 `editService.rollback({ change_id, force })` → 任一冲突则停、发 `session:rewind_conflict` 并如实报告已回滚/剩余 change → 全部成功则 `createBranch` + `activateBranch` → 发 `session:rewind_started`、`branch_created`、`branch_activated`、`rewind_applied`。之后的新 turn 落入子分支。

**force**：向每笔 rollback 传 `force: true`，事件记 `forced` 与冲突元数据；仍不绕过路径安全。

### 查询与 API

`kernel.session.getTimeline(50)` 保持兼容（默认活跃分支）。可选 `{ count, branch_id }` 返回该分支及祖先继承事件；`{ all_branches: true }` 返回全部。

```js
kernel.session.branches.list/getActive/activate
kernel.session.checkpoints.list
kernel.session.rewind.preview/apply
```

`activate()` 只改元数据，不写文件。

## 边界与不变量

1. 事件日志 append-only，hash 链保持有效。
2. Rewind 只经 V2-11 rollback 写文件。
3. 冲突默认停；部分回滚必须明说。
4. 事件与分支元数据不含 raw diff / 文件内容 / reasoning。
5. 测试不在仓库根制造 `.deepseek-code/v2`。

## 与现状的差异

加固与故障注入见 [V2-13](2026-05-31-v2-13-rewind-hardening-recovery-design.md)。存储路径与 `session:rewind_*` 事件名以 `event-types.js`、`rewind-service.js` 为准。GUI 分支树属后续前端里程碑。

## 验收

分支元数据持久；新事件带 branch_id；旧会话可读；preview 列出将回滚 change；apply 逆序回滚并建子分支；后续 turn 落子分支；脏冲突停且活跃分支不变；force 显式；旧事件仍可查。入口 `npm test`、`npm run check`。
