import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "../helpers/tmp.js";
import {
  APPROVAL_SCOPES,
  normalizeToolPolicy,
  normalizeApprovalScope,
  normalizeRiskOverride,
  isToolEnabled,
  resolveConfiguredScope,
  validateApprovalScope,
  policyKey,
  policyGrantsAsRules,
  createPolicyStore
} from "../../src/tools/mcp/tool-policy.js";

// ── D5:工具级开关 ──────────────────────────────────────────────────────────
test("normalizeToolPolicy:默认全开,disabled 优先", () => {
  const empty = { enabled: ["*"], disabled: [], approval: {}, risk: {} };
  assert.deepEqual(normalizeToolPolicy(null), empty);
  assert.deepEqual(normalizeToolPolicy({ enabled: ["a", "b"] }), { ...empty, enabled: ["a", "b"] });
  assert.deepEqual(normalizeToolPolicy({ disabled: ["x"] }), { ...empty, disabled: ["x"] });
});

test("normalizeToolPolicy:用户风险覆盖只收合法值", () => {
  const p = normalizeToolPolicy({ risk: { a: "read", b: "READ", c: "nonsense", d: 42 } });
  assert.deepEqual(p.risk, { a: "read", b: "read" }, "大小写归一,非法/非字符串忽略");
  assert.equal(normalizeRiskOverride("destructive"), "destructive");
  assert.equal(normalizeRiskOverride(null), null);
  assert.equal(normalizeRiskOverride("bogus"), null);
});

test("isToolEnabled:白名单/黑名单/全开三种模式", () => {
  const allow = normalizeToolPolicy({ enabled: ["read_doc", "list"] });
  assert.equal(isToolEnabled(allow, "read_doc"), true);
  assert.equal(isToolEnabled(allow, "delete"), false);

  const deny = normalizeToolPolicy({ enabled: ["*"], disabled: ["delete"] });
  assert.equal(isToolEnabled(deny, "delete"), false, "disabled 优先于 *");
  assert.equal(isToolEnabled(deny, "anything"), true);
});

test("resolveConfiguredScope:只接受合法 scope", () => {
  const p = normalizeToolPolicy({ approval: { a: "always", b: "nonsense", c: "PROJECT" } });
  assert.equal(resolveConfiguredScope(p, "a"), "always");
  assert.equal(resolveConfiguredScope(p, "b"), null, "非法值按未配置处理");
  assert.equal(resolveConfiguredScope(p, "c"), "project", "大小写归一");
  assert.equal(resolveConfiguredScope(p, "zzz"), null);
});

test("isToolEnabled/resolveConfiguredScope 接受未归一化的原始 tools 字段", () => {
  // 回归:hub 早期直接透传 raw({ disabled:[...] }),enabled 为 undefined 会让
  // .includes 抛错,导致整台 server 的工具全部挂载失败。
  const raw = { disabled: ["quiet_tool"] };
  assert.equal(isToolEnabled(raw, "lookup_doc"), true, "仅 disabled 时应默认全开");
  assert.equal(isToolEnabled(raw, "quiet_tool"), false);

  const rawApproval = { approval: { lookup_doc: "always" } };
  assert.equal(resolveConfiguredScope(rawApproval, "lookup_doc"), "always");

  // 边界:null / 标量 / 数组都不应抛错
  assert.equal(isToolEnabled(null, "x"), true);
  assert.equal(isToolEnabled(undefined, "x"), true);
  assert.equal(isToolEnabled([], "x"), true);
  assert.equal(resolveConfiguredScope(null, "x"), null);
  assert.equal(resolveConfiguredScope("nope", "x"), null);
});

test("normalizeApprovalScope 契约", () => {
  assert.deepEqual([...APPROVAL_SCOPES], ["session", "project", "always"]);
  assert.equal(normalizeApprovalScope("always"), "always");
  assert.equal(normalizeApprovalScope(null), null);
  assert.equal(normalizeApprovalScope("forever"), null);
});

// ── D4:destructive 硬约束(核心安全不变量) ──────────────────────────────────
test("destructive 只允许 session;project/always 被拒并给出 fallback", () => {
  for (const scope of ["project", "always"]) {
    const r = validateApprovalScope({ category: "destructive", scope, toolName: "wipe_db" });
    assert.equal(r.ok, false, `${scope} 必须被拒绝`);
    assert.equal(r.scope, "session", "fallback 到 session");
    assert.equal(r.locked, true, "须标记为硬约束拒绝,便于界面提示原因");
    assert.match(r.reason, /destructive/);
  }
});

test("destructive 显式要 session 时放行(仅本次),且不算锁定", () => {
  const r = validateApprovalScope({ category: "destructive", scope: "session", toolName: "wipe_db" });
  assert.equal(r.ok, true);
  assert.equal(r.scope, "session");
  assert.equal(r.locked ?? false, false);
});

test("非 destructive 可授予 project / always", () => {
  for (const category of ["read", "mutate"]) {
    for (const scope of ["session", "project", "always"]) {
      const r = validateApprovalScope({ category, scope, toolName: "t" });
      assert.equal(r.ok, true, `${category}/${scope} 应放行`);
      assert.equal(r.scope, scope);
    }
  }
});

test("缺省 scope 视为 session", () => {
  const r = validateApprovalScope({ category: "mutate", scope: undefined });
  assert.equal(r.ok, true);
  assert.equal(r.scope, "session");
});

// ── D3:策略持久化 ──────────────────────────────────────────────────────────
async function withStore(fn) {
  const base = await mkdtemp(path.join(tmpdir(), "dsc-mcp-policy-"));
  try {
    await fn({
      store: createPolicyStore({ projectRoot: path.join(base, "project"), userRoot: path.join(base, "user") }),
      projectFile: path.join(base, "project", ".deepseek-code", "mcp-policy.json"),
      // 用户级路径统一落在 <userRoot>/.deepseek-code/mcp-policy.json(与项目级同构)
      userFile: path.join(base, "user", ".deepseek-code", "mcp-policy.json"),
      base
    });
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

test("策略持久化:project 与 always 落到各自文件并可读回", async () => {
  await withStore(async ({ store, projectFile, userFile }) => {
    assert.equal(store.grant("read_doc", "project").ok, true);
    assert.equal(store.grant("list_dir", "always").ok, true);
    // session 不落盘
    assert.equal(store.grant("x", "session").ok, false);

    const list = store.list();
    assert.equal(list.find((g) => g.tool === "read_doc").scope, "project");
    assert.equal(list.find((g) => g.tool === "list_dir").scope, "always");

    // 文件真的写下来了,user 级收紧为 0600
    const raw = JSON.parse(readFileSync(userFile, "utf8"));
    assert.ok(raw.grants[policyKey("list_dir")]);
    assert.ok(readFileSync(projectFile, "utf8").includes("read_doc"));
  });
});

// ── v1.13.1:授权翻译成引擎規則(消掉平行规则源) ─────────────────────────────
test("policyGrantsAsRules:产出引擎可消费的 {id,tool,decision} 规则", () => {
  const grants = { [policyKey("mcp__s__read_doc")]: { tool: "mcp__s__read_doc", scope: "project" } };
  const rules = policyGrantsAsRules(grants, "project");

  assert.equal(rules.length, 1);
  assert.deepEqual(
    { id: rules[0].id, tool: rules[0].tool, decision: rules[0].decision },
    { id: "mcp-policy:project:mcp__s__read_doc", tool: "mcp__s__read_doc", decision: "allow" }
  );
  assert.deepEqual(rules[0].meta, { source: "mcp-policy", scope: "project" });
});

test("policyGrantsAsRules:忽略非工具级 key", () => {
  assert.deepEqual(policyGrantsAsRules({ other: { tool: "x" } }), []);
  assert.deepEqual(policyGrantsAsRules(null), []);
  assert.deepEqual(policyGrantsAsRules(undefined, "always"), []);
});

test("asRules:用户级(always)先于项目级(project) —— 顺序即优先级", async () => {
  await withStore(async ({ store }) => {
    store.grant("proj_only", "project");
    store.grant("user_only", "always");
    const rules = store.asRules();

    assert.equal(rules.length, 2);
    assert.equal(rules[0].tool, "user_only", "always 必须在前面:引擎首条命中即返回");
    assert.equal(rules[0].meta.scope, "always");
    assert.equal(rules[1].tool, "proj_only");
  });
});

test("策略持久化:revoke 移除对应 scope 的授权", async () => {
  await withStore(async ({ store }) => {
    store.grant("a", "always");
    store.grant("a", "project");
    assert.equal(store.asRules().length, 2);

    store.revoke("a", "always");
    assert.equal(store.asRules().length, 1, "project 级仍在");
    assert.equal(store.asRules()[0].meta.scope, "project");

    store.revoke("a", "project");
    assert.equal(store.asRules().length, 0);
  });
});

test("策略持久化:损坏的策略文件按空表处理(不崩)", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "dsc-mcp-policy-"));
  const dir = path.join(base, "project", ".deepseek-code");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "mcp-policy.json"), "{ broken json", "utf8");
    const store = createPolicyStore({ projectRoot: path.join(base, "project"), userRoot: path.join(base, "user") });
    assert.deepEqual(store.asRules(), [], "损坏文件 → 空规则,回到默认保守");
    // 仍然可以继续写入
    assert.equal(store.grant("ok_tool", "project").ok, true);
    assert.equal(store.asRules().length, 1);
    assert.deepEqual(store.list().map((g) => g.tool), ["ok_tool"]);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test("策略持久化:无 projectRoot 时 project scope 明确失败", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "dsc-mcp-policy-"));
  try {
    const store = createPolicyStore({ projectRoot: null, userRoot: path.join(base, "user") });
    const r = store.grant("a", "project");
    assert.equal(r.ok, false);
    assert.equal(store.grant("a", "always").ok, true, "always 仍可用");
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
