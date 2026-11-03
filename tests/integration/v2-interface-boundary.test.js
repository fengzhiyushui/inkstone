import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

async function source(file) {
  return readFile(file, "utf8");
}

test("migrated CLI ask edit test entrypoints use V2 kernel runner", async () => {
  const cli = await source("src/cli.js");

  assert.match(cli, /runKernelAgentCommand/);
  assert.match(cli, /runKernelTestCommand/);
  assert.doesNotMatch(cli, /askCommand/);
  assert.doesNotMatch(cli, /editCommand/);
  assert.doesNotMatch(cli, /from "\.\/agent\.js"/);
});

test("TUI and GUI host do not import the old V1 kernel api", async () => {
  const tui = await source("src/apps/tui/tui-app.js");
  const guiMain = await source("gui/main.js");
  const guiHost = await source("gui/kernel-host.js");

  assert.match(tui, /from "\.\.\/\.\.\/index\.js"/);
  assert.doesNotMatch(tui, /from "\.\/agent\.js"/);
  assert.doesNotMatch(tui, /kernel-api/);
  assert.doesNotMatch(guiMain, /src[\\/]+kernel[\\/]+kernel-api|kernel-api/);
  assert.doesNotMatch(guiHost, /src[\\/]+kernel[\\/]+kernel-api|kernel-api/);
});

test("CLI chat routes through V2 kernel runner; TUI app talks to the unified kernel entry", async () => {
  const cli = await source("src/cli.js");
  const app = await source("src/apps/tui/tui-app.js");

  assert.match(cli, /runKernelChatCommand/);
  assert.match(app, /from "\.\.\/\.\.\/index\.js"/);
  assert.doesNotMatch(cli, /from "\.\/chat\.js"/);
  assert.doesNotMatch(app, /chat\.js/);
  assert.doesNotMatch(cli, /askDeepSeek/);
  assert.doesNotMatch(app, /askDeepSeek/);

  // V1 legacy entrypoints were deleted in V2-19.
  await assert.rejects(() => source("src/chat.js"));
  await assert.rejects(() => source("src/agent.js"));

  // v1.19.0 架构收敛：src/ 顶层只保留 index/cli/config/theme 四个入口，
  // 其余 V1 双轨遗留模块与 edits 域外泄实现一律删除。
  for (const removed of [
    "src/provider.js",
    "src/context.js",
    "src/search.js",
    "src/git.js",
    "src/tui.js",
    "src/patch.js",
    "src/changes.js"
  ]) {
    await assert.rejects(() => source(removed), `${removed} 应已在 v1.19.0 删除`);
  }
});

test("v1.19.0 top-level src entries are limited to the four entrypoints", async () => {
  const entries = await readdir("src", { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  assert.deepEqual(files, ["cli.js", "config.js", "index.js", "theme.js"]);
});
