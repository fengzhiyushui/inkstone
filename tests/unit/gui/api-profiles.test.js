import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApiProfiles, maskKey } from "../../../src/apps/api-profiles.js";
import { mkdtemp } from "../../helpers/tmp.js";

async function tmp() { return mkdtemp(path.join(os.tmpdir(), "dsc-api-")); }

test("save assigns id, activate persists activeId, remove drops", async () => {
  const store = createApiProfiles({ dir: await tmp() });
  const p = await store.save({ name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-abc123" });
  assert.ok(p.id);
  assert.equal((await store.list()).length, 1);
  await store.activate(p.id);
  assert.equal((await store.getActive()).id, p.id);
  await store.remove(p.id);
  assert.equal((await store.list()).length, 0);
  assert.equal(await store.getActive(), null);
});

test("save with id edits in place; ids do not collide across add/remove", async () => {
  const store = createApiProfiles({ dir: await tmp() });
  const a = await store.save({ name: "a", baseUrl: "u1", apiKey: "k1" });
  await store.save({ id: a.id, name: "a2", baseUrl: "u1", apiKey: "k1" });
  assert.equal((await store.list())[0].name, "a2");
  await store.remove(a.id);
  const b = await store.save({ name: "b", baseUrl: "u2", apiKey: "k2" });
  assert.notEqual(b.id, a.id); // monotonic seq, no reuse
});

test("activate unknown id throws", async () => {
  const store = createApiProfiles({ dir: await tmp() });
  await assert.rejects(() => store.activate("nope"));
});

test("maskKey masks all shapes", () => {
  assert.equal(maskKey(""), "");
  assert.equal(maskKey("short"), "•••");
  assert.equal(maskKey("sk-1234567890abcd"), "sk-…abcd");
});
