import { createContextUnit } from "./context-unit.js";
import {
  HIDDEN_TOOL_DIR_SEGMENTS,
  IGNORED_BUILD_SEGMENTS,
  normalizeRelativePath,
  readWorkspaceTextFile,
  walkWorkspaceFiles
} from "../workspace/path-safety.js";

const DEFAULT_OPTIONS = Object.freeze({
  maxFiles: 1000,
  maxFileBytes: 64 * 1024,
  maxSnippetBytes: 4000
});

// 目录级忽略表与遍历侧同源（path-safety），此处只补「跳过原因」的分类口径。
const IGNORED_SEGMENTS = new Set(IGNORED_BUILD_SEGMENTS);
const HIDDEN_TOOL_DIRS = new Set(HIDDEN_TOOL_DIR_SEGMENTS);

const CREDENTIAL_BASENAMES = new Set([
  ".npmrc",
  ".pypirc"
]);

const CREDENTIAL_TOKENS = ["credentials", "token", "apikey", "auth"];

const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx"];

export async function indexWorkspace({ root, options = {} } = {}) {
  if (!root) throw new Error("root is required");
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const units = new Map();
  const stats = {
    scanned_files: 0,
    indexed_files: 0,
    skipped_files: 0,
    skipped_reasons: {}
  };

  const files = await walkWorkspaceFiles(root, ".", { maxFiles: settings.maxFiles });
  for (const file of files) {
    stats.scanned_files += 1;
    const skip = skipReason(file);
    if (skip) {
      recordSkip(stats, skip);
      continue;
    }

    try {
      const text = await readWorkspaceTextFile(root, file, { maxBytes: settings.maxFileBytes });
      const unit = createContextUnit({
        path: text.path,
        content: text.content,
        maxSnippetBytes: settings.maxSnippetBytes
      });
      units.set(unit.path, unit);
      stats.indexed_files += 1;
    } catch (error) {
      recordSkip(stats, classifyReadError(error));
    }
  }

  return { units, stats };
}

export function contextSkipReason(inputPath) {
  return skipReason(inputPath);
}

export function shouldSkipContextPath(inputPath) {
  return Boolean(skipReason(inputPath));
}

function skipReason(inputPath) {
  const p = normalizeRelativePath(inputPath);
  const lower = p.toLowerCase();
  const segments = lower.split("/");
  const base = segments[segments.length - 1] || "";

  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return "ignored-directory";
  if (segments.some((segment) => HIDDEN_TOOL_DIRS.has(segment))) return "hidden-tool-dir";
  if (CREDENTIAL_BASENAMES.has(base)) return "credential-file";
  if (CREDENTIAL_TOKENS.some((token) => lower.includes(token)) &&
      (base.endsWith(".json") || base.endsWith(".txt") || base.endsWith(".yml") || base.endsWith(".yaml") || base.endsWith(".toml") || base.endsWith(".ini") || base.endsWith(".cfg"))) {
    return "credential-file";
  }
  if (base === ".env" || base.startsWith(".env.")) return "secret-file";
  if (SECRET_SUFFIXES.some((suffix) => base.endsWith(suffix))) return "secret-file";
  if (base.includes("secret") && (base.endsWith(".json") || base.endsWith(".txt") || base.endsWith(".yml") || base.endsWith(".yaml"))) {
    return "secret-file";
  }
  return null;
}

function classifyReadError(error) {
  const message = String(error?.message || "");
  if (message.includes("binary file refused")) return "binary";
  if (message.includes("file too large")) return "too-large";
  if (message.includes("path escapes project root")) return "path-escape";
  return "unreadable";
}

function recordSkip(stats, reason) {
  stats.skipped_files += 1;
  stats.skipped_reasons[reason] = (stats.skipped_reasons[reason] || 0) + 1;
}
