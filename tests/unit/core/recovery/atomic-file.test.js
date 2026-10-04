import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  atomicReadJson,
  atomicWriteBytes,
  atomicWriteJson,
  cleanupAtomicTemps,
  safeRecoverySegment
} from "../../../../src/core/recovery/atomic-file.js";
import { mkdtemp } from "../../../helpers/tmp.js";

test("atomicWriteJson writes readable JSON and ignores temp leftovers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-atomic-json-"));
  const target = path.join(root, "state.json");

  await atomicWriteJson(target, { schema_version: 1, value: "ok" });
  const loaded = await atomicReadJson(target);

  assert.deepEqual(loaded, { schema_version: 1, value: "ok" });
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".recovery-tmp-")), []);
});

test("atomicWriteBytes preserves binary bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-atomic-bytes-"));
  const target = path.join(root, "blob.bin");
  const bytes = Buffer.from([0, 255, 12, 10, 65]);

  await atomicWriteBytes(target, bytes);

  assert.deepEqual(await readFile(target), bytes);
});

test("cleanupAtomicTemps removes only helper-shaped recovery temp regular files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-atomic-clean-"));
  const helperTemp = ".recovery-tmp-123-00000000-0000-4000-8000-000000000000";
  const unrelatedTemp = ".recovery-tmp-not-from-helper";
  const tempDirectory = ".recovery-tmp-dir";
  await writeFile(path.join(root, helperTemp), Buffer.from("tmp"));
  await writeFile(path.join(root, unrelatedTemp), Buffer.from("keep"));
  await mkdir(path.join(root, tempDirectory));
  await atomicWriteBytes(path.join(root, "keep.txt"), Buffer.from("keep"));

  const removed = await cleanupAtomicTemps(root);
  const remaining = await readdir(root);

  assert.deepEqual(removed, [helperTemp]);
  assert.equal(remaining.includes(helperTemp), false);
  assert.equal(remaining.includes(unrelatedTemp), true);
  assert.equal(remaining.includes(tempDirectory), true);
  assert.equal(remaining.includes("keep.txt"), true);
});

test("safeRecoverySegment rejects traversal and unsafe values while keeping portable ids", () => {
  assert.equal(safeRecoverySegment("tx_123"), "tx_123");
  assert.throws(() => safeRecoverySegment("../evil"), /invalid recovery path segment/);
  assert.throws(() => safeRecoverySegment(""), /invalid recovery path segment/);
  assert.throws(() => safeRecoverySegment("."), /invalid recovery path segment/);
  assert.throws(() => safeRecoverySegment(".."), /invalid recovery path segment/);
  assert.throws(() => safeRecoverySegment(null), /invalid recovery path segment/);
  assert.throws(() => safeRecoverySegment(123), /invalid recovery path segment/);
});
