# Inkstone 改名实施方案（DeepSeek Code → Inkstone）

- 类型：实施计划
- 日期：2026-07-31
- 状态：已完成
- 关联：[CHANGELOG](../../CHANGELOG.md) · [v1.4.0 前端重构](../frontend/2026-07-31-v1.4.0-frontend-redesign-plan.md)

## 目标

把产品品牌从 DeepSeek Code 换成 Inkstone（砚），降低与 DeepSeek 官方品牌的混淆风险。项目发布到 GitHub 公开面后品牌沿用旧名会放大纠纷风险；本次只换品牌暴露面，保留 DeepSeek API 集成的全部功能契约。

## 结果

| 形态 | 旧 | 新 |
|---|---|---|
| 显示名 | DeepSeek Code | Inkstone（副文案「面向 DeepSeek 的本地 AI 编程 Agent」） |
| kebab | deepseek-code | inkstone（package / repo / bin） |
| 命令 | `deepseek-code` | `inkstone`，短别名 `dsc` |
| 大写 | DEEPSEEK-CODE | INKSTONE |
| GUI 包名 | deepseek-code-gui | inkstone-gui |

当前 `package.json` 的 `name` 为 `inkstone`，`bin` 为 `inkstone` / `dsc` → `./bin/inkstone.js`。品牌暴露面已替换：窗口与页面标题、GUI 文案、TUI banner、system prompt 产品自称、User-Agent、README/docs、包名、conda 名、tests golden。

保留项（有意不改）：

- 存储与环境：`.deepseek-code` 目录、`DEEPSEEK_*` env、`DEEPSEEK_CODE_GUI_*` 开关。
- 契约与语义：错误码 `DEEPSEEK_API_ERROR`、`window.deepseek` 桥、`gui-api-profiles.json`、`options.deepseek`、`src/deepseek/` 与 `DeepSeek*` 导出（表示 DeepSeek API 集成，不是产品品牌）。
- 上游与历史：`api.deepseek.com`、模型 id（`deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-chat` / `deepseek-coder`）、文件名含 `deepseek-code` 的历史文档、`.claude/settings.json` 仓库路径。

## 关键决策 / 遗留约束

- 四形态分别替换：`DeepSeek Code`→`Inkstone`，`deepseek-code`→`inkstone`，`DEEPSEEK-CODE`→`INKSTONE`，`DeepSeek-Code`→`inkstone`（User-Agent 单点）。
- kebab 替换必须排除前导点 `.deepseek-code`，naive 全局替换会变成 `.inkstone` 并断掉全部存储契约。
- API 功能契约零改动（端点 / 模型 id / 错误码 / 配置键 / env）；不 bump 版本号；不改历史文件名。
- system prompt 只改产品自称，保留 `optimized for DeepSeek models` 等模型方事实表述。
- `gui/renderer-dist/**` 为构建产物，改源码后 `build:renderer` 重建。
- 本地 gitignore 文件（`.claude/settings.local.json` 等）同步但不提交。
- 执行按 P0 基线 → P1 结构+测试 → P2 CLI/TUI 文案 → P4 GUI → P5 文档 → P6 收口 grep 分段提交。

## 验证

- `npm test` + `npm run check` + e2e smoke。
- `node ./bin/inkstone.js help` / `ask` / `tui` 正常；`dsc` 别名可用；旧 `deepseek-code` 命令消失。
- GUI 窗口标题 / About / 侧栏项目标签显示 Inkstone；`gui-smoke` 通过。
- 收口 `grep -rniE "deepseek"` 命中仅剩允许清单（`deepseek.com`、模型 id、`DEEPSEEK_*`、`.deepseek-code`、`src/deepseek` 符号、保留文件名与历史文档）。
- `.deepseek-code` 与 `DEEPSEEK_*` 行为不变，既有项目数据可读。
