import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAnnotations,
  annotationsFromTool,
  resolveToolRisk,
  riskBadge,
  ANNOTATION_KEYS,
  RISK_LADDER
} from "../../src/tools/mcp/annotations.js";

// ── D1:annotations 解析 ────────────────────────────────────────────────────
test("parseAnnotations:只有显式 true 才命中,缺省与非布尔一律 false", () => {
  assert.deepEqual(
    parseAnnotations(null),
    { readOnly: false, destructive: false, openWorld: false, idempotent: false, present: false, title: null }
  );
  assert.deepEqual(
    parseAnnotations({ readOnlyHint: "true", destructiveHint: 1, openWorldHint: "yes" }),
    { readOnly: false, destructive: false, openWorld: false, idempotent: false, present: false, title: null }
  );
  const parsed = parseAnnotations({ readOnlyHint: true, openWorldHint: true, title: "My Tool" });
  assert.equal(parsed.readOnly, true);
  assert.equal(parsed.openWorld, true);
  assert.equal(parsed.present, true);
  assert.equal(parsed.title, "My Tool");
});

test("parseAnnotations:数组/标量输入安全降级", () => {
  assert.equal(parseAnnotations([]).present, false);
  assert.equal(parseAnnotations("readOnly").present, false);
  assert.equal(parseAnnotations(42).present, false);
  assert.equal(parseAnnotations(undefined).present, false);
});

test("parseAnnotations:destructiveHint 与 readOnlyHint 可同时上报,不互相抵消", () => {
  const parsed = parseAnnotations({ readOnlyHint: true, destructiveHint: true });
  assert.equal(parsed.readOnly, true);
  assert.equal(parsed.destructive, true, "解析层不得自行取舍,冲突留给 resolveToolRisk 按失败优先处理");
});

test("annotationsFromTool:兼容摊在 tool 顶层的字段", () => {
  assert.equal(annotationsFromTool({ annotations: { readOnlyHint: true } }).readOnly, true);
  assert.equal(annotationsFromTool({ readOnlyHint: true }).readOnly, true);
  assert.equal(annotationsFromTool({}).present, false);
  assert.equal(annotationsFromTool(null).present, false);
});

test("ANNOTATION_KEYS 与 RISK_LADDER 契约稳定", () => {
  assert.deepEqual([...ANNOTATION_KEYS], ["readOnlyHint", "destructiveHint", "openWorldHint", "idempotentHint"]);
  assert.deepEqual([...RISK_LADDER], ["read", "mutate", "destructive"]);
});

// ── D2:信任模型(annotations 不可信,除非 server 受信) ───────────────────────
test("不受信 server:annotations 完全不参与判定", () => {
  // 一个叫 delete_file 的工具,server 谎称 readOnlyHint —— 不受信时不得降级
  const r = resolveToolRisk({
    name: "delete_file",
    description: "Deletes a file from disk",
    annotations: { readOnlyHint: true },
    trusted: false
  });
  assert.notEqual(r.category, "read");
  assert.equal(r.source, "keyword-untrusted");
  assert.equal(r.trusted, false);
});

test("不受信 server:连 destructiveHint 也不采用(避免被用来误报),纯靠关键词", () => {
  // destructiveHint 在不受信时只是提示,不作为升级依据 —— 但关键词兜底仍覆盖这类命名
  const r = resolveToolRisk({
    name: "purge_all",
    description: "removes everything",
    annotations: { readOnlyHint: true },
    trusted: false
  });
  assert.equal(r.category, "destructive", "关键词已足以判定破坏性,不受信也不得降级");
  assert.equal(r.source, "keyword-untrusted");
});

test("受信 server + readOnlyHint:降为 read(可配置自动放行)", () => {
  const r = resolveToolRisk({
    name: "read_doc",
    description: "Reads a document",
    annotations: { readOnlyHint: true },
    trusted: true
  });
  assert.equal(r.category, "read");
  assert.equal(r.source, "annotations");
  assert.deepEqual(r.escalatedBy, ["readOnlyHint"]);
});

test("受信 server:readOnlyHint 不得把已判定为写操作的工具降级(防误放行)", () => {
  // 关键词认为要写,server 却说是只读 —— 以关键词为准,不允许降级
  const r = resolveToolRisk({
    name: "delete_record",
    description: "Deletes a record",
    annotations: { readOnlyHint: true },
    trusted: true
  });
  assert.equal(r.category, "mutate");
  assert.deepEqual(r.escalatedBy, [], "不得因 readOnlyHint 记录降级");
});

test("受信 server + destructiveHint:一律 destructive(硬约束)", () => {
  const r = resolveToolRisk({
    name: "run_cleanup",
    description: "Cleanup task",
    annotations: { destructiveHint: true },
    trusted: true
  });
  assert.equal(r.category, "destructive", "destructive 永不自动放行");
  assert.deepEqual(r.escalatedBy, ["destructiveHint"]);
});

test("受信 server:destructiveHint 与 readOnlyHint 并存时 destructive 优先(失败优先)", () => {
  const r = resolveToolRisk({
    name: "some_tool",
    description: "",
    annotations: { readOnlyHint: true, destructiveHint: true },
    trusted: true
  });
  assert.equal(r.category, "destructive", "冲突信号按失败优先,不得降级为只读");
});

test("受信 server + openWorldHint:风险 +1", () => {
  const r = resolveToolRisk({
    name: "lookup",
    description: "looks things up",
    annotations: { openWorldHint: true },
    trusted: true
  });
  assert.equal(r.category, "mutate", "read 应升一级为 mutate");
  assert.deepEqual(r.escalatedBy, ["openWorldHint"]);
});

test("受信 server + openWorldHint:不会把 destructive 再往上推(已封顶)", () => {
  // 用无害命名,确保 destructiveHint 是真正执行升级的那个信号
  const r = resolveToolRisk({
    name: "cleanup_task",
    description: "routine task",
    annotations: { destructiveHint: true, openWorldHint: true },
    trusted: true
  });
  assert.equal(r.category, "destructive");
  assert.deepEqual(r.escalatedBy, ["destructiveHint"], "已封顶,不再叠加 openWorld");
});

test("无 annotations 时回到关键词兜底(feign keyword path)", () => {
  const r = resolveToolRisk({ name: "delete_file", description: "", trusted: true });
  assert.equal(r.category, "mutate");
  assert.equal(r.source, "keyword");
  assert.equal(r.trusted, true);
});

test("repairRisk:parseAnnotations 结果可直接复用(present 标记", () => {
  const parsed = parseAnnotations({ readOnlyHint: true });
  const r = resolveToolRisk({
    name: "read_doc",
    description: "",
    annotations: parsed,
    trusted: true
  });
  assert.equal(r.category, "read", "已解析对象不应被二次解析破坏");
  assert.equal(r.annotations.readOnly, true);
});

// ── 展示层 ─────────────────────────────────────────────────────────────────
test("riskBadge 三档", () => {
  assert.deepEqual(riskBadge("destructive"), { level: "danger", label: "破坏性" });
  assert.deepEqual(riskBadge("mutate"), { level: "warn", label: "写操作" });
  assert.deepEqual(riskBadge("read"), { level: "ok", label: "只读" });
  assert.deepEqual(riskBadge("unknown"), { level: "ok", label: "只读" }, "未知档位按最保守展示");
});
