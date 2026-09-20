# V3 Phase D-G4 · CLI 对齐(共享事件展示契约 + 多 agent 摘要 + /recovery CLI/TUI 对齐)设计

- 日期:2026-07-12
- 状态:已评审(两问定范围 + 分段设计 + 外部架构评审收紧,用户待批 written spec)
- 前置:支柱①②已收官;支柱③ GUI D-1–D-4、TUI D-5 已收官。本篇是支柱③前端三端中的**最后一块 CLI 线**,落地后 V3 支柱③收官、V3 路线图完结。
- 关联:路线图 `docs/specs/architecture/2026-06-24-v3-roadmap-design.md`(D-G4 定义)· `src/apps/cli/render-events.js`(现 CLI 渲染)· `src/apps/tui/event-cards.js`(TUI 渲染)· `gui/src/state/agent-cards.js`(GUI React 渲染)· 补救文档 `docs/specs/backend/2026-07-12-agent-findings-remediation.md`(同批产出)

---

## 1. 背景与目标

V3 路线图唯一剩余项是 **D-G4:「CLI 对齐:render-events 吃同一契约 · /recovery 走同一 facade · 多 agent 摘要」**(CHANGELOG Unreleased 记为「余 CLI 打磨」)。支柱①②与 GUI/TUI 前端均已收官。

代码现状核对(三处并行的「事件 → 展示」逻辑):

- **CLI** [`src/apps/cli/render-events.js`](../../../src/apps/cli/render-events.js) `summarizeKernelEvent`:覆盖 V2 事件(tool/approval/diff/rollback/verification/rewind/recovery/tx/takeover),**完全没有任何 `orchestration:*` / `experience:*` 分支** —— 复杂任务路由到多 agent 时,CLI 把 `orchestration:planned` / `round_started` / `subtask_started` / `subtask_reviewed` / `replanned` / `completed` / `experience:retrieved` 全部落到兜底,打成裸类型串。**「多 agent 摘要」是真实缺口。**
- **TUI** [`src/apps/tui/event-cards.js`](../../../src/apps/tui/event-cards.js) `eventToLines`:有 `orchestration:*` 前缀兜底与 `route_resolved` 专项,但 subtask 粒度仍走 `orch ▸ <type>` 泛化。
- **GUI React** [`gui/src/state/agent-cards.js`](../../../gui/src/state/agent-cards.js) `deriveAgentCards`:把 planned/round_started/replanned 折成一张 plan 卡。

三处各自防御式读同一批 payload(`event.call?.name || event.tool?.name || event.tool`、`event.change_id || event.record?.id`、`Array.isArray(e.files) ? … : e.summary`),字段口径彼此漂移 —— 这正是 audit 问题 **#5(事件→展示逻辑四份并行实现)**,且已在 D-4 造成真实 bug(`file:diff_applied` 真字段是 `{change_id, summary, files}`,旧 `agent-cards` 读不存在的 `e.path/e.added/e.removed`,diff 卡长期显示空路径 +0 −0)。

**本轮目标(用户已定范围):**

1. 实现 D-G4,完成 V3 支柱③。
2. 「吃同一契约」做成**三端共用的共享事件展示契约**(顺手根治问题 #5 在受支持 ESM 路径上的部分)。
3. agent 审计发现的其余问题**只产出可执行补救计划文档,本轮不改代码**(见 §9 与独立补救文档)。

**非目标:** GUI 的 recovery UI(属独立里程碑 D-G7 Recovery Center);kernel `src/core` / `src/index.js` 任何改动(延续「kernel 零改动」纪律,本篇纯展示层);把休眠 UMD 渲染层 `gui/renderer/` 纳入契约(见 §7 与 §8 的 #5 收口判定)。

---

## 2. 决策记录(含外部评审定案)

1. **范围** = D-G4 三件事(共享契约 + CLI 多 agent 摘要 + /recovery CLI/TUI 对齐);其余 audit 问题只出补救方案文档。
2. **「吃同一契约」= 共享事件展示契约,三端共用**(用户选定)。不是「只补 CLI 不抽共享」。
3. **契约命名** = **共享事件展示契约(display contract)**,明确**不是** core 的事件生产契约(kernel 事件的产出格式仍由 `src/sessions/event-types.js` 等负责,本契约只做「已产出事件 → 展示语义」的单向映射)。
4. **taxonomy 粒度保留,不合并**近义 kind(`recovery-report`/`recovery-blocked`、`rollback`/`rewind`/`tx-recovered` 各自独立),否则分支会重新泄漏回渲染器。
5. **编排类 kind 加统一 `orchestration-` 前缀**,避免将来与普通 `plan`/`route` 语义事件命名冲突。
6. **契约携带 `sourceType`(原始 `event.type`)**,让 `other` 兜底能忠实回退原类型。
7. **`fields` 按 kind 区分(discriminated union),JSDoc 标注**,不是无约束 `{…}`;缺失值统一归一为 `null`,由表现层决定显示 `unknown` 还是本地化文本。
8. **`quiet` 是默认可见性提示,不代表事件被丢弃**;详细/调试模式仍可显示。三端对 `quiet` 语义必须一致(默认降权/不打印,而非一端丢弃一端降权)。
9. **Part C 是 /recovery **CLI/TUI 对齐**,不是「三端齐平」**(GUI 明确不在本轮)。
10. **问题 #5 的收口结论取决于 UMD fallback 可达性**(§7 已核实):`gui/renderer-dist/` 是 **gitignore 的 vite 构建产物**,未构建且无 dev URL 时 `gui/main.js` 会回退到休眠 UMD 渲染层 `gui/renderer/` —— 即 fallback **属于受支持运行路径(未构建态)**。但该休眠层**不消费任何 orchestration 事件**(已 grep 证实),故 D-G4 的多 agent 摘要不触及它。结论采用评审选项(b):**#5 判定为「已在三个受支持 ESM 渲染器(CLI/TUI/GUI-React)上解决」,UMD fallback 保留自有基础事件副本,列为后续项(改为由共享契约生成 或 删除)**,补救文档记为 P2。**不写「完全解决」。**

---

## 3. 架构与文件布局

```
src/apps/
  event-contract.js        ← 新建:唯一语义源 describeEvent(event) → EventDescriptor(纯函数,零依赖)
  cli/render-events.js      ← 改造:summarizeKernelEvent 改为消费 describeEvent;新增编排/经验摘要
  tui/event-cards.js        ← 改造:eventToLines 改为消费 describeEvent(color/i18n 仍在本层)
  tui/tui-i18n.js           ← 补:编排 subtask 相关 ev.* 词条(zh/en 对齐)
gui/src/state/
  agent-cards.js            ← 改造:deriveAgentCards 用 describeEvent 归一后再折卡
```

**分层边界(契约即接口):**

- **语义层** = `event-contract.js`。回答「这个内核事件是什么类别、什么严重度、默认可见吗、归一后有哪些字段」。**所有防御式字段兼容逻辑收敛于此。**
- **表现层** = 三个渲染器。只回答「给定 `descriptor.kind`,本端怎么显示」—— CLI 出英文单行摘要;TUI 出 `theme.color` + `t()` 着色卡片;GUI 出卡片 view-model。**表现层只读 `descriptor.fields.*`,不再直接读 `event.*`。**
- 措辞、颜色、i18n、卡片形状**各端自持**,契约不管这些。

**可独立测试性:** `describeEvent` 是纯函数,输入内核事件对象、输出描述符,node:test 直接覆盖(映射表、别名、缺失字段、畸形输入、未知事件)。三个渲染器各自的旧测试继续钉死本端输出。

---

## 4. 共享事件展示契约(EventDescriptor)

### 4.1 结构

```js
/**
 * @typedef {Object} EventDescriptor
 * @property {EventKind} kind          归一化展示类别(见 4.2)
 * @property {string}    sourceType    原始 event.type,供 other 忠实回退
 * @property {"info"|"success"|"warn"|"danger"} severity  展示严重度
 * @property {boolean}   quiet         默认可见性提示(true=默认降权/不打印,非丢弃)
 * @property {EventFields} fields       按 kind 区分的归一字段(discriminated union,缺失=null)
 */
```

### 4.2 kind → severity → quiet 完整映射表

| 原始 event.type | kind | severity | quiet | fields(缺失归一为 null) |
|---|---|---|---|---|
| `user:message` | `user` | info | ✓ | `{ text }` |
| `tool:call` | `tool-call` | info | | `{ name, argHint }` |
| `tool:result` | `tool-result` | ok→success / 其他→warn | | `{ status }` |
| `permission:decision` | `permission` | info | | `{ decision }` |
| `approval:requested` | `approval` | warn | | `{ id, summary }` |
| `approval:resolved` | `approval-resolved` | info | | `{ decision }` |
| `file:diff_preview` | `diff-preview` | info | | `{ summaryText, diffHash }` |
| `file:diff_applied` | `diff` | success | | `{ changeId, files:[{status,path,added,removed}] }` |
| `file:rollback_applied` | `rollback` | warn | | `{ changeId }` |
| `verification:result` | `verification` | passed→success / 其他→warn | | `{ status, pass }` |
| `repair:*` | `repair` | info | | `{ phase }` |
| `orchestration:routed` | `orchestration-route` | info | | `{ lane }` |
| `orchestration:route_resolved` | `orchestration-route` | info | | `{ lane, score }` |
| `orchestration:planned` | `orchestration-plan` | info | | `{ subtasks, doneWhen }` |
| `orchestration:round_started` | `orchestration-round-start` | info | | `{ round, subtasks }` |
| `orchestration:subtask_started` | `orchestration-subtask-start` | info | | `{ subtaskId, attempt, toolProfile }` |
| `orchestration:subtask_reviewed` | `orchestration-subtask-review` | pass→success / 否→warn | | `{ subtaskId, pass, reviewSeverity }` |
| `orchestration:replanned` | `orchestration-replan` | info | | `{ round, newSubtasks }` |
| `orchestration:completed` | `orchestration-complete` | failed>0→warn / 否→success | | `{ rounds, completed, failed, status }` |
| `experience:retrieved` | `experience-retrieved` | info | retrieved==0 时 ✓ | `{ count, tiers }` |
| `recovery:report` | `recovery-report` | info | | `{ found, done, blocked }` |
| `recovery:blocked` | `recovery-blocked` | warn | | `{ reason, itemId }` |
| `session:rewind_*` | `rewind` | 见注 | | `{ phase, branchId, changeCount, failedChangeId, reason }` |
| `session:branch_created`/`branch_activated` | `branch` | info | | `{ branchId }` |
| `tx:recovered` | `tx-recovered` | info | | `{ kind, txId, preservedCount }` |
| `turn:rehydrated`/`turn:cancelled` | `turn` | info | | `{ approvalId }` |
| `takeover:requested`/`takeover:completed` | `takeover` | info | | `{ requestId }` |
| `model:request`/`model:response`/`agent:step`/`agent:turn_started` | `other` | info | ✓ | `{}` |
| `context:*`(cache/snapshot/pin/warm/unpin) | `context` | info | ✓ | `{}` |
| `agent:final` | `final` | success | ✓* | `{ content }` |
| `agent:error` | `error` | danger | ✓* | `{ message }` |
| 其余 | `other` | info | ✓ | `{}` |

注:
- `rewind` 的 severity 由子类型细分(`rewind_conflict`/`rewind_failed`/`rewind_recovery_failed`→danger,`rewind_restored`/`rewind_applied`→success,其余 info);`fields.phase` 保留原子类型(`preview`/`applied`/`conflict`/`failed`/`restore_started`/`restored`/`recovery_failed`)让表现层区分。
- `final`/`error` 标 `quiet:*`:CLI/TUI 的终态与用户行由 `send()` **结果路径**打印(避免与事件流重复),契约照现状把它们归入默认降权;GUI 走事件流则消费。这一 `*` 差异是**既有各端约定**,契约如实标注、不强行抹平。
- `argHint` 复刻现 TUI `argsHint` 的键序(`path`/`file`/`pattern`/`command`/`query`/`url` 取首个非空)。

### 4.3 归一规则

- **别名兜底集中一处**:`name` = `call?.name || tool?.name || tool`;`changeId` = `change_id || record?.id`;`files` = `Array.isArray(files)&&length ? files : (Array.isArray(summary)?summary:[])`,再逐项归一 `{status:status||"M", path:path||file||null, added:Number.isFinite?…:null, removed:…}`。
- **缺失一律 `null`**(不是 `""`、不是 `0`、不是 `"unknown"`)。表现层决定把 `null` 显示成什么。
- **两处刻意的展示默认(非 "missing→null" 违例,已评审确认)**:①`normFiles` 的 `status` 缺失回退 `"M"`(Modified)——diff 每行必带状态字形,三端原渲染器本就默认 `"M"`,契约沿用以保逐字节一致;②`verification.pass` 是**三态** `true|false|null`:有 `pass` 布尔或状态含 `passed/pass`→`true`,`failed/fail/error`→`false`,**无任何信号→`null`**(未知≠失败)。除这两处外,所有 `fields` 缺失均为 `null`。
- `describeEvent` 对**任意畸形输入(null / 非对象 / 缺 type)**返回 `{kind:"other", sourceType:"", severity:"info", quiet:true, fields:{}}`,绝不抛错。

---

## 5. Part B — CLI 多 agent 摘要(缺失功能)

契约建好后,CLI `summarizeKernelEvent` 改为:`const d = describeEvent(event)`,按 `d.kind` 产单行英文摘要。**新增**当前完全缺失的编排/经验行(措辞按评审收紧):

| kind | CLI 摘要(单复数 / 无空括号 / 无悬空逗号) |
|---|---|
| `orchestration-route` | `routing: multi-agent` |
| `orchestration-plan` | `plan: 1 subtask` / `plan: N subtasks` |
| `orchestration-round-start` | `round N: 1 subtask` / `round N: N subtasks` |
| `orchestration-subtask-start` | `subtask <id>: starting (attempt N)`;有 profile → `subtask <id>: starting (attempt N, profile <p>)` |
| `orchestration-subtask-review` | `subtask <id>: review passed`;有 reviewSeverity → `subtask <id>: review failed (severity: <level>)` |
| `orchestration-replan` | `replan round N: 1 new subtask` / `replan round N: N new subtasks` |
| `orchestration-complete` | `orchestration complete: N succeeded, N failed (status: <status>)` |
| `experience-retrieved` | `experience: N recalled`(仅 `count > 0` 打印) |

**硬性文案规则(测试钉死):**
- 单复数:`1 subtask` vs `N subtasks`、`1 new subtask` vs `N new subtasks`。
- `profile` / `severity` 缺失时**不留空括号、不留悬空逗号**(动态拼接,非模板占位)。
- review 结果**必须** `passed` / `failed` 二选一,不得输出字面 `pass`/`fail`/布尔。
- 字段名 `reviewSeverity`(契约内),与描述符顶层 `severity` 区分。

现 CLI 已覆盖的 V2 事件摘要**逐字不变**(由现有 6 条测试钉死)。

---

## 6. Part C — /recovery CLI/TUI 对齐

**现状:** CLI [`kernel-runner.js`](../../../src/apps/cli/kernel-runner.js) `handleRecoveryCommand` 已走完整 facade:无参→report+list+next;`resume <id>` / `cancel <id>` / `clear <id>`。是三端最全的。TUI [`slash.js`](../../../src/apps/tui/slash.js) `/recovery` 缺 `clear`。

**本轮:** 给 TUI `/recovery` 补 `clear <id>`,与 CLI 平齐。

**`clear` 破坏性核实(已读代码):** [`recovery-inbox.js:112-124`](../../../src/core/recovery/recovery-inbox.js) `clear(id)` 把 item 软标记为 `status:"cleared"`,且**显式拒绝 blocked 项**(`"cannot clear blocked recovery item"`),对不可清项抛错。属账务状态迁移、非数据删除。CLI 现无二次确认。**故 TUI 亦无二次确认**(与 CLI 同策略),不引入 GUI 式确认弹层。

**验收(评审要求,超出「调同一 facade」):**
- `/help` 与补全菜单中 `/recovery` 用法串包含 `clear`。
- 参数校验:`clear` 无 id → 打印 `usage: /recovery clear <id>`,不调 facade。
- 成功路径:`clear <id>` 调 `kernel.recovery.clear` 并渲染 `(cleared)` 结果。
- 失败路径:facade 抛错(如 blocked 项)→ 渲染 `Failed to clear <id>: <msg>`,不崩。
- zh/en 两语提示词条齐备。

---

## 7. 安全与边界

- **kernel `src/` 零改动**:本篇纯 `src/apps/` 与 `gui/src/` 展示层;不碰 `src/core`、`src/index.js`、事件生产。
- **契约不产生副作用、不 I/O、不抛错**:纯映射函数。
- **UMD fallback 边界(已核实):** `gui/renderer-dist/` 是 gitignore 的 vite 构建产物(`gui/package.json` `build:renderer`)。`gui/main.js:107-117` 加载序:dev URL → `renderer-dist/index.html` → 休眠 `gui/renderer/index.html`。**未构建 + 无 dev URL 时 fallback 可达(属受支持的未构建态)。** 但休眠层 `gui/renderer/{app.js,event-adapter.js}` **不消费任何 orchestration 事件**(grep `orchestr|worker|subtask|route|experience` 为空),故本轮新增摘要不触及它。**本轮不改休眠层**,其 `summarizeEvent`/`eventIcon` 保留自有基础事件副本 —— 这是问题 #5 的**残留第 4 份副本**,补救文档记 P2(改为由共享契约生成 或 随 renderer-dist 常态化后删除)。

---

## 8. 测试策略

- **新增** `tests/unit/apps/event-contract.test.js`:映射表逐 kind、别名兜底(diff 的 files/summary 双形态、tool name 三来源、changeId 双来源)、缺失字段归一为 null、畸形输入(null/非对象/缺 type)不抛错、未知事件回退 `other` 且 `sourceType` 保真、`quiet` 语义。
- **三端渲染器旧测试不删、不放宽**:CLI 6 + TUI 6 + GUI 4 = 16 条现有用例**原样全绿**,证明**已覆盖的 V2 事件**逐端输出字节不变。
- **Part B 是有意改变编排事件输出** —— 为其新增 CLI 编排摘要断言(单复数、无空括号、passed/failed、experience 零不打印)。**不对编排事件宣称「行为零变化」**(它们此前是裸类型串,本就要改)。
- **Part C**:TUI `/recovery clear` 的 help/补全/参数校验/成功/失败/双语用例(§6)。
- **全量** `npm test` 与 `npm run check` 通过。**验收条件不写具体数字(如 912→930+)**,而是:*现有测试不删除不放宽;新增契约映射/别名/畸形/未知事件/三端适配/CLI 编排摘要/TUI clear 测试;全量测试与 check 通过*。

---

## 9. audit 问题补救计划(独立文档,本轮不实现)

同批产出 [`docs/specs/backend/2026-07-12-agent-findings-remediation.md`](../backend/2026-07-12-agent-findings-remediation.md),10 项按 Tier/优先级组织,每项:**根因(非症状)· 具体改法 · 影响文件 · 风险 · 验证方式 · 优先级 · 「本轮不实现」标记**。要点:

- **#5(四份并行渲染实现)**:标「已在三个受支持 ESM 渲染器上随 D-G4 解决;UMD fallback 残留副本 → P2」(§2.10 结论)。
- **第 10 项(`agent-runtime.js` 可维护性)**:必须入档补齐审计链,Tier 2 / P2。**根因不写「文件 1150 行」**(行数是症状),写为:**职责混合(普通工具/主验证器/修复期工具/修复期验证器四条恢复分支近似重复)、依赖集中、测试边界不足**。分阶段方案:① 补行为刻画测试(approve 四分支、事件顺序、错误语义)→ ② 绘职责/依赖边界 → ③ 优先抽纯函数与策略模块 → ④ 再拆状态管理/编排/适配层。**约束:公开 API、事件顺序、错误语义不变。验收不看行数下降,看边界清晰度与测试可独立性。**

---

## 10. 硬约束(Global Constraints)

1. **kernel `src/core` / `src/index.js` diff 为空**(纯展示层)。
2. **契约是纯函数**:无 I/O、无副作用、任意输入不抛错。
3. **现有 16 条渲染测试原样全绿**(V2 事件逐端字节不变);编排事件输出有意改变,单列测试。
4. **零新增运行时依赖**(延续主包方针;契约是手写纯 JS)。
5. **措辞/颜色/i18n 各端自持**;契约只出 `kind`/`severity`/`quiet`/`fields`,不含任何展示字符串。
6. **`fields` 缺失一律 `null`**;表现层负责 `null → 显示文本`。
7. **问题 #5 不标「完全解决」**,除非/直到 UMD fallback 被证明不属受支持运行路径或被改造为契约产物。
