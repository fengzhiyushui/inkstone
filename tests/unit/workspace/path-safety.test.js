import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveWorkspacePath,
  readWorkspaceTextFile,
  walkWorkspaceFiles,
  normalizeRelativePath,
  shouldSkipTraversalSegment
} from "../../../src/workspace/path-safety.js";
import { symlinkTraversalSupported, SYMLINK_SKIP_REASON } from "../../helpers/symlink-capability.js";
import { mkdtemp } from "../../helpers/tmp.js";

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

test("walkWorkspaceFiles skips build output and other agents' state dirs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-skip-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "app.js"), "console.log(1)");
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "bundle.js"), "built");
  await mkdir(path.join(root, ".claude"));
  await writeFile(path.join(root, ".claude", "settings.local.json"), "{}");
  await mkdir(path.join(root, ".vscode"));
  await writeFile(path.join(root, ".vscode", "settings.json"), "{}");

  const files = await walkWorkspaceFiles(root, ".", { maxFiles: 50 });

  assert.deepEqual(files, ["src/app.js"]);
});

test("walkWorkspaceFiles honours an explicitly requested skipped directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-explicit-"));
  await mkdir(path.join(root, ".claude"));
  await writeFile(path.join(root, ".claude", "settings.local.json"), "{}");

  // 显式指定起点时不受目录级忽略影响：调用方明确要看这里。
  const files = await walkWorkspaceFiles(root, ".claude", { maxFiles: 50 });

  assert.deepEqual(files, [".claude/settings.local.json"]);
});

test("shouldSkipTraversalSegment covers build output and hidden tool dirs", () => {
  for (const name of ["node_modules", ".git", "dist", "build", "coverage", "__pycache__", ".claude", ".vscode", ".cursor"]) {
    assert.equal(shouldSkipTraversalSegment(name), true, name);
  }
  for (const name of ["src", "docs", ".github", "app.js"]) {
    assert.equal(shouldSkipTraversalSegment(name), false, name);
  }
});

test("normalizeRelativePath uses forward slashes and rejects empty paths", () => {
  assert.equal(normalizeRelativePath("src\\app.js"), "src/app.js");
  assert.throws(() => normalizeRelativePath(""), /path is required/);
});
