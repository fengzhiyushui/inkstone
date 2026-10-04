import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { createToolCall } from "../../src/core/protocol/index.js";
import { mkdtemp } from "../helpers/tmp.js";

const MODIFY_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

test("kernel diff_preview parses diff without modifying files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-edit-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, { sessionId: "sess_edit_preview" });

  const result = await kernel.tools.execute(
    createToolCall({ name: "diff_preview", params: { diff: MODIFY_DIFF }, requestedByStepId: "step_1" }),
    { autonomy: "gated", turnId: "turn_1" }
  );

  assert.equal(result.status, "success");
  assert.match(result.content[0].text, /modify a\.txt/);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
});

test("kernel diff_apply writes a file and emits edit events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-edit-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, { sessionId: "sess_edit_apply" });
  const events = [];
  const sub = kernel.session.subscribe((event) => events.push(event));

  const result = await kernel.tools.execute(
    createToolCall({
      name: "diff_apply",
      params: { diff: MODIFY_DIFF, prompt: "update a", approval_id: "appr_1" },
      requestedByStepId: "step_1"
    }),
    { autonomy: "gated", turnId: "turn_1" }
  );
  sub.unsubscribe();

  assert.equal(result.status, "success");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "new\n");
  assert.match(result.metadata.change_id, /^\d{14}-[a-f0-9]{6}$/);
  assert.ok(events.some((event) => event.type === "tool:call"));
  assert.ok(events.some((event) => event.type === "file:diff_applied"));
  assert.ok(events.some((event) => event.type === "tool:result"));
});

test("kernel diff_rollback restores an applied change", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-edit-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, { sessionId: "sess_edit_rollback" });

  const applied = await kernel.tools.execute(
    createToolCall({ name: "edit", params: { diff: MODIFY_DIFF, prompt: "update a" }, requestedByStepId: "step_1" }),
    { autonomy: "gated", turnId: "turn_1" }
  );
  const rolledBack = await kernel.tools.execute(
    createToolCall({ name: "diff_rollback", params: { change_id: applied.metadata.change_id }, requestedByStepId: "step_2" }),
    { autonomy: "gated", turnId: "turn_1" }
  );

  assert.equal(rolledBack.status, "success");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
});

test("kernel edit tool returns approval_required under supervised autonomy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-edit-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, { sessionId: "sess_edit_approval" });

  const result = await kernel.tools.execute(
    createToolCall({ name: "diff_apply", params: { diff: MODIFY_DIFF }, requestedByStepId: "step_1" }),
    { autonomy: "supervised", turnId: "turn_1" }
  );

  assert.equal(result.status, "approval_required");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
});

test("kernel diff_rollback blocks dirty file without force", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-edit-dirty-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, {
    sessionId: "sess_edit_dirty",
    sessionLog: null,
    context: { disabled: true }
  });
  const applied = await kernel.tools.execute(
    createToolCall({ name: "edit", params: { diff: MODIFY_DIFF, prompt: "update a" }, requestedByStepId: "step_1" }),
    { autonomy: "gated", turnId: "turn_1" }
  );
  await writeFile(path.join(root, "a.txt"), "manual change\n");

  const rolledBack = await kernel.tools.execute(
    createToolCall({ name: "diff_rollback", params: { change_id: applied.metadata.change_id }, requestedByStepId: "step_2" }),
    { autonomy: "gated", turnId: "turn_1" }
  );

  assert.equal(rolledBack.status, "conflict");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "manual change\n");
  assert.equal(rolledBack.metadata.conflicts.length, 1);
});

test("kernel diff_rollback force restores dirty file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-kernel-edit-force-"));
  await writeFile(path.join(root, "a.txt"), "old\n");
  const kernel = await createKernel(root, {
    sessionId: "sess_edit_force",
    sessionLog: null,
    context: { disabled: true }
  });
  const applied = await kernel.tools.execute(
    createToolCall({ name: "edit", params: { diff: MODIFY_DIFF, prompt: "update a" }, requestedByStepId: "step_1" }),
    { autonomy: "gated", turnId: "turn_1" }
  );
  await writeFile(path.join(root, "a.txt"), "manual change\n");

  const rolledBack = await kernel.tools.execute(
    createToolCall({
      name: "diff_rollback",
      params: { change_id: applied.metadata.change_id, force: true },
      requestedByStepId: "step_2"
    }),
    { autonomy: "gated", turnId: "turn_1" }
  );

  assert.equal(rolledBack.status, "success");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  assert.equal(rolledBack.metadata.forced, true);
});
