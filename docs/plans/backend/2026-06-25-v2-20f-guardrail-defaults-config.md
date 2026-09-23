# V2-20f 护栏默认值与用户配置 Implementation Plan

- 类型：实施计划
- 日期：2026-06-25
- 状态：已完成
- 关联：[V2-20a–e](2026-06-24-v2-20a-runtime-cost-timeout-guardrails.md)、[CHANGELOG](../../CHANGELOG.md)

## 目标

让 V2-20 护栏在真实使用中默认生效且用户可配：工具/模型超时默认 120s 开启，token 与调用数预算、tool-call 重试默认关闭但可配。体现项目配置哲学——在适配 DeepSeek 前提下，参数尽量交给用户。

## 结果

默认值落在唯一来源 `DEFAULT_CONFIG.limits`（`src/config.js`）：

| 键 | 默认 | 语义 |
|---|---|---|
| `toolTimeoutMs` | 120000 | 开 |
| `modelTimeoutMs` | 120000 | 开 |
| `maxTurnTokens` | null | 关 |
| `maxModelCalls` | null | 关 |
| `maxToolCallRepairs` | null | 关 |

归一化导出 `normalizeLimits(raw)`，内部 `toLimit(value, fallback)`：省略 → 默认；`null` → 显式关闭；非有限数或 `≤0` → 关闭；否则 `Math.trunc(n)`。数值字符串强制转换（`"3000"` → 3000），小数截断（`4.9` → 4）。

环境变量覆盖经 `limitsFromEnv(limits)`：`DEEPSEEK_TOOL_TIMEOUT_MS`、`DEEPSEEK_MODEL_TIMEOUT_MS`，仅这两个超时可被 env 覆盖，预算项走配置文件。

`loadConfig` 返回值含 `limits: limitsFromEnv(normalizeLimits(fileConfig.limits))`；`normalizeConfig` 返回值含 `limits: normalizeLimits(config.limits)`。

CLI `src/apps/kernel-options.js` 与 GUI `gui/kernel-host.js` 的 `buildKernelOptions` 在 `config.limits` 存在时转发：

```text
const result = { ...overrides, deepseek: { apiKey, baseUrl } };
if (config.limits) result.limits = config.limits;
return result;
```

缺省时不附加，保持既有返回形状（原 mock 不含 limits 的用例输出仍为 `{ deepseek }`）。

用户配置示例（`.deepseek-code/config.json`）：

```json
{
  "limits": {
    "toolTimeoutMs": 180000,
    "modelTimeoutMs": 120000,
    "maxTurnTokens": 200000,
    "maxModelCalls": 40,
    "maxToolCallRepairs": 1
  }
}
```

## 关键决策 / 遗留约束

配置哲学（记入设计）：在适配 DeepSeek 的前提下，参数尽量交给用户配置。默认值只提供安全合理的起点（如超时 120s），不锁死；每个旋钮都能经 `config.json` 的 `limits`（`config show` 可见）或环境变量覆盖，`null` / `≤0` 显式关闭。

kernel 原语保持「未配即关」，策略（默认开）由配置层决定。现有不带 `limits` 的调用行为不变。零回归：不传 limits 的 `createKernel` / `createAgentRuntime` / `createToolExecutor` 调用与改前一致。

默认开超时的理由：模型或工具挂起会永久阻塞 turn，120s 是安全合理的上限；预算类参数涉及成本策略，交给用户决定是否启用。

后续：README「配置」段补充 `limits` 说明。仍属 Phase A 的较大项：V2-19（删 legacy）、V2-18 合并。

## 验证

`tests/unit/config-limits.test.js` 五用例：DEFAULT 开 120s 超时关预算；省略时补默认；用户 limits 按字段深合并（覆盖一个保留其余）；`null` / `0` / `-5` 关闭；数值字符串强制转换与小数截断。`tests/unit/apps/kernel-options.test.js` 断言 limits 转发且原有无 limits 用例输出形状不变。`npm test` + `npm run check`。当前实现在 `src/config.js` 的 `DEFAULT_CONFIG.limits` 与 `normalizeLimits`、`src/apps/kernel-options.js`、`gui/kernel-host.js`。
