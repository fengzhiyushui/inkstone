import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 5000;

// 遍历期永不进入的目录名。单一来源：walkWorkspaceFiles（ls/glob/read/grep 工具、
// `inkstone search`）与 context/workspace-indexer.js 共用，避免两份漂移的忽略表。
//  v1.19.0 之前 path-safety 只硬编码 node_modules/.git/.deepseek-code 三个，
//  workspace-indexer 另有一份 13 项的 IGNORED_SEGMENTS + 6 项 HIDDEN_TOOL_DIRS，
// 导致同一项目的遍历口径不一致（例如 search 会翻 .claude/ 与 dist/）。
export const IGNORED_BUILD_SEGMENTS = Object.freeze([
  ".git",
  ".deepseek-code",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "target",
  "vendor",
  "__pycache__"
]);

// 其它 AI 编程助手的本地状态目录：内容是本机配置 / 权限白名单 / 任务简报，
// 既不是项目源码，也可能夹带密钥，一律不进遍历。
export const HIDDEN_TOOL_DIR_SEGMENTS = Object.freeze([
  ".claude",
  ".cursor",
  ".vscode",
  ".idea",
  ".codex",
  ".gemini"
]);

const SKIPPED_TRAVERSAL_SEGMENTS = new Set([
  ...IGNORED_BUILD_SEGMENTS,
  ...HIDDEN_TOOL_DIR_SEGMENTS
]);

export function shouldSkipTraversalSegment(name) {
  return SKIPPED_TRAVERSAL_SEGMENTS.has(name);
}

export function normalizeRelativePath(inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new Error("path is required");
  }
  return inputPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export async function resolveWorkspacePath(projectRoot, inputPath, { mustExist = false } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const relativeInput = normalizeRelativePath(inputPath);
  const realRoot = await realpathOrResolve(projectRoot);
  const absolute = path.resolve(realRoot, relativeInput);
  const realTarget = mustExist
    ? await fs.realpath(absolute)
    : await resolveRealTargetForPossiblyNewPath(absolute);

  assertInside(realRoot, realTarget, relativeInput);
  return {
    absolute,
    real: realTarget,
    relative: toPosix(path.relative(realRoot, absolute))
  };
}

export async function readWorkspaceTextFile(projectRoot, inputPath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const resolved = await resolveWorkspacePath(projectRoot, inputPath, { mustExist: true });
  const stat = await fs.stat(resolved.real);
  if (!stat.isFile()) throw new Error(`not a file: ${inputPath}`);
  if (stat.size > maxBytes) throw new Error(`file too large: ${inputPath}`);
  const buffer = await fs.readFile(resolved.real);
  if (isBinaryBuffer(buffer)) throw new Error(`binary file refused: ${inputPath}`);
  return {
    path: resolved.relative,
    content: buffer.toString("utf8"),
    bytes: buffer.length
  };
}

export async function walkWorkspaceFiles(projectRoot, startPath = ".", { maxFiles = DEFAULT_MAX_FILES } = {}) {
  const start = await resolveWorkspacePath(projectRoot, startPath, { mustExist: true });
  const realRoot = await realpathOrResolve(projectRoot);
  const files = [];

  async function visit(absoluteDir) {
    if (files.length >= maxFiles) return;
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (shouldSkipTraversalSegment(entry.name)) continue;
      const absolute = path.join(absoluteDir, entry.name);
      const real = await fs.realpath(absolute).catch(() => absolute);
      assertInside(realRoot, real, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(toPosix(path.relative(realRoot, absolute)));
      }
    }
  }

  const stat = await fs.stat(start.real);
  if (stat.isDirectory()) {
    await visit(start.absolute);
  } else if (stat.isFile()) {
    files.push(start.relative);
  }
  return files;
}

export function isBinaryBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

async function resolveRealTargetForPossiblyNewPath(absolute) {
  try {
    return await fs.realpath(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let cursor = path.dirname(absolute);
  while (true) {
    try {
      const realParent = await fs.realpath(cursor);
      return path.join(realParent, path.relative(cursor, absolute));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const next = path.dirname(cursor);
      if (next === cursor) return absolute;
      cursor = next;
    }
  }
}

async function realpathOrResolve(inputPath) {
  try {
    return await fs.realpath(inputPath);
  } catch {
    return path.resolve(inputPath);
  }
}

function assertInside(realRoot, realTarget, originalPath) {
  const rel = path.relative(realRoot, realTarget);
  const isEscape = rel === ".." || rel.startsWith(".." + path.sep) || rel.startsWith("../") || path.isAbsolute(rel);
  if (isEscape) {
    throw new Error(`path escapes project root: ${originalPath}`);
  }
}

function toPosix(inputPath) {
  return inputPath.replace(/\\/g, "/");
}
