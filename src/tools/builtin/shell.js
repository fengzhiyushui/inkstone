import { classifyCommand } from "../../security/command-policy.js";
import { normalizeShellParams, runProcess } from "../../security/shell-policy.js";
import { resolveWorkspacePath } from "../../workspace/path-safety.js";

export function createShellTool() {
  return {
    name: "shell",
    description: "Execute a structured argv command inside the workspace",
    category: "execute",
    side_effect: "process",
    risk_level: "medium",
    source: "builtin",
    version: "2.0",
    params: {
      argv: { type: "array", description: "Command and arguments" },
      cwd: { type: "string", required: false, default: "." },
      timeout_ms: { type: "number", required: false, default: 30000 },
      shell: { type: "boolean", required: false, internal: true }
    },
    normalizeParams: normalizeShellParams,
    resolveCategory(params) {
      const classification = classifyCommand(params.argv);
      if (classification === "forbidden") return "destructive";
      if (classification === "dangerous") return "execute_dangerous";
      return "execute";
    },
    execute: async (params, context) => {
      const normalized = normalizeShellParams(params);
      const cwd = await resolveWorkspacePath(context.projectRoot, normalized.cwd, { mustExist: true });
      return runProcess(normalized.argv, {
        cwd: cwd.real,
        timeoutMs: normalized.timeout_ms,
        signal: context.signal
      });
    }
  };
}
