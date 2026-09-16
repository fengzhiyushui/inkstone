import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../../src/index.js";
import { createEditService } from "../../../src/edits/edit-service.js";
import { createChangeStore } from "../../../src/edits/change-store.js";
import { normalizeEdits, DEFAULT_CONFIG } from "../../../src/config.js";
import { buildKernelOptions } from "../../../src/apps/kernel-options.js";
import { createToolCall } from "../../../src/core/protocol/index.js";

const DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

test("normalizeEdits defaults match DEFAULT_CONFIG", () => {
  const out = normalizeEdits(undefined);
  assert.deepEqual(out, DEFAULT_CONFIG.edits);
  assert.equal(out.maxCaptureBytes, 1024 * 1024);
  assert.deepEqual(out.changeRetention, { maxRecords: 200, maxAgeDays: 90 });
});

test("normalizeEdits keeps partial changeRetention fields and fills defaults", () => {
  const out = normalizeEdits({ changeRetention: { maxRecords: 5 } });
  assert.deepEqual(out.changeRetention, { maxRecords: 5, maxAgeDays: 90 });
});

test("normalizeEdits null disables capture cap and retention", () => {
  const out = normalizeEdits({ maxCaptureBytes: null, changeRetention: null });
  assert.equal(out.maxCaptureBytes, null);
  assert.equal(out.changeRetention, null);
});

test("normalizeEdits ignores invalid maxCaptureBytes", () => {
  assert.equal(normalizeEdits({ maxCaptureBytes: -1 }).maxCaptureBytes, 1024 * 1024);
  assert.equal(normalizeEdits({ maxCaptureBytes: "x" }).maxCaptureBytes, 1024 * 1024);
});

test("createEditService with edits prunes via change-store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edits-wire-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const svc = createEditService({
    projectRoot: root,
    edits: { changeRetention: { maxRecords: 1 } }
  });
  for (let i = 0; i < 3; i += 1) {
    await writeFile(path.join(root, "a.txt"), "old\n");
    await svc.apply({ diff: DIFF, prompt: `c${i}` });
  }
  const entries = (await readdir(path.join(root, ".deepseek-code", "changes")))
    .filter((n) => n.endsWith(".json"));
  assert.equal(entries.length, 1, "changeRetention 应清理到 maxRecords=1");
});

test("createChangeStore default (no edits) does not prune", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-edits-noprune-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const store = createChangeStore({ projectRoot: root });
  const { applyUnifiedDiff } = await import("../../../src/patch.js");
  const { captureChangePlan, finalizeChange } = await import("../../../src/changes.js");
  for (let i = 0; i < 3; i += 1) {
    const plan = await captureChangePlan(root, DIFF, `c${i}`);
    await applyUnifiedDiff(DIFF, root);
    await writeFile(path.join(root, "a.txt"), "old\n");
    await finalizeChange(root, plan);
  }
  const entries = (await readdir(path.join(root, ".deepseek-code", "changes")))
    .filter((n) => n.endsWith(".json"));
  assert.equal(entries.length, 3, "未注入 edits 时保持旧行为、不清理");
});

test("buildKernelOptions forwards config.edits", async () => {
  const opts = await buildKernelOptions("/tmp/unused-root", {}, async () => ({
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com",
    limits: {},
    orchestration: {},
    context: {},
    edits: { maxCaptureBytes: 4096, changeRetention: { maxRecords: 10, maxAgeDays: 7 } }
  }));
  assert.deepEqual(opts.edits, {
    maxCaptureBytes: 4096,
    changeRetention: { maxRecords: 10, maxAgeDays: 7 }
  });
});

test("kernel options.edits wires into editService retention", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-edits-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, {
    sessionId: "sess_edits_wire",
    edits: { changeRetention: { maxRecords: 1 } }
  });
  try {
    for (let i = 0; i < 3; i += 1) {
      await writeFile(path.join(root, "a.txt"), "old\n");
      const result = await kernel.tools.execute(
        createToolCall({
          name: "diff_apply",
          params: { diff: DIFF, prompt: `k${i}`, approval_id: "appr_1" },
          requestedByStepId: "step_1"
        }),
        { autonomy: "gated", turnId: "turn_1" }
      );
      assert.equal(result.status, "success");
    }
    const entries = (await readdir(path.join(root, ".deepseek-code", "changes")))
      .filter((n) => n.endsWith(".json"));
    assert.equal(entries.length, 1, "createKernel 注入的 edits 应生效");
  } finally {
    await kernel.dispose?.();
  }
});
