import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { createEditService } from "../../../src/edits/edit-service.js";
import { makeUnifiedDiff, mergeSubtask } from "../../../src/core/orchestration/merge-back.js";
import { hashTree } from "../../../src/core/orchestration/workspace-snapshot.js";
import { mkdtemp } from "../../helpers/tmp.js";

async function tmp() { return mkdtemp(path.join(os.tmpdir(), "merge-")); }

test("makeUnifiedDiff modify roundtrips through the real edit service", async () => {
  const main = await tmp();
  await fs.writeFile(path.join(main, "a.js"), "old line\n");
  const diff = makeUnifiedDiff("a.js", "old line\n", "new line\n");
  const svc = createEditService({ projectRoot: main });
  const res = await svc.apply({ diff });
  assert.equal(res.status, "success");
  assert.equal(await fs.readFile(path.join(main, "a.js"), "utf8"), "new line\n");
});

test("makeUnifiedDiff add creates a new file through the edit service", async () => {
  const main = await tmp();
  const diff = makeUnifiedDiff("nested/b.js", null, "fresh\n");
  const svc = createEditService({ projectRoot: main });
  const res = await svc.apply({ diff });
  assert.equal(res.status, "success");
  assert.equal(await fs.readFile(path.join(main, "nested/b.js"), "utf8"), "fresh\n");
});

test("mergeSubtask applies disjoint iso changes; CAS conflict if main diverged", async () => {
  const main = await tmp(); const iso = await tmp();
  await fs.writeFile(path.join(main, "a.js"), "base\n");
  await fs.writeFile(path.join(iso, "a.js"), "base\n");
  const baseManifest = await hashTree(iso, {});
  await fs.writeFile(path.join(iso, "a.js"), "worker edit\n");          // worker changed it in iso
  const actual = { added: [], deleted: [], modified: ["a.js"] };
  const svc = createEditService({ projectRoot: main });

  const ok = await mergeSubtask({ editService: svc, mainRoot: main, isoRoot: iso, baseManifest, actual });
  assert.equal(ok.ok, true);
  assert.equal(await fs.readFile(path.join(main, "a.js"), "utf8"), "worker edit\n");

  // diverge main, merge a fresh iso edit -> CAS conflict, main untouched
  const iso2 = await tmp(); await fs.writeFile(path.join(iso2, "a.js"), "base\n");
  const base2 = await hashTree(iso2, {});
  await fs.writeFile(path.join(iso2, "a.js"), "iso2 edit\n");
  await fs.writeFile(path.join(main, "a.js"), "user changed main\n");   // diverged from base2
  const conflict = await mergeSubtask({ editService: svc, mainRoot: main, isoRoot: iso2, baseManifest: base2, actual: { added: [], deleted: [], modified: ["a.js"] } });
  assert.equal(conflict.ok, false);
  assert.equal(await fs.readFile(path.join(main, "a.js"), "utf8"), "user changed main\n");
});
