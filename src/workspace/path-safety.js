import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 5000;

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
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".deepseek-code") continue;
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
