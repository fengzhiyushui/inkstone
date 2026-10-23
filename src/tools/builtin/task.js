import {
  resolveTaskToolCategory,
  validateTaskParams
} from "../../core/orchestration/task-delegation-contract.js";

export function createTaskTool(options = {}) {
  return {
    name: "task",
    description: "Delegate a bounded subtask with constrained tools",
    category: "execute",
    side_effect: "process",
    risk_level: "medium",
    source: "builtin",
    version: "2.0",
    params: {
      prompt: { type: "string" },
      tools: { type: "array", required: false }
    },
    resolveCategory: (params) => resolveTaskToolCategory(params),
    execute: async (params = {}, context = {}) => {
      const check = validateTaskParams(params);
      if (!check.ok) {
        return {
          status: "error",
          content: [{ type: "error", text: check.error }],
          metadata: { status: "error", code: check.code }
        };
      }
      const service = typeof options.getDelegationService === "function"
        ? options.getDelegationService()
        : (options.delegationService || context.taskDelegationService || null);
      if (!service || typeof service.runTask !== "function") {
        return {
          status: "error",
          content: [{ type: "error", text: "Task delegation service is not configured" }],
          metadata: {
            status: "unavailable",
            code: "TASK_DELEGATION_UNAVAILABLE",
            delegated_tools: check.tools
          }
        };
      }
      return service.runTask(params, context);
    }
  };
}
