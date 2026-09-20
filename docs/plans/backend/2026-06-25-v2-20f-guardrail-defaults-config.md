# V2-20f 护栏默认值与用户配置 Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。

> 承接 V2-20a–e(护栏 plumbing 已完整);本切片把护栏**点亮**并交给用户配置。

**Goal:** 让 V2-20 护栏在真实使用中**默认生效**且**用户可配**:工具/模型超时默认 **120s 开启**,其余(token / 调用数预算、tool-call 重试)默认关闭但可配。体现项目配置哲学——**在适配 DeepSeek 前提下,参数尽量交给用户**。

**Architecture:** 默认值落在唯一来源 `DEFAULT_CONFIG.limits`(`src/config.js`);`loadConfig` / `normalizeConfig` 深合并用户 `limits`(per-field)并支持两个超时的环境变量覆盖;两个 `buildKernelOptions`(CLI `src/apps/kernel-options.js` + GUI `gui/kernel-host.js`)把 `config.limits` 转发给 `createKernel`(其 5 参接线已就绪)。kernel 原语保持"未配即关",策略(默认开)由配置层决定。

**Tech Stack:** 现有 `src/config.js`、`buildKernelOptions`、`createKernel({ limits })`。

## Global Constraints

- 默认值:`toolTimeoutMs=120000`、`modelTimeoutMs=120000`(**开**);`maxTurnTokens=null`、`maxModelCalls=null`、`maxToolCallRepairs=null`(**关**,可配)。
- 归一化:每字段接受 `正数`(生效)/ `null` 或 `≤0`(关闭)/ 省略(用默认)。
- 环境变量覆盖:`DEEPSEEK_TOOL_TIMEOUT_MS`、`DEEPSEEK_MODEL_TIMEOUT_MS`。
- 零回归:kernel 原语默认仍关;现有不带 `limits` 的调用行为不变。

---

### Task 1: config.js 默认 limits + 归一化 + 环境覆盖

**Files:**
- Modify: `src/config.js`
- Test: `tests/unit/config-limits.test.js`

**Interfaces:**
- Produces:`DEFAULT_CONFIG.limits`;`normalizeConfig(config).limits`(深合并 + 归一化);`loadConfig` 返回值含 `limits`(file 合并 + 两超时 env 覆盖)。导出 `normalizeLimits`。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/config-limits.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, normalizeLimits, DEFAULT_CONFIG } from "../../src/config.js";

test("DEFAULT_CONFIG enables 120s timeouts, leaves budgets off", () => {
  assert.equal(DEFAULT_CONFIG.limits.toolTimeoutMs, 120000);
  assert.equal(DEFAULT_CONFIG.limits.modelTimeoutMs, 120000);
  assert.equal(DEFAULT_CONFIG.limits.maxTurnTokens, null);
  assert.equal(DEFAULT_CONFIG.limits.maxModelCalls, null);
  assert.equal(DEFAULT_CONFIG.limits.maxToolCallRepairs, null);
});

test("normalizeConfig fills default limits when omitted", () => {
  const c = normalizeConfig({});
  assert.equal(c.limits.toolTimeoutMs, 120000);
  assert.equal(c.limits.modelTimeoutMs, 120000);
});

test("normalizeConfig deep-merges user limits per field", () => {
  const c = normalizeConfig({ limits: { toolTimeoutMs: 5000, maxModelCalls: 10 } });
  assert.equal(c.limits.toolTimeoutMs, 5000);     // user override
  assert.equal(c.limits.modelTimeoutMs, 120000);  // default preserved
  assert.equal(c.limits.maxModelCalls, 10);       // user opt-in
});

test("normalizeLimits treats null / <=0 as disabled", () => {
  assert.equal(normalizeLimits({ toolTimeoutMs: null }).toolTimeoutMs, null);
  assert.equal(normalizeLimits({ modelTimeoutMs: 0 }).modelTimeoutMs, null);
  assert.equal(normalizeLimits({ toolTimeoutMs: -5 }).toolTimeoutMs, null);
});

test("normalizeLimits coerces numeric strings and truncates", () => {
  assert.equal(normalizeLimits({ toolTimeoutMs: "3000" }).toolTimeoutMs, 3000);
  assert.equal(normalizeLimits({ maxModelCalls: 4.9 }).maxModelCalls, 4);
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test tests/unit/config-limits.test.js`
Expected: FAIL（`DEFAULT_CONFIG.limits` undefined、`normalizeLimits` 未导出）。

- [ ] **Step 3: 实现 config.js**

`DEFAULT_CONFIG` 增加:

```js
  limits: {
    toolTimeoutMs: 120000,
    modelTimeoutMs: 120000,
    maxTurnTokens: null,
    maxModelCalls: null,
    maxToolCallRepairs: null
  }
```

新增导出:

```js
export function normalizeLimits(raw = {}) {
  const d = DEFAULT_CONFIG.limits;
  return {
    toolTimeoutMs: toLimit(raw.toolTimeoutMs, d.toolTimeoutMs),
    modelTimeoutMs: toLimit(raw.modelTimeoutMs, d.modelTimeoutMs),
    maxTurnTokens: toLimit(raw.maxTurnTokens, d.maxTurnTokens),
    maxModelCalls: toLimit(raw.maxModelCalls, d.maxModelCalls),
    maxToolCallRepairs: toLimit(raw.maxToolCallRepairs, d.maxToolCallRepairs)
  };
}

function toLimit(value, fallback) {
  if (value === undefined) return fallback;     // 省略 → 默认
  if (value === null) return null;              // 显式关闭
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null; // 非法 / ≤0 → 关闭
  return Math.trunc(n);
}

function limitsFromEnv(limits) {
  const tool = process.env.DEEPSEEK_TOOL_TIMEOUT_MS;
  const model = process.env.DEEPSEEK_MODEL_TIMEOUT_MS;
  return {
    ...limits,
    ...(tool !== undefined ? { toolTimeoutMs: toLimit(tool, limits.toolTimeoutMs) } : {}),
    ...(model !== undefined ? { modelTimeoutMs: toLimit(model, limits.modelTimeoutMs) } : {})
  };
}
```

`loadConfig` 的 `config` 对象增加字段:

```js
    limits: limitsFromEnv(normalizeLimits(fileConfig.limits))
```

`normalizeConfig` 返回对象增加字段:

```js
    limits: normalizeLimits(config.limits)
```

- [ ] **Step 4: 运行测试**

Run: `node --test tests/unit/config-limits.test.js`
Expected: PASS（5）。

- [ ] **Step 5: 提交**

```bash
git add src/config.js tests/unit/config-limits.test.js
git commit -m "feat(config): default-on 120s timeouts + user-configurable limits

```

---

### Task 2: 两个 buildKernelOptions 转发 limits（CLI + GUI）

**Files:**
- Modify: `src/apps/kernel-options.js`
- Modify: `gui/kernel-host.js`
- Test: `tests/unit/apps/kernel-options.test.js`(扩展)

**Interfaces:**
- Consumes:`config.limits`(来自 Task 1)。
- Produces:`buildKernelOptions` 返回值在 `config.limits` 存在时附带 `limits`,流向 `createKernel({ limits })`(5 参接线已就绪)。`config.limits` 缺省时不附加(保持既有形状)。

- [ ] **Step 1: 写失败测试(扩展现有)**

向 `tests/unit/apps/kernel-options.test.js` 追加:

```js
test("buildKernelOptions forwards config limits to the kernel", async () => {
  const options = await buildKernelOptions("/repo", {}, async () => ({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid",
    limits: { toolTimeoutMs: 120000, modelTimeoutMs: 120000, maxTurnTokens: null, maxModelCalls: null, maxToolCallRepairs: null }
  }));
  assert.equal(options.limits.toolTimeoutMs, 120000);
  assert.equal(options.limits.modelTimeoutMs, 120000);
  assert.equal(options.deepseek.apiKey, "sk-test");
});
```

（保留原有两个用例不变——原 mock 不含 `limits`,故输出仍为 `{ deepseek }`。）

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test tests/unit/apps/kernel-options.test.js`
Expected: 新用例 FAIL（当前不转发 limits）。

- [ ] **Step 3: 实现 —— CLI buildKernelOptions**

`src/apps/kernel-options.js` 主返回改为:

```js
  const result = {
    ...overrides,
    deepseek: {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl
    }
  };
  if (config.limits) result.limits = config.limits;
  return result;
```

- [ ] **Step 4: 实现 —— GUI buildKernelOptions**

`gui/kernel-host.js`(约 83-89 行)同样改:构造 `result`,`if (config.limits) result.limits = config.limits;` 后 `return result;`。

- [ ] **Step 5: 运行测试 + 全量 + 检查**

Run: `node --test tests/unit/apps/kernel-options.test.js tests/unit/gui/kernel-host.test.js`
Expected: PASS（含原有用例)。
Run: `npm test` → 全绿;`npm run check` → 退出码 0。

- [ ] **Step 6: 提交**

```bash
git add src/apps/kernel-options.js gui/kernel-host.js tests/unit/apps/kernel-options.test.js
git commit -m "feat(apps): forward config limits into CLI and GUI kernels

```

---

## 配置哲学(记入设计)

> **在适配 DeepSeek 的前提下,参数尽量交给用户配置。** 默认值只提供"安全合理的起点"(如超时 120s),不锁死;每个旋钮都能经 `config.json` 的 `limits`(`config show` 可见)或环境变量覆盖,`null`/`≤0` 显式关闭。

**用户配置示例**(`.deepseek-code/config.json`):

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

环境变量:`DEEPSEEK_TOOL_TIMEOUT_MS` / `DEEPSEEK_MODEL_TIMEOUT_MS`。

## 后续

- README「配置」段补充 `limits` 说明(Task 完成后)。
- 仍属 Phase A 的较大项:**V2-19**(删 legacy)、**V2-18 合并**。

> 依据:[V3 路线图 §5](../../specs/architecture/2026-06-24-v3-roadmap-design.md);承接 V2-20a–e。
