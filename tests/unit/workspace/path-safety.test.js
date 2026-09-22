import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveWorkspacePath,
  readWorkspaceTextFile,
  walkWorkspaceFiles,
  normalizeRelativePath
} from "../../../src/workspace/path-safety.js";
import { symlinkTraversalSupported, SYMLINK_SKIP_REASON } from "../../helpers/symlink-capability.js";

test("resolveWorkspacePath keeps relative paths inside project root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-"));
  await writeFile(path.join(root, "README.md"), "hello");

  const resolved = await resolveWorkspacePath(root, "README.md", { mustExist: true });

  assert.equal(resolved.relative, "README.md");
  assert.equal(resolved.absolute, path.join(root, "README.md"));
});

test("resolveWorkspacePath rejects lexical path traversal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-"));

  await assert.rejects(
    () => resolveWorkspacePath(root, "../outside.txt"),
    /escapes project root/
  );
});

test("resolveWorkspacePath rejects symlink escape", async (t) => {
  if (!(await symlinkTraversalSupported())) { t.skip(SYMLINK_SKIP_REASON); return; }
  const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-"));
  const outside = await mkdtemp(path.join(tmpdir(), "dsc-out-"));
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await symlink(outside, path.join(root, "link"), "junction");

  await assert.rejects(
    () => resolveWorkspacePath(root, "link/secret.txt", { mustExist: true }),
    /escapes project root/
  );
});

test("resolveWorkspacePath allows new files under existing safe ancestor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-"));
  await mkdir(path.join(root, "src"));

  const resolved = await resolveWorkspacePath(root, "src/new-file.js");

  assert.equal(resolved.relative, "src/new-file.js");
});

test("readWorkspaceTextFile rejects binary and large files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-"));
  await writeFile(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(root, "large.txt"), "x".repeat(20));

  await assert.rejects(
    () => readWorkspaceTextFile(root, "bin.dat"),
    /binary/
  );
  await assert.rejects(
    () => readWorkspaceTextFile(root, "large.txt", { maxBytes: 10 }),
    /too large/
  );
});

test("walkWorkspaceFiles returns normalized relative file paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "app.js"), "console.log(1)");
  await writeFile(path.join(root, "README.md"), "readme");

  const files = await walkWorkspaceFiles(root, ".", { maxFiles: 10 });

  assert.deepEqual(files.sort(), ["README.md", "src/app.js"].sort());
});

test("normalizeRelativePath uses forward slashes and rejects empty paths", () => {
  assert.equal(normalizeRelativePath("src\\app.js"), "src/app.js");
  assert.throws(() => normalizeRelativePath(""), /path is required/);
});
