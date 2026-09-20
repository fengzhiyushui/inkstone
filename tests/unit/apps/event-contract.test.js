import test from "node:test";
import assert from "node:assert/strict";
import { describeEvent } from "../../../src/apps/event-contract.js";

test("malformed input never throws, returns other/quiet", () => {
  for (const bad of [null, undefined, 42, "x", {}, { nope: 1 }]) {
    const d = describeEvent(bad);
    assert.equal(d.kind, "other");
    assert.equal(d.quiet, true);
    assert.equal(d.severity, "info");
    assert.deepEqual(d.fields, {});
  }
});

test("tool:call name alias resolves from three shapes", () => {
  assert.equal(describeEvent({ type: "tool:call", call: { name: "read" } }).fields.name, "read");
  assert.equal(describeEvent({ type: "tool:call", tool: { name: "grep" } }).fields.name, "grep");
  assert.equal(describeEvent({ type: "tool:call", tool: "shell" }).fields.name, "shell");
});

test("tool:call argHint picks first non-empty key in order", () => {
  const d = describeEvent({ type: "tool:call", call: { name: "edit", args: { path: "src/a.js" } } });
  assert.equal(d.fields.argHint, "src/a.js");
  assert.equal(describeEvent({ type: "tool:call", call: { name: "x", args: {} } }).fields.argHint, null);
});

test("tool:call argHint reads executor call.params and joins argv", () => {
  const d = describeEvent({ type: "tool:call", call: { name: "shell", params: { argv: ["git", "status"] } } });
  assert.equal(d.fields.argHint, "git status");
  const path = describeEvent({ type: "tool:call", call: { name: "read", params: { path: "src/a.js" } } });
  assert.equal(path.fields.argHint, "src/a.js");
  const long = describeEvent({ type: "tool:call", call: { name: "shell", params: { argv: ["node", "y".repeat(200)] } } });
  assert.ok(long.fields.argHint.length <= 121);
  assert.match(long.fields.argHint, /…$/);
  assert.equal(describeEvent({ type: "tool:call", call: { name: "x", params: { argv: [] } } }).fields.argHint, null);
});

test("tool:result severity maps ok->success else warn", () => {
  assert.equal(describeEvent({ type: "tool:result", result: { status: "ok" } }).severity, "success");
  assert.equal(describeEvent({ type: "tool:result", status: "error" }).severity, "warn");
});

test("file:diff_applied normalizes files, changeId dual source", () => {
  const d = describeEvent({
    type: "file:diff_applied", change_id: "chg_1",
    files: [{ path: "src/a.js", status: "M", added: 2, removed: 1 }]
  });
  assert.equal(d.kind, "diff");
  assert.equal(d.severity, "success");
  assert.equal(d.fields.changeId, "chg_1");
  assert.deepEqual(d.fields.files[0], { status: "M", path: "src/a.js", added: 2, removed: 1 });
  const alt = describeEvent({ type: "file:diff_applied", record: { id: "chg_2" }, summary: [{ path: "b.js" }] });
  assert.equal(alt.fields.changeId, "chg_2");
  assert.deepEqual(alt.fields.files[0], { status: "M", path: "b.js", added: null, removed: null });
});

test("normFiles accepts string path elements (legacy gui fixture)", () => {
  const d = describeEvent({ type: "file:diff_applied", change_id: "c", files: ["src/a.js"] });
  assert.deepEqual(d.fields.files[0], { status: "M", path: "src/a.js", added: null, removed: null });
});

test("orchestration events map to prefixed kinds with fields", () => {
  assert.deepEqual(describeEvent({ type: "orchestration:routed", lane: "orchestrate" }),
    { kind: "orchestration-route", sourceType: "orchestration:routed", severity: "info", quiet: false, fields: { lane: "orchestrate", score: null } });
  assert.equal(describeEvent({ type: "orchestration:planned", subtasks: 3 }).kind, "orchestration-plan");
  assert.equal(describeEvent({ type: "orchestration:planned", subtasks: 3 }).fields.subtasks, 3);
  assert.equal(describeEvent({ type: "orchestration:round_started", round: 2, subtasks: 4 }).kind, "orchestration-round-start");
  const ss = describeEvent({ type: "orchestration:subtask_started", subtask_id: "s1", attempt: 1, tool_profile: "edit" });
  assert.equal(ss.kind, "orchestration-subtask-start");
  assert.deepEqual(ss.fields, { subtaskId: "s1", attempt: 1, toolProfile: "edit" });
  const sr = describeEvent({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: false, severity: "high" });
  assert.equal(sr.kind, "orchestration-subtask-review");
  assert.equal(sr.severity, "warn");
  assert.deepEqual(sr.fields, { subtaskId: "s1", pass: false, reviewSeverity: "high" });
  const done = describeEvent({ type: "orchestration:completed", rounds: 2, completed: 3, failed: 1, status: "partial" });
  assert.equal(done.kind, "orchestration-complete");
  assert.equal(done.severity, "warn");
  assert.deepEqual(done.fields, { rounds: 2, completed: 3, failed: 1, status: "partial" });
});

test("experience:retrieved quiet when count zero", () => {
  assert.equal(describeEvent({ type: "experience:retrieved", count: 0 }).quiet, true);
  assert.equal(describeEvent({ type: "experience:retrieved", count: 2, tiers: ["T1"] }).quiet, false);
});

test("noisy + context events are quiet", () => {
  for (const type of ["model:request", "model:response", "agent:step", "agent:turn_started",
                      "context:snapshot", "context:cache_loaded", "context:warm"]) {
    assert.equal(describeEvent({ type }).quiet, true, type);
  }
});

test("unknown event falls back to other with sourceType preserved", () => {
  const d = describeEvent({ type: "some:new_thing" });
  assert.equal(d.kind, "other");
  assert.equal(d.sourceType, "some:new_thing");
});

test("file:diff_preview carries changeId(null) and normalized files for gui card", () => {
  const d = describeEvent({ type: "file:diff_preview", summary: [{ path: "src/x.js", status: "modify" }] });
  assert.equal(d.kind, "diff-preview");
  assert.equal(d.fields.changeId, null);
  assert.equal(d.fields.files[0].path, "src/x.js");
});

test("tool:result carries real durationMs (null when absent)", () => {
  assert.equal(describeEvent({ type: "tool:result", id: "c1", result: { status: "ok", durationMs: 38 } }).fields.durationMs, 38);
  assert.equal(describeEvent({ type: "tool:result", id: "c1", result: { status: "ok" } }).fields.durationMs, null);
});

test("model:response maps to a quiet thought descriptor with usage", () => {
  const d = describeEvent({
    type: "model:response", purpose: "plan", model: "deepseek-v4-pro",
    usage: { completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 80 } }
  });
  assert.equal(d.kind, "thought");
  assert.equal(d.quiet, true);
  assert.equal(d.fields.reasoningTokens, 80);
  assert.equal(d.fields.purpose, "plan");
});
