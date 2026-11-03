import { readWorkspaceTextFile, walkWorkspaceFiles } from "../../workspace/path-safety.js";

// 工作区文本检索的唯一实现。v1.19.0 从 createGrepTool 中抽出：
// 内置 `grep` 工具与 CLI `inkstone search` 共用同一套遍历 / 读取 / 超时 /
// 截断语义，消除两条平行的搜索实现（原顶层 src/search.js 已删除）。
export const GREP_DEFAULTS = Object.freeze({
  maxMatches: 200,
  totalTimeoutMs: 10_000,
  perFileTimeoutMs: 2_000,
  maxFileBytes: 1024 * 1024
});

export async function searchWorkspace({
  projectRoot,
  pattern,
  path: startPath = ".",
  maxMatches = GREP_DEFAULTS.maxMatches,
  now = Date.now,
  totalTimeoutMs = GREP_DEFAULTS.totalTimeoutMs,
  perFileTimeoutMs = GREP_DEFAULTS.perFileTimeoutMs,
  maxFileBytes = GREP_DEFAULTS.maxFileBytes
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const regex = toRegExp(pattern);
  const files = await walkWorkspaceFiles(projectRoot, startPath);
  const matches = [];
  const totalStart = now();
  let filesSearched = 0;
  let filesSkippedTimeout = 0;
  let timedOutScope = null;

  for (const filePath of files) {
    if (matches.length >= maxMatches) break;
    if (now() - totalStart >= totalTimeoutMs) {
      timedOutScope = "total";
      break;
    }
    let file;
    try {
      file = await readWorkspaceTextFile(projectRoot, filePath, { maxBytes: maxFileBytes });
    } catch {
      continue;
    }
    filesSearched += 1;
    const fileStart = now();
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (index % 64 === 0 || index === 0) {
        if (now() - totalStart >= totalTimeoutMs) {
          timedOutScope = "total";
          break;
        }
        if (now() - fileStart >= perFileTimeoutMs) {
          filesSkippedTimeout += 1;
          break;
        }
      }
      const found = regex.exec(lines[index]);
      if (found) {
        matches.push({
          path: filePath,
          line: index + 1,
          column: found.index + 1,
          text: lines[index]
        });
        if (matches.length >= maxMatches) break;
      }
    }
    if (timedOutScope === "total") break;
  }

  return {
    matches,
    metadata: {
      matches: matches.length,
      timed_out: timedOutScope != null || filesSkippedTimeout > 0,
      timed_out_scope: timedOutScope ?? (filesSkippedTimeout > 0 ? "file" : null),
      files_skipped_timeout: filesSkippedTimeout,
      files_searched: filesSearched
    }
  };
}

export function createGrepTool({
  now = Date.now,
  totalTimeoutMs = GREP_DEFAULTS.totalTimeoutMs,
  perFileTimeoutMs = GREP_DEFAULTS.perFileTimeoutMs
} = {}) {
  return {
    name: "grep",
    description: "Search workspace text files with a JavaScript regular expression",
    category: "read",
    side_effect: "none",
    risk_level: "low",
    source: "builtin",
    version: "2.1",
    params: {
      pattern: { type: "string", description: "Regular expression pattern" },
      path: { type: "string", default: ".", description: "Workspace-relative path to search" },
      max_matches: { type: "number", required: false, default: 200 }
    },
    execute: async (params, context) => {
      const { matches, metadata } = await searchWorkspace({
        projectRoot: context.projectRoot,
        pattern: params.pattern,
        path: params.path,
        maxMatches: params.max_matches ?? GREP_DEFAULTS.maxMatches,
        now,
        totalTimeoutMs,
        perFileTimeoutMs
      });
      return {
        content: [{ type: "text", text: matches.map((m) => `${m.path}:${m.line}:${m.text}`).join("\n") }],
        metadata
      };
    }
  };
}

// pattern 非字符串或非法正则时给出稳定错误（不裸抛 SyntaxError 文本）。
function toRegExp(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("pattern is required");
  }
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(`invalid regular expression: ${error.message}`);
  }
}
