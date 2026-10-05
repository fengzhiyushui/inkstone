import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "../helpers/tmp.js";
import {
  createPolicyStore,
  policyGrantsAsRules,
  validateApprovalScope,
  normalizeApprovalScope,
  policyKey
} from "../../src/tools/mcp/tool-policy.js";
import { createPermissionEngine } from "../../src/tools/permissions/permission-engine.js";
import { createPolicyContext } from "../../src/tools/permissions/policy-loader.js";

/**
 * v1.13.1 验收闭环:持久化授权能否经"策略存储 → 规则 → 引擎"真正生效。
 *
 * v1.13.0 的缺陷正是这条链断开(policyGrants 恒为 null、validateApprovalScope
 * 无生产调用方),所以这里把整条链一次走通,而不是只测单个模块。
 *
 * 每个用例都拿**独立的临时 userRoot** —— 否则 always 级授权会写进真实主目录,
 * 并在用例之间互相污染。
 */
const engine = createPermissionEngine();

async function withStore(fn) {
  const base = await mkdtemp(path.join(tmpdir(), "dsc-policy-closure-"));
  try {
    const store = createPolicyStore({
      projectRoot: path.join(base, "repo"),
      userRoot: path.join(base, "home")
    });
    await fn({ store });
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

function decideWith(store, toolCall, { autonomy = "read-only" } = {}) {
  // 这正是 createKernel 里 mergeProjectRules() 的合并顺序:MCP 策略在前
  const rules = [...(store.asRules())];
  return engine.decide(toolCall, createPolicyContext({ autonomy, projectRules: rules }));
}

test("闭环:用户在批准菜单选『本项目』→ 该工具之后不再询问", async () => {
  await withStore(({ store }) => {
    const call = { name: "mcp__fs__write_file", category: "mutate", params: { path: "src/a.js" }, autoApprove: false };
    assert.equal(decideWith(store, call).decision, "deny", "授权前:read-only 下写操作应被拒");

    // 用户点"本项目"
    const verdict = validateApprovalScope({ category: call.category, scope: "project", toolName: call.name });
    assert.equal(verdict.ok, true);
    assert.equal(store.grant(call.name, verdict.scope).ok, true);

    const after = decideWith(store, call);
    assert.equal(after.decision, "allow", "授权后必须放行 —— 闭环的关键断言");
    assert.equal(after.source, "project-rules");
    assert.equal(after.matched_rule, "mcp-policy:project:mcp__fs__write_file");

    // 别的工具不受影响
    const other = decideWith(store, { ...call, name: "mcp__fs__delete_file" });
    assert.equal(other.decision, "deny", "未被授权的工具不得被顺带放行");
  });
});

test("闭环:用户选『永久』→ 用户级优先于项目级", async () => {
  await withStore(({ store }) => {
    store.grant("mcp__a__t", "always");
    store.grant("mcp__a__t", "project");

    const rules = store.asRules();
    // 两级授权各自落在独立文件,因此是两条规则;靠**顺序**表达优先级
    assert.equal(rules.length, 2);
    assert.equal(rules[0].meta.scope, "always", "always 必须排在前面:引擎首条命中即返回");
    assert.equal(rules[1].meta.scope, "project");

    const result = engine.decide(
      { name: "mcp__a__t", category: "mutate", params: {} },
      createPolicyContext({ autonomy: "read-only", projectRules: rules })
    );
    assert.equal(result.decision, "allow");
    assert.equal(result.matched_rule, "mcp-policy:always:mcp__a__t", "应命中 always 而非 project");
  });
});

test("闭环:destructive 即使在批准菜单也拿不到 project / always", async () => {
  await withStore(({ store }) => {
    const destructive = { name: "mcp__db__drop_table", category: "destructive", params: {}, autoApprove: true };

    // 用户在菜单点了"永久"
    const verdict = validateApprovalScope({ category: "destructive", scope: "always", toolName: destructive.name });
    assert.equal(verdict.ok, false, "必须被拒绝");
    assert.equal(verdict.scope, "session", "降级为仅本次");
    assert.equal(verdict.locked, true);

    // 即使真的写进文件(例如手改 JSON),引擎也一律拒绝
    store.grant(destructive.name, "always");
    const result = decideWith(store, destructive, { autonomy: "full-auto" });
    assert.equal(result.decision, "deny");
    assert.equal(result.source, "safety-invariant");
  });
});

test("闭环:session 作用域只进内存缓存,不落盘", async () => {
  await withStore(({ store }) => {
    assert.equal(store.grant("mcp__s__t", "session").ok, false, "session 不落盘");
    assert.deepEqual(store.asRules(), []);
    assert.equal(store.list().length, 0);
  });
});

test("闭环:策略规则支持参数作用域(pattern),与内置 projectRules 体验一致", async () => {
  await withStore(({ store }) => {
    // 用户可在 mcp-policy.json 里手写带 pattern 的规则(与内置 projectRules 同格式)
    const rules = [
      ...store.asRules(),
      { id: "mcp-policy:project:mcp__fs__write_file", tool: "mcp__fs__write_file", pattern: "src/**", decision: "allow" }
    ];
    const base = { name: "mcp__fs__write_file", category: "mutate", autoApprove: false };
    const decide = (p) => engine.decide({ ...base, params: p }, createPolicyContext({ autonomy: "read-only", projectRules: rules }));

    assert.equal(decide({ path: "src/a.js" }).decision, "allow", "pattern 内放行");
    assert.equal(decide({ path: "docs/readme.md" }).decision, "deny", "pattern 外不得放行");
  });
});

test("闭环:normalizeApprovalScope 与 policyKey 契约", () => {
  assert.equal(normalizeApprovalScope("ALWAYS"), "always");
  assert.equal(normalizeApprovalScope("nope"), null);
  assert.equal(policyKey("mcp__a__b"), "tool:mcp__a__b");
  assert.deepEqual(policyGrantsAsRules({ [policyKey("t")]: { tool: "t" } }, "project")[0].tool, "t");
});
