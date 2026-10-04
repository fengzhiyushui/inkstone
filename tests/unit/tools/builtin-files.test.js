import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReadTool } from "../../../src/tools/builtin/read.js";
import { createLsTool } from "../../../src/tools/builtin/ls.js";
import { createGrepTool } from "../../../src/tools/builtin/grep.js";
import { createGlobTool } from "../../../src/tools/builtin/glob.js";
import { mkdtemp } from "../../helpers/tmp.js";

test("read tool reads text files inside workspace", async () => {
  const root = await fixtureWorkspace();
  const result = await createReadTool().execute({ path: "README.md" }, { projectRoot: root });

  assert.equal(result.content[0].text, "# Demo");
  assert.equal(result.metadata.path, "README.md");
});

test("ls tool lists directory entries", async () => {
  const root = await fixtureWorkspace();
  const result = await createLsTool().execute({ path: "." }, { projectRoot: root });

  assert.match(result.content[0].text, /README.md/);
  assert.equal(result.metadata.count >= 2, true);
});

test("grep tool finds regex matches with file and line", async () => {
  const root = await fixtureWorkspace();
  const result = await createGrepTool().execute({ pattern: "hello", path: "." }, { projectRoot: root });

  assert.match(result.content[0].text, /src\/app.js:1:console.log\("hello"\)/);
  assert.equal(result.metadata.matches, 1);
});

test("glob tool supports recursive patterns", async () => {
  const root = await fixtureWorkspace();
  const result = await createGlobTool().execute({ pattern: "src/**/*.js" }, { projectRoot: root });

  assert.deepEqual(JSON.parse(result.content[0].text), ["src/app.js"]);
});

async function fixtureWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-tools-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "README.md"), "# Demo", "utf8");
  await writeFile(path.join(root, "src", "app.js"), "console.log(\"hello\")\n", "utf8");
  return root;
}
