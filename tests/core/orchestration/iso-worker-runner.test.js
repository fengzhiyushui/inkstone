import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createIsoWorkerRunner } from "../../../src/core/orchestration/iso-worker-runner.js";
import { removeIso } from "../../../src/core/orchestration/iso-workspace.js";
import { mkdtemp } from "../../helpers/tmp.js";

async function tmp() { return mkdtemp(path.join(os.tmpdir(), "iso-run-")); }

test("runIsolatedWorker copies, runs worker in iso, reports actual changes; main untouched", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "a.js"), "base\n");
  const runner = createIsoWorkerRunner({
    root,
    buildToolPlane: () => ({ execute: () => {}, toolRegistry: { toDeepSeekTools: () => [{ type: "function", function: { name: "edit" } }] } }),
    createRuntime: (ov) => ({ send: async () => { await fs.writeFile(path.join(ov.projectRoot, "a.js"), "edited\n"); return { status: "complete", content: "did" }; } }),
    makeReviewer: () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) }),
    maxCopyFiles: 5000
  });
  const r = await runner({ subtask: { id: "st_1", goal: "edit a", acceptance: [], context_scope: { files: ["a.js"] }, tool_profile: "edit" }, runId: "run1" });
  assert.deepEqual(r.actual.modified, ["a.js"]);
  assert.equal(r.verdict.pass, true);
  assert.ok(r.isoRoot);
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "base\n");   // main untouched
  await removeIso(r.isoRoot);
});

test("runIsolatedWorker returns {error, isoRoot} on COPY_TOO_BIG (caller cleans up)", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "a.js"), "x\n");
  await fs.writeFile(path.join(root, "b.js"), "y\n");
  const runner = createIsoWorkerRunner({
    root,
    buildToolPlane: () => ({ execute: () => {}, toolRegistry: { toDeepSeekTools: () => [] } }),
    createRuntime: () => ({ send: async () => ({ status: "complete", content: "x" }) }),
    makeReviewer: () => ({ review: async () => ({ pass: true, severity: "warn", reasons: [], checked: [] }) }),
    maxCopyFiles: 1   // forces truncation -> COPY_TOO_BIG
  });
  const r = await runner({ subtask: { id: "st_1", goal: "g", acceptance: [], context_scope: { files: ["a.js"] }, tool_profile: "edit" }, runId: "run2" });
  assert.ok(r.error);
  assert.equal(r.error.code, "COPY_TOO_BIG");
  assert.ok(r.isoRoot);
  await removeIso(r.isoRoot);
});
