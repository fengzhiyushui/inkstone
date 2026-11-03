// tests/unit/shared/tmp-hygiene-guard.test.js — 临时目录防泄漏闸门(夹具回收助手契约)领域测试
//
// v1.11.4 修掉了一个长期问题:测试用 mkdtemp 建夹具后不回收,每轮全量测试在系统
// 临时目录里堆几百个孤儿目录(实测 282 个/轮)。修法是把 mkdtemp 统一走
// tests/helpers/tmp.js,由进程退出回收。本文件锁住两件事:
//   1) 回收机制真的生效(子进程实操验证,不只是单测契约);
//   2) 没有任何测试文件绕过助手直接调用 node:fs 的 mkdtemp。
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/tmp-hygiene-guard.test.js
// ---------------------------------------------------------------------------
describe("unit/tmp-hygiene-guard", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, globSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const HELPER = "tests/helpers/tmp.js";

  test("夹具回收:子进程退出后临时目录必须消失", () => {
    // 用隔离的 TMPDIR,把"泄漏"限定在一个可检查的目录里
    const sandbox = path.join(tmpdir(), `dsc-hygiene-${process.pid}-${Date.now()}`);
    mkdirSync(sandbox, { recursive: true });

    // 子进程经助手建目录后正常退出 —— 若退出回收失效,目录会留在 sandbox 里
    const script = `
      import { mkdtemp } from ${JSON.stringify(new URL(`../../../${HELPER}`, import.meta.url).href)};
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
    assert.deepEqual(
      leftovers,
      [],
      `子进程退出后仍有夹具残留,说明回收机制失效:\n${leftovers.join("\n")}`
    );
  });

  test("越界路径不参与回收(只清 os.tmpdir() 之内)", () => {
    const outside = path.join(ROOT, "tests"); // 工作区内的真实目录,绝不能被清
    assert.ok(existsSync(outside), "前置:该目录应存在");
    // 助手只把 os.tmpdir() 之下的路径加入回收;这里验证判定本身
    const tmp = path.resolve(tmpdir());
    const inside = path.join(tmp, "x");
    assert.ok(path.resolve(inside).startsWith(tmp + path.sep), "tmp 内路径应判定为可回收");
    assert.equal(path.resolve(outside).startsWith(tmp + path.sep), false, "工作区路径不得判定为可回收");
  });

  test("所有测试的 mkdtemp 都必须经助手,不得直连 node:fs", () => {
    const files = globSync("tests/**/*.test.js", { cwd: ROOT }).map((p) => p.split(path.sep).join("/"));
    assert.ok(files.length > 40, `应扫到全部领域测试文件(实得 ${files.length})`);

    const offenders = [];
    for (const rel of files) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      if (!/\bmkdtemp(Sync)?\b/.test(src)) continue;

      const usesHelper = src.includes("helpers/tmp.js");
      if (!usesHelper) { offenders.push(`${rel}  (未引入助手)`); continue; }

      // 仍然从 node:fs / node:fs/promises 直接取 mkdtemp 的也算绕过
      const directNamed = /import\s*\{[^}]*\bmkdtemp(Sync)?\b[^}]*\}\s*from\s*"node:fs(\/promises)?"/.test(src);
      const directNs = /import\s+(\w+)\s+from\s*"node:fs\/promises"/.test(src) &&
        new RegExp(`\\b${(src.match(/import\s+(\w+)\s+from\s*"node:fs\/promises"/) || [])[1]}\\.mkdtemp\\(`).test(src);
      const directReq = /const\s*\{[^}]*\bmkdtemp(Sync)?\b[^}]*\}\s*=\s*require\(\s*"node:fs(\/promises)?"\s*\)/.test(src);
      if (directNamed || directNs || directReq) offenders.push(`${rel}  (仍直连 node:fs)`);
    }

    assert.deepEqual(offenders, [], `以下测试绕过了夹具回收助手:\n${offenders.join("\n")}`);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tmp-helper.test.js
// ---------------------------------------------------------------------------
describe("unit/tmp-helper", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { mkdtemp, isInsideTempDir } = await import("../../helpers/tmp.js");

  test("tmp 助手:创建真实目录,且位于 os.tmpdir() 之内", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsc-helpercheck-"));
    assert.ok(existsSync(dir), "创建后目录应存在");
    assert.ok(dir.startsWith(tmpdir()), "应落在系统临时目录内");
    assert.equal(isInsideTempDir(dir), true);
  });

  test("tmp 助手:越界路径判定为不安全(不参与回收)", () => {
    assert.equal(isInsideTempDir(path.join(tmpdir(), "dsc-x")), true);
    assert.equal(isInsideTempDir(path.resolve("/")), false);
    assert.equal(isInsideTempDir(path.resolve("C:/Windows")), false);
    assert.equal(isInsideTempDir(path.resolve("../outside-tmp")), false);
  });
});
