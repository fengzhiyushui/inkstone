// tests/helpers/symlink-capability.js
// v1.8.3(W5):平台能力探测。某些 Windows 环境下 symlink/junction **能创建却完全不可读**
// ——realpath / stat / scandir 对该链接一律抛 `UNKNOWN: unknown error`(已在
// Node v24.14.1 + win32 实测复现)。此时"符号链接越界"用例的前提(存在一个可解析的
// 越界链接)无法建立,断言 `/escapes project root/` 只会收到底层 UNKNOWN 错误。
//
// 注意:这不是安全回归 —— resolveWorkspacePath / assertDiffPathsSafe 仍会**拒绝**该路径
// (fail-closed),只是错误类型不是规范化消息。故此处按能力门控 skip,与仓库既有惯例一致
// (gui-smoke 无 Electron 则 skip、TUI 真 pty smoke 无 node-pty 则 skip)。
import { mkdtemp, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const SYMLINK_SKIP_REASON =
  "平台无法解析符号链接/junction(realpath 抛 UNKNOWN),无法构造越界链接前提";

let cached = null;

export async function symlinkTraversalSupported() {
  if (cached !== null) return cached;
  try {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-symprobe-"));
    const outside = await mkdtemp(path.join(tmpdir(), "dsc-symprobe-out-"));
    await writeFile(path.join(outside, "probe.txt"), "x");
    await symlink(outside, path.join(root, "link"), "junction");
    await realpath(path.join(root, "link", "probe.txt"));
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}
