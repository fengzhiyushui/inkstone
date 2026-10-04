import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createSymbolCache } from "../../../src/context/semantic/symbol-cache.js";
import { mkdtemp } from "../../helpers/tmp.js";

async function tmp() { return mkdtemp(path.join(os.tmpdir(), "symcache-")); }

test("set/get round-trips only on matching hash", async () => {
  const root = await tmp();
  const cache = createSymbolCache({ cacheRoot: root });
  const pr = { file: "src/a.js", language: "js", symbols: [{ name: "x" }], imports: [], exports: [], calls: [], ok: true };
  await cache.set("src/a.js", "h1", pr);
  assert.deepEqual((await cache.get("src/a.js", "h1")).symbols, [{ name: "x" }]);
  assert.equal(await cache.get("src/a.js", "h2"), null); // hash mismatch -> miss
});
