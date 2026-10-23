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
    const runtime = createRuntime(overrides);
    if (!scope?.signal) return runtime;
    return {
      ...runtime,
      send: (message, options = {}) => runtime.send(message, { signal: scope.signal, ...options }),
      approve: (id, decision, options = {}) => runtime.approve(id, decision, { signal: scope.signal, ...options })
    };
  }
  function reviewerRuntime() {
    const overrides = {
      toolSchemas: () => filterToolSchemas(baseToolSchemas(), "readonly")
    };
    if (scope && modelGateway) {
      overrides.modelGateway = scope.bindGateway(modelGateway, { role: "reviewer" });
    }
    const runtime = createRuntime(overrides);
    if (!scope?.signal) return runtime;
    return {
      ...runtime,
      send: (message, options = {}) => runtime.send(message, { signal: scope.signal, ...options })
    };
  }
  return { worker, reviewerRuntime };
}
