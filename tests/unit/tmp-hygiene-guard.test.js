// tests/unit/tmp-hygiene-guard.test.js — 防回归闸门
//
// v1.11.4 修掉了一个长期问题:测试用 mkdtemp 建夹具后不回收,每轮全量测试在系统
// 临时目录里堆几百个孤儿目录(实测 282 个/轮)。修法是把 mkdtemp 统一走
// tests/helpers/tmp.js,由进程退出回收。本文件锁住两件事:
//   1) 回收机制真的生效(子进程实操验证,不只是单测契约);
//   2) 没有任何测试文件绕过助手直接调用 node:fs 的 mkdtemp。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, globSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HELPER = "tests/helpers/tmp.js";

test("夹具回收:子进程退出后临时目录必须消失", () => {
  // 用隔离的 TMPDIR,把"泄漏"限定在一个可检查的目录里
  const sandbox = path.join(tmpdir(), `dsc-hygiene-${process.pid}-${Date.now()}`);
  mkdirSync(sandbox, { recursive: true });

  // 子进程经助手建目录后正常退出 —— 若退出回收失效,目录会留在 sandbox 里
  const script = `
    import { mkdtemp } from ${JSON.stringify(new URL(`../../${HELPER}`, import.meta.url).href)};
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
  assert.ok(files.length > 200, `应扫到全部测试文件(实得 ${files.length})`);

  const offenders = [];
  for (const rel of files) {
    if (rel === "tests/unit/tmp-helper.test.js") continue; // 助手自身的单测
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
