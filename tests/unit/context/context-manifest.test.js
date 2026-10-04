import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createEmptyManifest,
  loadContextManifest,
  saveContextManifest,
  sanitizeManifestRecord,
  projectRootHash
} from "../../../src/context/context-manifest.js";
import { mkdtemp } from "../../helpers/tmp.js";

test("createEmptyManifest creates schema v1 metadata container", () => {
  const manifest = createEmptyManifest({ root: "/repo", now: "2026-05-31T00:00:00.000Z" });

  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.project_root_hash, projectRootHash("/repo"));
  assert.equal(manifest.created_at, "2026-05-31T00:00:00.000Z");
  assert.deepEqual(manifest.files, {});
});

test("sanitizeManifestRecord strips snippets content and absolute fields", () => {
  const record = sanitizeManifestRecord({
    path: "src/index.js",
    hash: "sha256:abc",
    bytes: 10,
    token_count: 3,
    priority: 2,
    reason: "source",
    mtime_ms: 123,
    size: 10,
    indexed_at: "2026-05-31T00:00:00.000Z",
    snippet: "secret code",
    content: "secret code",
    absolute: "C:/repo/src/index.js"
  });

  assert.deepEqual(Object.keys(record).sort(), [
    "bytes",
    "hash",
    "indexed_at",
    "mtime_ms",
    "path",
    "priority",
    "reason",
    "size",
    "token_count"
  ]);
  assert.equal(JSON.stringify(record).includes("secret code"), false);
  assert.equal(JSON.stringify(record).includes("C:/repo"), false);
});

test("saveContextManifest writes metadata-only json and loadContextManifest reads it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-manifest-"));
  const manifestPath = path.join(root, "context", "manifest.json");
  const manifest = createEmptyManifest({ root, now: "2026-05-31T00:00:00.000Z" });
  manifest.files["src/index.js"] = sanitizeManifestRecord({
    path: "src/index.js",
    hash: "sha256:abc",
    bytes: 10,
    token_count: 3,
    priority: 2,
    reason: "source",
    mtime_ms: 123,
    size: 10,
    indexed_at: "2026-05-31T00:00:00.000Z",
    snippet: "must not persist"
  });

  await saveContextManifest({ manifestPath, manifest });
  const raw = await readFile(manifestPath, "utf8");
  const loaded = await loadContextManifest({ manifestPath, root });

  assert.equal(raw.includes("must not persist"), false);
  assert.equal(loaded.files["src/index.js"].hash, "sha256:abc");
});

test("loadContextManifest tolerates missing corrupt and root-mismatched manifests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-manifest-corrupt-"));
  const manifestPath = path.join(root, "manifest.json");

  assert.deepEqual((await loadContextManifest({ manifestPath, root })).files, {});

  await writeFile(manifestPath, "{bad json");
  assert.deepEqual((await loadContextManifest({ manifestPath, root })).files, {});

  await writeFile(manifestPath, JSON.stringify({
    schema_version: 1,
    project_root_hash: projectRootHash("/other"),
    files: { "a.txt": { path: "a.txt" } }
  }));
  assert.deepEqual((await loadContextManifest({ manifestPath, root })).files, {});
});
