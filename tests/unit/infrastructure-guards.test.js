// tests/unit/infrastructure-guards.test.js — 基础设施与架构边界守卫
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, globSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEventBus } from "../../src/shared/event-bus.js";
import { mkdtemp, isInsideTempDir } from "../helpers/tmp.js";
import { VERSION as THEME_VERSION } from "../../src/theme.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HELPER = "tests/helpers/tmp.js";

test("EventBus: 订阅发布、元数据注入、取消订阅与异常隔离", () => {
  const bus = createEventBus();
  const received = [];
  let failSubRan = false;

  const sub1 = bus.subscribe("agent:step", (data, meta) => {
    received.push({ data, meta });
  });
  bus.subscribe("tool:result", () => {
    failSubRan = true;
    throw new Error("subscriber failure");
  });
  bus.subscribe("tool:result", (data) => {
    received.push({ data });
  });

  bus.publish("agent:step", { step_id: "step_1" });
  assert.equal(received.length, 1);
  assert.equal(received[0].data.step_id, "step_1");
  assert.equal(received[0].meta.event_type, "agent:step");
  assert.ok(received[0].meta.event_id.startsWith("evt_"));
  assert.ok(Date.parse(received[0].meta.timestamp) > 0);

  sub1.unsubscribe();
  bus.publish("agent:step", { step_id: "step_2" });
  assert.equal(received.length, 1);

  assert.doesNotThrow(() => {
    bus.publish("tool:result", { status: "success" });
  });
  assert.equal(failSubRan, true);
  assert.equal(received.length, 2);
  assert.equal(received[1].data.status, "success");
});

test("tmp 夹具守卫: 创建位于临时目录内、子进程退出自动回收且禁止直连 node:fs mkdtemp", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dsc-helpercheck-"));
  assert.ok(existsSync(dir), "创建后目录应存在");
  assert.ok(dir.startsWith(tmpdir()), "应落在系统临时目录内");
  assert.equal(isInsideTempDir(dir), true);
  assert.equal(isInsideTempDir(path.resolve("/")), false);
  assert.equal(isInsideTempDir(path.resolve("C:/Windows")), false);
  assert.equal(isInsideTempDir(path.resolve("../outside-tmp")), false);

  const sandbox = path.join(tmpdir(), `dsc-hygiene-${process.pid}-${Date.now()}`);
  mkdirSync(sandbox, { recursive: true });

  const script = `
    import { mkdtemp } from ${JSON.stringify(new URL("../helpers/tmp.js", import.meta.url).href)};
    import { tmpdir } from "node:os";
    import path from "node:path";
    await mkdtemp(path.join(tmpdir(), "dsc-hygiene-probe-"));
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox }
  });
  assert.equal(run.status, 0, `子进程应正常退出;stderr=${run.stderr}`);

  const leftovers = existsSync(sandbox) ? readdirSync(sandbox) : [];
  rmSync(sandbox, { recursive: true, force: true });
  assert.deepEqual(leftovers, [], `子进程退出后仍有夹具残留,说明回收机制失效:\n${leftovers.join("\n")}`);

  const files = globSync("tests/**/*.test.js", { cwd: ROOT }).map((p) => p.split(path.sep).join("/"));
  assert.ok(files.length >= 10, `应扫到测试文件(实得 ${files.length})`);

  const offenders = [];
  for (const rel of files) {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    if (!/\bmkdtemp(Sync)?\b/.test(src)) continue;

    const usesHelper = src.includes("helpers/tmp.js");
    if (!usesHelper) { offenders.push(`${rel}  (未引入助手)`); continue; }

    const directNamed = /import\s*\{[^}]*\bmkdtemp(Sync)?\b[^}]*\}\s*from\s*"node:fs(\/promises)?"/.test(src);
    const directNs = /import\s+(\w+)\s+from\s*"node:fs\/promises"/.test(src) &&
      new RegExp(`\\b${(src.match(/import\s+(\w+)\s+from\s*"node:fs\/promises"/) || [])[1]}\\.mkdtemp\\(`).test(src);
    const directReq = /const\s*\{[^}]*\bmkdtemp(Sync)?\b[^}]*\}\s*=\s*require\(\s*"node:fs(\/promises)?"\s*\)/.test(src);
    if (directNamed || directNs || directReq) offenders.push(`${rel}  (仍直连 node:fs)`);
  }

  assert.deepEqual(offenders, [], `以下测试绕过了夹具回收助手:\n${offenders.join("\n")}`);
});

test("架构整洁度与版本守卫: src顶层仅限4入口、7个已删V1模块不复活、四处版本号100%一致", () => {
  const srcFiles = readdirSync(path.join(ROOT, "src"), { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .sort();
  assert.deepEqual(srcFiles, ["cli.js", "config.js", "index.js", "theme.js"], "src/ 顶层只允许保留 4 个统一入口");

  const deadModules = [
    "src/provider.js",
    "src/context.js",
    "src/search.js",
    "src/git.js",
    "src/tui.js",
    "src/patch.js",
    "src/changes.js"
  ];
  for (const m of deadModules) {
    assert.equal(existsSync(path.join(ROOT, m)), false, `废弃的 V1 双轨模块不得复活: ${m}`);
  }

  const pkgJson = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const lockJson = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const appJsx = readFileSync(path.join(ROOT, "gui", "src", "App.jsx"), "utf8");
  const appVersionMatch = appJsx.match(/const VERSION = "([^"]+)";/);

  assert.ok(appVersionMatch, "gui/src/App.jsx 应包含 VERSION 常量");
  const expectedVersion = pkgJson.version;

  assert.equal(lockJson.version, expectedVersion, "package-lock.json 顶层 version 不一致");
  assert.equal(lockJson.packages[""].version, expectedVersion, "package-lock.json packages[''].version 不一致");
  assert.equal(THEME_VERSION, expectedVersion, "src/theme.js VERSION 不一致");
  assert.equal(appVersionMatch[1], expectedVersion, "gui/src/App.jsx VERSION 不一致");
});
