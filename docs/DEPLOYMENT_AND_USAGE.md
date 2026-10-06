# Inkstone 本地部署与使用指南

Inkstone（砚台）的本地部署、模型配置、CLI / TUI / 桌面 GUI 用法与排错说明。

---

## 环境要求

| 项 | 要求 |
|----|------|
| 操作系统 | Windows 10/11（x64、ARM64）、macOS 11+（Intel / Apple Silicon）、Ubuntu 20.04+ / Debian 11+ / Fedora 36+ / Arch 等 |
| Node.js | **≥ 20**（推荐 20 LTS 或 22 LTS） |
| Git | ≥ 2.30（推荐，用于 diff 与版本管理） |
| C/C++ 工具链 | 不需要。核心与 TUI 基于 Node 标准库；语义引擎用 WASM |

```bash
node --version   # 应 ≥ v20
```

---

## 部署

### CLI / TUI（核心零依赖）

内核与 CLI / TUI 无外部生产依赖，克隆后可直接运行，不必 `npm install`。

```bash
git clone https://github.com/fengzhiyushui/inkstone.git
cd inkstone

node ./bin/inkstone.js help

# 可选：全局注册 inkstone / dsc
npm link
# 或
npm i -g .

inkstone --help
dsc --help
```

### 语义级上下文引擎（可选 WASM）

默认使用文件级上下文。需要对 JS / TS / Python 做 AST 符号与调用图分析时，再装可选依赖：

```bash
npm install web-tree-sitter@0.20.8 --no-save

node ./bin/inkstone.js ask "解释项目核心流程" --semantic-context
```

关闭 `--semantic-context` 时行为与文件级一致。该依赖是纯 WASM，无需本地编译器。

### 桌面 GUI（Electron + React）

GUI 需要单独安装依赖并构建渲染层。

```bash
cd gui
npm install
npm run build:renderer

# 生产模式
npm start

# 开发模式（热重载）
npm run dev
```

根目录也可：

```bash
npm run build:gui
npm run gui
```

GUI 提供会话优先工作台、Monaco 只读 Diff、改动跟踪、右栏 Dock（计划 / 文件 / 改动 / 恢复）与设置模态。

---

## 模型配置

配置查找顺序（高优先覆盖低优先）：

1. 环境变量
2. 项目级 `./.deepseek-code/config.json`
3. 用户级 `~/.deepseek-code/config.json`

`.deepseek-code/` 已被 `.gitignore` 忽略，API Key 不会进 Git。

### DeepSeek 官方 API

```bash
# 交互初始化（推荐）
node ./bin/inkstone.js config init --api-key sk-your-deepseek-api-key
```

或用环境变量：

```bash
# bash / zsh
export DEEPSEEK_API_KEY="sk-your-deepseek-api-key"

# PowerShell
$env:DEEPSEEK_API_KEY="sk-your-deepseek-api-key"

# CMD
set DEEPSEEK_API_KEY=sk-your-deepseek-api-key
```

连通性检查：

```bash
node ./bin/inkstone.js config test
# 成功时输出：API connection test succeeded.
```

### 本地与第三方兼容端点

网关兼容 OpenAI / DeepSeek 协议。指定 `baseUrl` 与模型名即可。

Ollama 示例：

```json
{
  "apiKey": "ollama",
  "baseUrl": "http://localhost:11434/v1",
  "model": "deepseek-coder-v2:latest",
  "models": {
    "act": "deepseek-coder-v2:latest",
    "think": "deepseek-r1:latest",
    "fim": "deepseek-coder-v2:latest"
  }
}
```

vLLM / LocalAI / 中转示例：

```bash
node ./bin/inkstone.js config init \
  --api-key "your-key" \
  --base-url "https://api.siliconflow.cn/v1" \
  --model "deepseek-ai/DeepSeek-V3"
```

### 配置文件结构

以 [`src/config.js`](../src/config.js) 的 `DEFAULT_CONFIG` 为准。常见字段：

```json
{
  "apiKey": "sk-********************",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-flash",
  "reasoningEffort": "high",
  "betaBase": "",
  "models": {
    "act": "deepseek-flash",
    "think": "deepseek-v4-pro",
    "fim": "deepseek-flash"
  },
  "limits": {
    "toolTimeoutMs": 120000,
    "modelTimeoutMs": 120000,
    "maxTurnTokens": null,
    "maxModelCalls": null,
    "maxToolCallRepairs": null
  },
  "context": {
    "semantic": {
      "enabled": false,
      "hops": 2,
      "maxSymbols": 200,
      "includeMethodHints": false,
      "importRoots": []
    }
  },
  "orchestration": {
    "maxSubtasks": 8,
    "maxWorkerAttempts": 2,
    "maxRounds": 2,
    "crossTaskLearning": "off",
    "budget": { "maxTokens": null, "maxModelCalls": 40 },
    "parallel": {
      "maxParallelWorkers": 4,
      "maxCopyFiles": 5000,
      "sweepTtlMs": 3600000
    },
    "router": {
      "minComplexFiles": 2,
      "model": {
        "enabled": true,
        "channel": "act",
        "timeoutMs": 8000,
        "maxRepairs": 1,
        "complexThreshold": 3
      }
    }
  },
  "edits": {
    "maxCaptureBytes": 1048576,
    "changeRetention": { "maxRecords": 200, "maxAgeDays": 90 }
  }
}
```

| 字段 | 含义 |
|------|------|
| `models.act` | 日常问答与工具调用（默认 `deepseek-flash`） |
| `models.think` | 规划 / 评审 / 修复（默认 `deepseek-v4-pro`） |
| `models.fim` | 光标处补全（`/beta/completions`，默认 `deepseek-flash`） |
| `reasoningEffort` | think 通道思考强度：`none` / `low` / `medium` / `high` / `max`，默认 `high`；历史版本的 low/medium 折叠为 high 已废弃 |
| `betaBase` | FIM beta 端点根地址，默认 `""` = 客户端自拼 `${baseUrl}/beta`；自建/代理网关可显式覆盖 |
| `limits` | 超时与回合预算护栏 |
| `context.semantic` | 语义上下文（默认关） |
| `orchestration` | 多智能体拆解、并行写隔离、经验学习 |
| `edits` | 变更记录截断与保留期 |
| `crossTaskLearning` | `"off"` / `"on"` / `"gated"`，默认 `"off"` |

持久化恢复不是 `config.json` 字段。启用方式是 `createKernel(root, { recovery: { enabled: true } })`（CLI/TUI 经对应入口透传；默认关闭）。

### 旧模型 id 静默迁移

`deepseek-v4-flash`（V4-Flash）已退役。旧配置（`model` / `models.*`）中若仍写着该 id，Inkstone 加载时会在内存中自动改写为 `deepseek-flash`：仅本次运行生效，不会重写 `config.json`。改写只做精确键匹配，第三方端点（Ollama / vLLM / OneAPI）的模型 id 一律原样保留，显式指定的模型 id 仍最高优先。

### thinking 与 reasoning_effort

- 通道画像由内核路由表决定：`plan` / `review` / `repair` 三个 think 通道**默认开启 thinking**（effort `high`），`reply` / `act` / `fim` 默认关闭。
- 官方协议下 **thinking 开启时 `temperature` 静默无效**——think 通道因此不传 temperature；需要调采样只能先关 thinking（配置层改变量不影响已冻硬的通道开关）。
- `reasoning_effort` 合法全集 `none` / `low` / `medium` / `high` / `max`，原样透传不做折叠；`none` 语义等价「关思考」。未识别值回落默认 `high`。
- `max_tokens`：非 thinking 默认 8K 量级、thinking 官方默认 64K（`effort=max` 时 128K），单次上限 384K；输出被截断时结果带 `truncated` 标记，可用更低的 effort 或更具体的指令重试。

### 第三方端点兼容警告

Inkstone 核心按 DeepSeek 官方协议编写。接入 **Ollama / vLLM / OneAPI / 硅基流动 / OpenRouter** 等兼容端点时，网关必须完整透传以下扩展字段，否则思考链断裂或在工具循环中直接 400：

- `thinking`（开关）与 `reasoning_effort`（强度）——OneAPI 类网关的「模型映射」重建请求体时最易吞掉；
- 历史消息的 `reasoning_content`——带 `tools` 的请求每轮必须回传；
- `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `completion_tokens_details.reasoning_tokens`——用量分列依赖。

现象与处置：思考不显示 → 网关吞了 `thinking`；工具循环第二轮 400 → 网关吞了 `reasoning_content`；用量缺列 → 网关重写了 usage。自建网关可用 `betaBase` 单独指定 FIM 端点根地址；无法升级网关时建议对 agent 类任务直连官方端点。

### MCP (Model Context Protocol) 外部工具扩展

自 `v1.11.0` 起，Inkstone 原生支持标准 MCP (Model Context Protocol) 协议，可在 `./.deepseek-code/config.json` 或 `~/.deepseek-code/config.json` 中配置 `mcpServers`：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "d:/workspace"],
      "env": { "NODE_ENV": "production" },
      "autoApprove": ["read_file", "list_directory"],
      "disabled": false
    },
    "sqlite": {
      "command": "uvx",
      "args": ["mcp-server-sqlite", "--db-path", "test.db"],
      "autoApprove": ["read_query"],
      "disabled": false
    }
  }
}
```

字段说明：
- `command`：子进程启动命令（如 `npx`, `uvx`, `node`, `python` 等）；
- `args`：参数数组；
- `env`：自定义环境变量；
- `autoApprove`：免审批工具名称列表，只读工具默认自动放行，写操作/变更类工具在未配置 autoApprove 时将挂起索要人类审批；
- `disabled`：设为 `true` 时跳过加载。

命令行管理命令：
```bash
# 查看所有已配置的 MCP 服务状态
node ./bin/inkstone.js mcp list

# 测试特定服务连通性与可用工具探测
node ./bin/inkstone.js mcp check filesystem

# 快速添加并持久化新 MCP 服务配置
node ./bin/inkstone.js mcp add fs --command npx --args "-y,@modelcontextprotocol/server-filesystem,./src" --auto-approve "read_file,list_directory"

# 切换服务启用/禁用状态
node ./bin/inkstone.js mcp toggle fs

# 从配置文件中安全移除服务
node ./bin/inkstone.js mcp remove fs
```

图形化管理 (GUI)：
桌面端左侧导航栏点击「MCP」次级视图，可直接查看已连接服务、展开查看暴露的工具参数抽屉，点击右上角「+ 添加服务」即可通过官方推荐模板（Filesystem、Fetch、Memory、SQLite、GitHub）或自定义配置一键热插拔挂载，并提供卡片级服务启停、一键重启与安全删除二次确认。

v1.14 起，可按需浏览资源与提示词；这些命令无需模型 API Key，仅连接指定服务：

```bash
node ./bin/inkstone.js mcp resources filesystem list
node ./bin/inkstone.js mcp resources filesystem templates
node ./bin/inkstone.js mcp resources filesystem read "file:///project/README.md"
node ./bin/inkstone.js mcp prompts helper list
node ./bin/inkstone.js mcp prompts helper get review --arguments '{"language":"中文"}'
node ./bin/inkstone.js mcp resources filesystem list --max-pages 5 --max-items 200 --max-bytes 65536
```

服务必须声明对应的 resources/prompts 能力，否则列表提示不支持，读取拒绝。`read` 的 URI 由 MCP 服务解释，Inkstone 不直接请求 URI。CLI/GUI 默认只取 1 页 / 50 项 / 64 KiB；截断有提示，可调整上限。服务端 `nextCursor` 可用 `--cursor` 续读；`inkstone-page:` 是当前连接内的分页偏移，不能在新 CLI 进程复用，此时提高上限重新列出。列表最多 20 页 / 1000 项，内容最多 1 MiB。

GUI 的服务卡片提供「资源 / URI 模板 / 提示词」标签。展开按需加载，模板需先填完整 URI，提示词需填必填参数；预览后点击「放入对话」生成引用草稿，检查后再发送。binary 不直接显示；文本、错误和结构化输出中的已知密钥会脱敏。对话中的模型也可调用 `mcp_resources` / `mcp_prompts` 读取同一内容。

当工具定义 `outputSchema` 时，客户端校验返回的 structuredContent；不匹配、缺失或 schema 使用未支持的关键词都会报错。支持范围是有界 JSON Schema 2020-12 子集（见 [MCP 设计规格](specs/architecture/2026-09-29-mcp-client-v2-design.md)），不承诺任意 schema 兼容。

### MCP OAuth 登录（v1.15）

远程 MCP 支持 OAuth 公共客户端。先添加服务，再在浏览器中授权（示例地址与客户端 ID 需替换为服务方提供的真实值）：

```bash
node ./bin/inkstone.js mcp add remote --url "https://mcp.example.com/mcp" --oauth --client-id "https://app.example.com/inkstone-client.json" --scopes "mcp:read"
node ./bin/inkstone.js mcp auth remote
node ./bin/inkstone.js mcp auth remote status
node ./bin/inkstone.js mcp check remote
node ./bin/inkstone.js mcp auth remote logout
```

CLI 会显示授权地址并等待本机回调，请保持命令运行；在浏览器完成后自动保存凭据。取消请在原登录命令按 Ctrl+C。独立 `cancel` 命令只作用于当前进程的待授权流程，不跨进程取消另一个登录命令。

GUI 添加远程服务时勾选 OAuth，填写可选客户端 ID 与 scopes，随后在服务卡片点「登录」。浏览器由主进程打开；完成后服务自动重连并刷新工具列表，也可取消或退出登录。无需模型 API Key 即可管理 MCP 登录。

`--client-id` 可以是预注册公共客户端 ID，或 AS 支持的 HTTPS Client ID Metadata Document URL。未提供时尝试服务端动态注册；没有动态注册能力时需配置客户端 ID。Inkstone 不托管 metadata 文档，也不接受在项目配置中写入 client secret/access token/refresh token。OAuth 不与静态 Authorization 请求头混用。

默认凭据位于 `~/.deepseek-code/credentials/mcp-oauth/`，加密落盘、自动刷新，按 server/issuer/resource/client/scopes 隔离。`DEEPSEEK_CODE_HOME` 替代用户 home 后仍追加 `.deepseek-code`。退出会清除该服务该资源的本地凭据，不代表远端撤销授权；需要彻底撤销时使用服务方账户设置。OAuth 仅接受 HTTPS，显式私网放行清单中的回环 HTTP 用于本机服务/测试；OAuth 请求不跟随重定向。

### MCP 诊断与工具试跑（v1.16）

CLI 可以读取以前运行留下的诊断，无需模型 API Key，也不会连接 MCP 服务：

```bash
node ./bin/inkstone.js mcp logs
node ./bin/inkstone.js mcp logs filesystem --limit 100
node ./bin/inkstone.js mcp logs remote --level error --category timeout
node ./bin/inkstone.js mcp logs remote --method tools/call --search timeout
node ./bin/inkstone.js mcp logs remote --limit 500 --json
```

`--limit` 默认 50，范围 1–500；`--level` 为 debug/info/warn/error，`--category` 为 transport/protocol/auth/permission/timeout/cancelled/tool/lifecycle。`--method` 精确匹配，`--search` 忽略大小写搜索。JSON 可重定向保存。历史按项目保存在 `.deepseek-code/mcp-logs/`，每次运行最多 500 条 / 1 MiB，保留最近 8 个运行文件；已移除服务仍可查询。日志只有结构摘要、请求 ID、耗时与错误，不保存完整参数、结果或原始 stderr。没有记录时会提示无匹配日志；读写失败会显示存储错误。

TUI 输入以下命令直接管理当前内核：

```text
/mcp
/mcp list
/mcp restart filesystem
/mcp disable filesystem
/mcp enable filesystem
/mcp logs filesystem 100
```

`/mcp logs` 默认查询全部服务的最近 50 条。管理命令不会调用模型；操作进行时等待其完成，再发送对话。Esc 仍用于中断模型回合，不能取消服务重启/启停；界面会提示等待。

GUI 在服务卡片展开「诊断与工具试跑」，切到日志页后按需加载、筛选、刷新或导出 JSON。工具试跑页选择工具，填写参数字段或切换 JSON，点击运行；缺失参数、类型错误或不支持的 Schema 约束会先报告错误。需要审批时检查工具与参数后仅批准本次；该批准不变成永久规则，5 分钟过期。运行中可取消，服务切换/禁用/移除后旧结果不会覆盖新界面。参数和显示结果有 64 KiB 限制，二进制省略，超长输出提示截断。试跑直接执行工具，其实际副作用取决于工具本身；取消只能停止尚未结束的请求，不能撤销已完成的远端操作。

### 环境变量

| 变量 | 对应配置 | 默认 |
|------|----------|------|
| `DEEPSEEK_API_KEY` | `apiKey` | 无 |
| `DEEPSEEK_BASE_URL` | `baseUrl` | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | `model` | `deepseek-flash` |
| `DEEPSEEK_REASONING_EFFORT` | `reasoningEffort` | `high` |
| `DEEPSEEK_TOOL_TIMEOUT_MS` | `limits.toolTimeoutMs` | `120000` |
| `DEEPSEEK_MODEL_TIMEOUT_MS` | `limits.modelTimeoutMs` | `120000` |

查看当前生效配置：

```bash
node ./bin/inkstone.js config show
```

### 运行护栏

| 参数 | 默认 | 行为 |
|------|------|------|
| `toolTimeoutMs` | 120s | 工具超时返回格式化错误，不强杀进程 |
| `modelTimeoutMs` | 120s | 覆盖流式完整传输；悬挂时中止 |
| `maxTurnTokens` | 关 | 命中后 `status: "stopped"` |
| `maxModelCalls` | 关 | 防单回合工具往返无限循环 |
| `maxToolCallRepairs` | 关 | 畸形 tool-call JSON 有界修复 |

---

## 使用教程

### CLI

适合脚本与 CI。

```bash
# 问答（项目上下文）
node ./bin/inkstone.js ask "梳理当前项目所有的 API 路由入口及鉴权机制"

# 语义级符号分析
node ./bin/inkstone.js ask "用户登录状态是如何在前端保持的？" --semantic-context

# 控制扫描预算
node ./bin/inkstone.js ask "解释核心数据模型" --max-files 50 --max-bytes 500000

# 编辑：预览 / 指定文件 / 免确认
node ./bin/inkstone.js edit "为 src/theme.js 中的高亮函数补充 JSDoc 注释" --dry-run
node ./bin/inkstone.js edit "修复内存泄漏问题" --file src/runtime.js --file src/cache.js
node ./bin/inkstone.js edit "规范化导出命名" --yes

# 交互对话
node ./bin/inkstone.js chat
# REPL 内：/mode  ·  /recovery  ·  /help

# 变更审查与回滚
node ./bin/inkstone.js changes list
node ./bin/inkstone.js changes show latest
node ./bin/inkstone.js rollback latest
node ./bin/inkstone.js rollback chg-1718291024-abc123

# 扫描与检索
node ./bin/inkstone.js scan
node ./bin/inkstone.js search "createKernel" --max 30

# 测试透传
node ./bin/inkstone.js test
node ./bin/inkstone.js test --filter=auth
```

其他命令：`help` · `diff` · `config` · `resume` · `tui`。

### TUI

行内滚动流终端界面（手写 ANSI/VT）。

```bash
node ./bin/inkstone.js tui
# 或全局
inkstone tui
```

界面要点：历史进终端原生滚动区（滚轮 / 复制 / 查找可用）；底部固定模型、模式、Token 与输入框；思考 / 工具 / Diff 分卡渲染；危险操作弹审批卡（`y` 放行，`Esc` 拒绝）。

斜杠命令：

| 命令 | 作用 |
|------|------|
| `/help` | 命令说明 |
| `/mode [read-only\|gated\|auto]` | 自主权档位 |
| `/config` | API 列表管理、连通性测试（密钥掩码） |
| `/diff` | 工作区 Git 差异 |
| `/changes` | 历史 Agent 修改 |
| `/theme` | 主题 |
| `/lang [zh\|en]` | 界面语言并持久化 |
| `/shell` | Shell 相关 |
| `/recovery` | 中断会话管理 |
| `/clear` | 清屏 |
| `/quit` / `/exit` | 退出 |

busy 态按 `Esc` 可 `interrupt()` 当前回合，保留会话。

### 桌面 GUI

```bash
cd gui && npm start
```

| 区域 | 内容 |
|------|------|
| 左侧 Rail | 视图切换（文件 / SCM / 会话等）、主题与语言、设置入口；可收放 |
| 侧栏 | 文件树、SCM「AGENT 改动」、会话历史 |
| 主区 | 会话流 + Monaco Diff |
| 右栏 Dock | 计划、文件、改动、恢复；`Ctrl/⌘+J` |
| 设置模态 | API 列表、模型获取、主题、护栏等 |

保存走事务化 `editService`，手动与 Agent 改动都有记录。

### 多智能体编排

复杂任务由分层路由器自动选择单智能体或多智能体：

```mermaid
graph TD
    A[用户输入] --> B{分层路由器}
    B -->|简单| C[单智能体]
    B -->|复杂跨文件| D[Planner 拆解]
    D --> E[子任务调度]
    E --> F[Worker 隔离区]
    E --> G[Worker 隔离区]
    F --> H[自审]
    G --> I[自审]
    H --> J[只读 Reviewer]
    I --> J
    J -->|打回| D
    J -->|通过| K[原子合并]
    K --> L[Synthesizer 汇总]
```

要点：无依赖且文件范围不重叠的子任务可并行隔离执行后合并；Worker 自审 + 独立 Reviewer 两级审核；`crossTaskLearning` 开启后可沉淀跨任务经验。

### 事务编辑与回滚

1. 写前快照受影响文件哈希与原文。
2. Unified Diff 解析应用；失败自动撤销，不留半写文件。
3. 回滚入口：CLI `rollback`、TUI `/changes`、GUI SCM「Rollback」。
4. 验证-修复环：应用后跑语法 / 测试，失败则模型接收错误进入修复回合。

超大文件只存摘要（见 `maxCaptureBytes`）；缺 before 全文时拒绝回滚并报 `ROLLBACK_TRUNCATED`，避免误清空。

### 会话时间线与恢复

- 会话是 append-only JSONL 事件流（`SESSION_EVENT_TYPES` 共约 65 类）。可从历史回合分支或 `rewind`。
- 开启 `recovery.enabled` 后，项目锁 + 事务日志守护写状态；崩溃后可从断点续跑。默认关闭。

---

## 常见问题

**Q1：`SyntaxError: Unexpected token '?'` 等语法错误**  
需要 Node ≥ 20。检查 `node -v`，用 `nvm` / `fnm` 升到 20 或 22 LTS。

**Q2：PowerShell 提示禁止运行脚本**  
当前会话临时放行：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

**Q3：`config test` 超时或 API 错误**  
核对 API Key；内网配置 `HTTP_PROXY` / `HTTPS_PROXY`；`DEEPSEEK_BASE_URL` 不要多余斜杠。

**Q4：GUI 白屏或找不到模块**  
在 `gui/` 执行过 `npm install` 与 `npm run build:renderer`；确认 Node 与 Electron 版本匹配。

**Q5：修改未生效或提示文件超出边界**  
路径安全会阻断穿越与 symlink 逃逸。被编辑文件必须在工作区内，且不能指向工作区外的链接。
