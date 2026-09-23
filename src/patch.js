import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveInsideRoot } from "./context.js";

export function extractUnifiedDiff(text) {
  const fenced = text.match(/```(?:diff|patch)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const lines = candidate.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith("diff --git ") || line.startsWith("--- "));
  if (start === -1) {
    return "";
  }
  return lines.slice(start).join("\n").trimEnd();
}

export function summarizeDiff(diff) {
  return parseUnifiedDiff(diff).map((patch) => ({
    path: patch.newPath === "/dev/null" ? patch.oldPath : patch.newPath,
    status: patch.oldPath === "/dev/null" ? "create" : patch.newPath === "/dev/null" ? "delete" : "modify"
  }));
}

export async function applyUnifiedDiff(diff, root) {
  const patches = parseUnifiedDiff(diff);
  if (!patches.length) {
    throw new Error("diff 为空。");
  }

  const changedFiles = [];
  for (const patch of patches) {
    const filePath = patch.newPath === "/dev/null" ? patch.oldPath : patch.newPath;
    const target = resolveInsideRoot(root, filePath);
    let original = "";

    if (patch.oldPath !== "/dev/null") {
      original = stripBom(await fs.readFile(target, "utf8"));
    }

    const updated = applyPatchToText(original, patch);
    if (patch.newPath === "/dev/null") {
      await fs.unlink(target);
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, updated, "utf8");
    }
    changedFiles.push(filePath);
  }

  return { changedFiles };
}

export function parseUnifiedDiff(diff) {
  const lines = diff.split(/\r?\n/);
  const patches = [];
  let index = 0;
  let current = null;

  while (index < lines.length) {
    const line = lines[index];

    if (line.startsWith("diff --git ")) {
      if (current) {
        patches.push(current);
      }
      current = { oldPath: "", newPath: "", hunks: [] };
      index += 1;
      continue;
    }

    if (line.startsWith("--- ")) {
      if (!current) {
        current = { oldPath: "", newPath: "", hunks: [] };
      }
      current.oldPath = normalizeDiffPath(line.slice(4).trim());
      index += 1;
      continue;
    }

    if (line.startsWith("+++ ")) {
      if (!current) {
        throw new Error("diff 格式错误：+++ 出现在 --- 之前。");
      }
      current.newPath = normalizeDiffPath(line.slice(4).trim());
      index += 1;
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (!current) {
        throw new Error("diff 格式错误：文件头之前出现了 hunk。");
      }
      const header = parseHunkHeader(line);
      const hunkLines = [];
      index += 1;
      while (index < lines.length) {
        const hunkLine = lines[index];
        if (hunkLine.startsWith("diff --git ") || hunkLine.startsWith("--- ") || hunkLine.startsWith("@@ ")) {
          break;
        }
        if (hunkLine.startsWith("\\ No newline")) {
          const prev = hunkLines[hunkLines.length - 1];
          if (prev && (prev.type === "+" || prev.type === " ")) {
            current.noNewlineAtEnd = true;
          }
          index += 1;
          continue;
        }
        if (![" ", "+", "-"].includes(hunkLine[0] || "")) {
          break;
        }
        hunkLines.push({
          type: hunkLine[0],
          text: hunkLine.slice(1)
        });
        index += 1;
      }
      current.hunks.push({ ...header, lines: hunkLines });
      continue;
    }

    index += 1;
  }

  if (current) {
    patches.push(current);
  }

  return patches.filter((patch) => patch.oldPath || patch.newPath).map(validatePatch);
}

export function applyPatchToText(original, patch) {
  const sourceLines = splitPreserveFinalNewline(original);
  const result = [];
  let cursor = 0;

  for (const hunk of patch.hunks) {
    const oldStart = Math.max(hunk.oldStart - 1, 0);
    if (oldStart < cursor) {
      throw new Error(`${patch.newPath || patch.oldPath} 中存在重叠的 hunk。`);
    }

    while (cursor < oldStart && cursor < sourceLines.length) {
      result.push(sourceLines[cursor]);
      cursor += 1;
    }

    for (const line of hunk.lines) {
      if (line.type === " ") {
        assertLine(sourceLines[cursor], line.text, patch);
        result.push(sourceLines[cursor]);
        cursor += 1;
      } else if (line.type === "-") {
        assertLine(sourceLines[cursor], line.text, patch);
        cursor += 1;
      } else if (line.type === "+") {
        result.push(line.text);
      }
    }
  }

  while (cursor < sourceLines.length) {
    result.push(sourceLines[cursor]);
    cursor += 1;
  }

  const isCrlf = original.includes("\r\n");
  const eol = isCrlf ? "\r\n" : "\n";
  const isNewFile = patch.oldPath === "/dev/null" || !original;
  const finalNewline = isNewFile
    ? !patch.noNewlineAtEnd
    : (patch.noNewlineAtEnd ? false : original.endsWith("\n"));

  return joinLines(result, finalNewline, eol);
}

function validatePatch(patch) {
  if (!patch.oldPath || !patch.newPath) {
    throw new Error("diff 文件头必须包含 --- 和 +++。");
  }
  if (!patch.hunks.length && patch.oldPath !== "/dev/null" && patch.newPath !== "/dev/null") {
    throw new Error(`${patch.newPath} 的 diff 没有包含 hunk。`);
  }
  return patch;
}

function normalizeDiffPath(value) {
  const pathOnly = value.split(/\s+/)[0];
  if (pathOnly === "/dev/null") {
    return pathOnly;
  }
  return pathOnly.replace(/^a\//, "").replace(/^b\//, "");
}

function parseHunkHeader(line) {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) {
    throw new Error(`无效的 hunk 头：${line}`);
  }
  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] || "1"),
    newStart: Number(match[3]),
    newCount: Number(match[4] || "1")
  };
}

function assertLine(actual, expected, patch) {
  if (actual !== expected) {
    const file = patch.newPath || patch.oldPath;
    throw new Error(`补丁上下文不匹配：${file}。期望 "${expected}"，实际 "${actual ?? "<文件结束>"}"。`);
  }
}

function splitPreserveFinalNewline(text) {
  if (!text) {
    return [];
  }
  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  }
  return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function joinLines(lines, finalNewline, eol = "\n") {
  if (!lines.length) return "";
  const joined = lines.join(eol);
  return finalNewline ? `${joined}${eol}` : joined;
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}
