import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexWorkspace, shouldSkipContextPath } from "../../../src/context/workspace-indexer.js";
import { mkdtemp } from "../../helpers/tmp.js";

test("indexWorkspace indexes safe text files with context units", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-index-"));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"demo\"}\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "index.js"), "export const demo = true;\n");

  const result = await indexWorkspace({ root });

  assert.ok(result.units.has("package.json"));
  assert.ok(result.units.has("src/index.js"));
  assert.equal(result.stats.indexed_files, 2);
  assert.equal(result.stats.skipped_files, 0);
});

test("indexWorkspace skips ignored directories and secret-like files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-skip-"));
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await writeFile(path.join(root, ".env"), "DEEPSEEK_API_KEY=secret\n");
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "pkg.js"), "module.exports = 1;\n");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist", "bundle.js"), "generated\n");

  const result = await indexWorkspace({ root });

  assert.ok(result.units.has("README.md"));
  assert.equal(result.units.has(".env"), false);
  assert.equal(result.units.has("node_modules/pkg.js"), false);
  assert.equal(result.units.has("dist/bundle.js"), false);
  assert.equal(result.stats.indexed_files, 1);
  assert.ok(result.stats.skipped_files >= 1);
});

test("indexWorkspace skips binary and oversized files without failing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-binary-"));
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await writeFile(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(root, "large.txt"), "x".repeat(128));

  const result = await indexWorkspace({
    root,
    options: { maxFileBytes: 32, maxSnippetBytes: 16 }
  });

  assert.ok(result.units.has("README.md"));
  assert.equal(result.units.has("image.bin"), false);
  assert.equal(result.units.has("large.txt"), false);
  assert.ok(result.stats.skipped_files >= 2);
});

test("shouldSkipContextPath blocks generated and secret names", () => {
  assert.equal(shouldSkipContextPath("node_modules/pkg/index.js"), true);
  assert.equal(shouldSkipContextPath("gui/node_modules/electron/index.js"), true);
  assert.equal(shouldSkipContextPath(".deepseek-code/v2/session.jsonl"), true);
  assert.equal(shouldSkipContextPath(".env.local"), true);
  assert.equal(shouldSkipContextPath("certs/server.key"), true);
  assert.equal(shouldSkipContextPath("src/index.js"), false);
});

test("shouldSkipContextPath blocks hidden config dirs and credential-like files", () => {
  assert.equal(shouldSkipContextPath(".claude/settings.local.json"), true);
  assert.equal(shouldSkipContextPath(".cursor/rules.md"), true);
  assert.equal(shouldSkipContextPath(".vscode/settings.json"), true);
  assert.equal(shouldSkipContextPath(".idea/workspace.xml"), true);
  assert.equal(shouldSkipContextPath(".codex/config.toml"), true);
  assert.equal(shouldSkipContextPath(".gemini/settings.yaml"), true);
  assert.equal(shouldSkipContextPath(".npmrc"), true);
  assert.equal(shouldSkipContextPath(".pypirc"), true);
  assert.equal(shouldSkipContextPath("config/credentials.json"), true);
  assert.equal(shouldSkipContextPath("secrets/token.txt"), true);
  assert.equal(shouldSkipContextPath("auth/apikey.yml"), true);
  assert.equal(shouldSkipContextPath(".github/workflows/ci.yml"), false);
  assert.equal(shouldSkipContextPath(".config/app.yaml"), false);
});

test("indexWorkspace skips hidden tool directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-context-hidden-"));
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await mkdir(path.join(root, ".claude"), { recursive: true });
  await writeFile(path.join(root, ".claude", "settings.local.json"), "{}");
  await mkdir(path.join(root, ".vscode"), { recursive: true });
  await writeFile(path.join(root, ".vscode", "settings.json"), "{}");

  const result = await indexWorkspace({ root });

  assert.ok(result.units.has("README.md"));
  assert.equal(result.units.has(".claude/settings.local.json"), false);
  assert.equal(result.units.has(".vscode/settings.json"), false);
  assert.ok(result.stats.skipped_files >= 2);
});
