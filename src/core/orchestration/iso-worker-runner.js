import { createIso } from "./iso-workspace.js";
import { fsCopyWorkspace, hashTree, changedPaths } from "./workspace-snapshot.js";
import { filterToolSchemas } from "./tool-profiles.js";

// Builds runIsolatedWorker({ subtask, runId }) for the C3 batched parallel path.
// fs copy / manifest / changedPaths are real; the tool-plane, runtime and reviewer
// are injected (the kernel wires the real ones). On any failure it returns
// { st, error, isoRoot } so the dispatch loop marks it failed AND still removes the iso dir.
export function createIsoWorkerRunner({ root, buildToolPlane, createRuntime, makeContextSnapshot, makeReviewer, maxCopyFiles = 5000, planeDeps = {}, modelGateway = null }) {
  return async function runIsolatedWorker({ subtask, runId, scope = null }) {
    const isoRoot = await createIso({ root, runId, subtaskId: subtask.id });
    try {
      const cp = await fsCopyWorkspace(root, isoRoot, { maxCopyFiles });
      if (cp.truncated) { const e = new Error("workspace too large for isolation"); e.code = "COPY_TOO_BIG"; throw e; }
      const baseManifest = await hashTree(isoRoot, { maxCopyFiles });
      const plane = buildToolPlane(isoRoot, planeDeps);
      const overrides = {
        projectRoot: isoRoot,
        executeTool: plane.execute,
        toolSchemas: () => filterToolSchemas(plane.toolRegistry.toDeepSeekTools(), subtask.tool_profile)
      };
      if (scope && modelGateway) {
        overrides.modelGateway = scope.bindGateway(modelGateway, { role: "worker", subtaskId: subtask.id });
      }
      if (makeContextSnapshot) overrides.createContextSnapshot = (input) => makeContextSnapshot({ ...input, projectRoot: isoRoot });
      const worker = createRuntime(overrides);
      const sendOptions = { autonomy: "auto" };
      if (scope?.signal) sendOptions.signal = scope.signal;
      const wres = await worker.send(isoWorkerPrompt(subtask), sendOptions);
      let verdict = { pass: false, severity: "warn", reasons: ["worker did not complete"], checked: [] };
      if (wres.status === "complete") verdict = await makeReviewer(isoRoot, scope).review(subtask, wres, scope?.signal ? { signal: scope.signal } : {});
      const actual = changedPaths(await hashTree(isoRoot, { maxCopyFiles }), baseManifest);
      return { st: subtask, wres, verdict, actual, isoRoot, baseManifest };
    } catch (error) {
      return { st: subtask, error, isoRoot };
    }
  };
}

function isoWorkerPrompt(st) {
  return [
    `Sub-task: ${st.goal}`,
    `Acceptance criteria:\n${(st.acceptance || []).map((a) => `- ${a}`).join("\n")}`
  ].join("\n\n");
}
