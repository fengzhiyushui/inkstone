import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyCommand } from "../../security/command-policy.js";
import { runProcess } from "../../security/shell-policy.js";
import { resolveWorkspacePath } from "../../workspace/path-safety.js";

const execFileAsync = promisify(execFile);

const GIT_READ_OPS = {
  status: ["git", "status", "--short"],
  diff: ["git", "diff", "--"],
  log: ["git", "log", "--oneline", "-20"],
  show: ["git", "show", "--stat", "--oneline", "HEAD"]
};

// v1.19.0 由顶层 src/git.js 内聚至此：`inkstone diff` 与 TUI `/diff`、内置
// `git` 工具共用同一处 git 读操作定义，不再维护一条平行的 git 封装。
// 与工具路径的差别只在缓冲区：diff 可能很大，故不走 runProcess 的 32 KiB 截断。
export async function showDiff(root) {
  try {
    const { stdout } = await execFileAsync(GIT_READ_OPS.diff[0], GIT_READ_OPS.diff.slice(1), {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    if (error.stderr?.includes("not a git repository")) {
      return "";
    }
    throw new Error(`git diff 执行失败：${error.message}`);
  }
}


export function createGitTool() {
  return {
    name: "git",
    description: "Run safe git read operations",
    category: "read",
    side_effect: "process",
    risk_level: "low",
    source: "builtin",
    version: "2.0",
    params: {
      op: { type: "string", enum: Object.keys(GIT_READ_OPS) },
      argv: { type: "array", required: false, internal: true }
    },
    normalizeParams,
    // 白名单 read op 之外的 argv 现网不可达(normalizeParams 先抛),分类分支为防御性接线。
    resolveCategory(params) {
      if (GIT_READ_OPS[params.op]) return "read";
      const classification = classifyCommand(params.argv);
      if (classification === "forbidden") return "destructive";
      if (classification === "dangerous") return "execute_dangerous";
      return "read";
    },
    execute: async (params, context) => {
      const normalized = normalizeParams(params);
      const cwd = await resolveWorkspacePath(context.projectRoot, ".", { mustExist: true });
      return runProcess(normalized.argv, { cwd: cwd.real });
    }
  };
}

function normalizeParams(params) {
  const argv = GIT_READ_OPS[params.op];
  if (!argv) throw new Error(`unsupported git read op: ${params.op}`);
  return { ...params, argv };
}
