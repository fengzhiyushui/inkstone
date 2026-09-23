# agent 审计发现补救台账

- 类型：后端 spec
- 日期：2026-07-12（状态更新 2026-09-15）
- 状态：基本清零（#1–#5 v1.1.0；#6/#7 env/#9 易项 v1.2.0；#7 命令分类 v1.3.1；#8/#9.6 v1.3.2；#9.3 v1.6.2 后端 + v1.7.0 前端；#10 阶段 1–2 v1.6.3，阶段 3–4 延后大版本）
- 关联：[v1.2.0](2026-07-17-v1.2.0-agent-findings-p2-design.md) · [v1.3.0](2026-07-26-v1.3.0-agent-findings-p3-design.md) · [agent-runtime 边界](2026-08-09-v1.6.3-agent-runtime-refactor-design.md) · [D-G4](../frontend/2026-07-12-v3-phase-dg4-cli-alignment-design.md)

---

## 问题与目标

六个并行只读审计覆盖 docs / kernel / context / model+tools+security / frontends / sessions+edits。本文把发现收成可立项台账：根因、改法、风险、验证、优先级。本轮只登记不实现，实施走各自 spec/plan。

## 处置总表

| # | 问题 | 处置 |
|---|---|---|
| 1 | 分类器只认英文，中文落 general | ✅ v1.1.0：`planning/keywords.js` 中英共表 |
| 2 | GUI `buildKernelOptions` 分叉丢编排/语义配置 | ✅ v1.1.0：动态 import 共享实现 |
| 3 | TUI/CLI 无法中断回合 | ✅ v1.1.0：TUI Esc / CLI SIGINT → `interrupt` |
| 4 | SSRF DNS rebinding + 黑名单缺口 | ✅ v1.1.0：全 A 记录校验 + IP pin + 补保留网段 |
| 5 | 脱敏正则过窄 | ✅ v1.1.0：确定性规则表（token/私钥块） |
| 6 | grep ReDoS | ✅ v1.2.0：每文件 2s + 总 10s 协作超时 |
| 7 | shell 环境泄漏 + 无命令分类 | ✅ env v1.2.0；命令分类 v1.3.1 |
| 8 | 语义静默降级 + `languages` 空转 | ✅ v1.3.2：`context:semantic_degraded` + 删空转键 |
| 9 | 仓库卫生 | ✅ 9.1/9.2/9.4/9.5/9.7 v1.2.0；9.3 v1.6.2+1.7.0；9.6 v1.3.2 |
| 10 | `agent-runtime` 可维护性 | 阶段 1–2 ✅ v1.6.3；3–4 延后 v2.0 |

审计问题 #5（四份事件展示实现）随 D-G4 共享契约 + 删 UMD 层已完全解决。

## 要点摘录

- **#1**：`classifier.js` 与 `task-router.js` 曾有两套语言假设；现共用 `keywords.js`（edit/diagnostic/query + 中文疑问语气）。
- **#2**：GUI 内嵌 CJS 装配曾丢 `orchestration` / `context`；现与 CLI/TUI 同源 `kernel-options.js`。
- **#4**：lookup 一次与真实连接两次解析存在 TOCTOU；现校验全部 A 记录并 pin IP，Host/SNI 保留原域名。
- **#7**：`buildChildEnv` 白名单继承（不含密钥/代理/`NODE_OPTIONS`）；`classifyCommand` 三层 safe/dangerous/forbidden，forbidden 经 `runProcess` 兜底硬拒，dangerous 在权限引擎升为 `execute_dangerous`（auto/full-auto 也 ask）。命令白名单用户配置面未开。
- **#9.3**：change-store 必须存 before/after 原文才能回滚，**不能**对存储套 redactor。折中：敏感路径独立红色提醒（`secret-file`/`credential-file`，全档位提问）、展示层脱敏、`maxCaptureBytes` 截断（截断记录回滚抛 `ROLLBACK_TRUNCATED`）、`changeRetention` 保留期、目录 `0o700`。
- **#10**：根因是职责混合与四条审批恢复样板重复，行数只是表征。刻画测试锁事件顺序、四分支续跑、错误语义（`APPROVAL_NOT_FOUND` / `AWAITING_APPROVAL`）；阶段 3–4 候选为抽纯函数、`resume-strategies`、状态机拆分，硬约束是公开 API/事件顺序/错误语义/暂停续跑时序不变。

## 边界

已知设计取舍（恢复 opt-in、iso worker 强制 auto、编排 sidecar 有损序列化）不列为缺陷。存储正文脱敏与 `agent-runtime` 结构重构须独立 spec。

## 验收

各条目以对应版本 CHANGELOG 与测试为准。总体验收：台账状态与代码一致，未做项不假装完成。
