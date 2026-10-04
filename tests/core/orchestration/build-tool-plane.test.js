import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os"; import path from "node:path"; import { promises as fs } from "node:fs";
import { buildToolPlane } from "../../../src/index.js";
import { mkdtemp } from "../../helpers/tmp.js";

test("buildToolPlane returns a plane bound to the given root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plane-"));
  const plane = buildToolPlane(root, {});
  assert.equal(typeof plane.execute, "function");
  assert.ok(plane.toolRegistry.toDeepSeekTools().some((s) => s.function.name === "read"));
  // editService is bound to `root`: applying a new-file diff lands the file under root
  const diff = "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n";
  const res = await plane.editService.apply({ diff });
  assert.equal(res.status, "success");
  assert.equal(await fs.readFile(path.join(root, "new.txt"), "utf8"), "hello\n");
});
