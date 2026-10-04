// tests/helpers/tmp.js — 测试临时目录的统一出口
//
// 背景:测试普遍用 `mkdtemp(path.join(tmpdir(), "dsc-xxx-"))` 建夹具,但极少回收,
// 每跑一轮全量测试就在系统临时目录里堆几百个孤儿目录(实测 282 个/轮)。
// 这里导出与 `node:fs/promises.mkdtemp` 同签名的包装:创建即登记,进程退出时统一删除。
//
// 用法:测试文件把 `mkdtemp` 的来源从 `node:fs/promises` 换成本模块 ——
//
//   import { mkdtemp } from "../helpers/tmp.js";
//
// 其余调用点无需改动。夹具若自带清理(`try/finally` 里 rm),这里会幂等跳过。
import { mkdtemp as rawMkdtemp } from "node:fs/promises";
import { mkdtempSync as rawMkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const created = new Set();
let registered = false;

function isInsideTempDir(p) {
  const resolved = path.resolve(String(p));
  // 每次读取 tmpdir():便于测试用 TMPDIR 指向隔离目录来验证回收行为。
  // 只清 os.tmpdir() 之下的路径:越界一律跳过,避免误删工作区内容。
  const tmp = path.resolve(tmpdir());
  return resolved === tmp || resolved.startsWith(tmp + path.sep);
}

function cleanup() {
  for (const dir of created) {
    if (!isInsideTempDir(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 已被测试自己删掉 / 文件仍被占用 —— 尽力而为,不干扰退出
    }
  }
  created.clear();
}

function register() {
  if (registered) return;
  registered = true;
  process.on("exit", cleanup);
  // 被中断时也要收:否则 Ctrl-C 会留下整轮夹具
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { cleanup(); process.exit(130); });
  }
}

/**
 * 与 `fs.promises.mkdtemp` 同签名;创建的目录会在进程退出时自动删除。
 * @param {string} prefix
 * @param {{encoding?: string}} [options]
 */
export async function mkdtemp(prefix, options) {
  const dir = await rawMkdtemp(prefix, options);
  register();
  created.add(dir);
  return dir;
}

/** 显式回收(测试想提前清理时用);清理后自动从登记表移除。 */
export function cleanupTempDirs() {
  cleanup();
}

/** 同 `fs.mkdtempSync`;创建的目录会在进程退出时自动删除。 */
export function mkdtempSync(prefix, options) {
  const dir = rawMkdtempSync(prefix, options);
  register();
  created.add(dir);
  return dir;
}

export { isInsideTempDir };
