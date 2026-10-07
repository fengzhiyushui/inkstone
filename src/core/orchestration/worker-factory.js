import { filterToolSchemas } from "./tool-profiles.js";

export function createWorkerFactory({ createRuntime, baseToolSchemas, makeContextSnapshot, modelGateway = null, scope = null }) {
  function worker(subtask) {
    const overrides = {
      toolSchemas: () => filterToolSchemas(baseToolSchemas(), subtask.tool_profile),
      createContextSnapshot: (input) => makeContextSnapshot({ ...input, scope: subtask.context_scope || {} })
    };
    if (scope && modelGateway) {
      overrides.modelGateway = scope.bindGateway(modelGateway, { role: "worker", subtaskId: subtask.id });
    }
    return createRuntime(overrides);
  }
  function reviewerRuntime() {
    const overrides = {
      toolSchemas: () => filterToolSchemas(baseToolSchemas(), "readonly")
    };
    if (scope && modelGateway) {
      overrides.modelGateway = scope.bindGateway(modelGateway, { role: "reviewer" });
    }
    return createRuntime(overrides);
  }
  return { worker, reviewerRuntime };
}
