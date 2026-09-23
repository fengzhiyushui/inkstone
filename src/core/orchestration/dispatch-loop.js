import { topoOrder } from "./subtask-schema.js";
import { withinScope, overlaps } from "./path-overlap.js";
import path from "node:path";

export async function runDispatchLoop({
  plan, workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, onEvent,
  toBatches, maxParallelWorkers = 1, runIsolatedWorker, mergeSubtask, removeIso, projectRules = [], orchestrationMarker = null
}) {
  // C3 batched parallel path: only when explicitly wired + allowed. Otherwise the
  // C1+C2 sequential path runs verbatim (zero regression).
  if (maxParallelWorkers > 1 && typeof toBatches === "function" && typeof runIsolatedWorker === "function") {
    return runBatched({ plan, workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, toBatches, maxParallelWorkers, runIsolatedWorker, mergeSubtask, removeIso, onEvent, projectRules, orchestrationMarker });
  }

  const order = orderOf(plan);
  const deps = { workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, onEvent, toBatches, maxParallelWorkers, runIsolatedWorker, mergeSubtask, removeIso, projectRules, orchestrationMarker };
  const collected = [];
  const failedIds = new Set();
  for (let i = 0; i < order.length; i += 1) {
    const st = order[i];
    const failedDep = (st.depends_on || []).find((dep) => failedIds.has(dep));
    if (failedDep) {
      failedIds.add(st.id);
      collected.push({ st, status: "failed", lastFeedback: `dependency ${failedDep} failed` });
      continue;
    }
    const r = await processSubtask(st, { workerFactory, makeReviewer, maxWorkerAttempts, autonomy, onEvent, projectRules, orchestrationMarker });
    if (r.control === "awaiting_approval") {
      return { status: "awaiting_approval", approval: r.approval, collected,
        resume: { pausedWorker: r.worker, pausedApprovalId: r.approval.id, pausedSubtask: st, remaining: order.slice(i + 1), deps } };
    }
    if (r.entry.status !== "complete") {
      failedIds.add(st.id);
    }
    collected.push(r.entry);
    if (budget.exceeded()) return finishPartial(collected, synthesizer, "budget");
  }
  return finishPartial(collected, synthesizer, null);
}

function orderOf(plan) {
  try { return topoOrder(plan.subtasks); } catch { return [...plan.subtasks]; }
}

// C5: resume a paused round — settle the approved (or denied) paused sub-task,
// then dispatch the remaining sub-tasks. May pause again (carries a new resume).
export async function resumeDispatchLoop(roundResume, decision) {
  const { pausedWorker, pausedApprovalId, pausedSubtask, remaining, deps } = roundResume;
  let pausedEntry;
  if (decision === "deny") {
    pausedEntry = { st: pausedSubtask, status: "failed", lastFeedback: "approval denied" };
  } else {
    const wres = await pausedWorker.approve(pausedApprovalId, "approve");
    if (wres.status === "complete") {
      const verdict = await deps.makeReviewer().review(pausedSubtask, wres);
      pausedEntry = verdict.pass
        ? { st: pausedSubtask, wres, verdict, status: "complete" }
        : { st: pausedSubtask, status: "failed", lastFeedback: (verdict.reasons || []).join("; ") || "review rejected" };
    } else {
      pausedEntry = { st: pausedSubtask, status: "failed", lastFeedback: `resume not complete: ${wres.status}` };
    }
  }
  const sub = await runDispatchLoop({ plan: { subtasks: remaining }, ...deps });
  const collected = [pausedEntry, ...sub.collected];
  if (sub.status === "awaiting_approval") {
    return { status: "awaiting_approval", approval: sub.approval, collected, resume: sub.resume };
  }
  return { status: "complete", collected };
}

async function finishPartial(collected, synthesizer, stopped_reason) {
  const content = await synthesizer.synthesize({ collected });
  return stopped_reason ? { status: "complete", content, collected, stopped_reason } : { status: "complete", content, collected };
}

// One sub-task in the MAIN workspace (C1+C2): worker self-audit + retry, then
// independent reviewer + retry, bounded by maxWorkerAttempts.
async function processSubtask(st, { workerFactory, makeReviewer, maxWorkerAttempts, autonomy, onEvent, projectRules = [], orchestrationMarker = null }) {
  let priorFeedback = null;
  for (let attempt = 1; attempt <= maxWorkerAttempts; attempt += 1) {
    onEvent?.("subtask_started", { subtask_id: st.id, attempt, tool_profile: st.tool_profile });
    const worker = workerFactory.worker(st);
    const sendOptions = { autonomy, projectRules };
    if (orchestrationMarker) sendOptions.__orchestration = { ...orchestrationMarker, subtaskId: st.id };
    const wres = await worker.send(workerPrompt(st, priorFeedback), sendOptions);
    if (wres.status === "awaiting_approval") return { control: "awaiting_approval", approval: wres.approval, worker };
    if (wres.status === "stopped") return { entry: { st, status: "failed", lastFeedback: "worker stopped (budget)" } };
    if (wres.status !== "complete") { priorFeedback = `self-audit failed: ${wres.content || wres.status}`; continue; }
    const verdict = await makeReviewer().review(st, wres);
    onEvent?.("subtask_reviewed", { subtask_id: st.id, pass: verdict.pass, severity: verdict.severity });
    if (verdict.pass) return { entry: { st, wres, verdict, status: "complete" } };
    priorFeedback = (verdict.reasons || []).join("; ") || "review rejected";
  }
  return { entry: { st, status: "failed", lastFeedback: priorFeedback } };
}

// C3: batches (size 1 → main path, no copy; size >1 → isolated parallel + merge).
async function runBatched({ plan, workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, toBatches, maxParallelWorkers, runIsolatedWorker, mergeSubtask, removeIso, onEvent, projectRules = [], orchestrationMarker = null }) {
  const order = orderOf(plan);
  const runId = `run_${order.map((s) => s.id).join("-")}`.slice(0, 80);
  const completedIds = new Set();
  const failedIds = new Set();
  const batches = toBatches(order, { completedIds: new Set(), maxParallelWorkers });
  const collected = [];
  let runDir = null; // parent of iso subtask dirs; cleaned at the end for zero residue

  for (const batch of batches) {
    const runnable = [];
    for (const st of batch) {
      const failedDep = (st.depends_on || []).find((dep) => failedIds.has(dep));
      if (failedDep) {
        failedIds.add(st.id);
        collected.push({ st, status: "failed", lastFeedback: `dependency ${failedDep} failed` });
      } else {
        runnable.push(st);
      }
    }
    if (runnable.length === 0) continue;

    if (runnable.length === 1) {
      const r = await processSubtask(runnable[0], { workerFactory, makeReviewer, maxWorkerAttempts, autonomy, onEvent, projectRules, orchestrationMarker });
      if (r.control === "awaiting_approval") {
        await cleanupRun(runDir, removeIso);
        const remaining = batches.slice(batches.indexOf(batch) + 1).flat();
        const deps = { workerFactory, makeReviewer, synthesizer, budget, maxWorkerAttempts, autonomy, onEvent, toBatches, maxParallelWorkers, runIsolatedWorker, mergeSubtask, removeIso, projectRules, orchestrationMarker };
        return { status: "awaiting_approval", approval: r.approval, collected,
          resume: { pausedWorker: r.worker, pausedApprovalId: r.approval.id, pausedSubtask: runnable[0], remaining, deps } };
      }
      if (r.entry.status === "complete") completedIds.add(runnable[0].id);
      else failedIds.add(runnable[0].id);
      collected.push(r.entry);
    } else {
      const results = await Promise.all(runnable.map((st) =>
        Promise.resolve(runIsolatedWorker({ subtask: st, runId })).catch((error) => ({ st, error }))));
      results.sort((a, b) => (a.st.id < b.st.id ? -1 : a.st.id > b.st.id ? 1 : 0)); // deterministic merge order
      const actuals = results.map((r) => ({ id: r.st.id, paths: actualPaths(r.actual) }));
      for (const r of results) {
        if (r.isoRoot && !runDir) runDir = path.dirname(r.isoRoot);
        try {
          const entry = await settleWorker(r, { mergeSubtask, actuals });
          if (entry.status === "complete") completedIds.add(r.st.id);
          else failedIds.add(r.st.id);
          collected.push(entry);
        }
        finally { if (r.isoRoot && removeIso) await removeIso(r.isoRoot).catch(() => {}); } // zero residue (per copy)
      }
    }
    if (budget.exceeded()) { await cleanupRun(runDir, removeIso); return finishPartial(collected, synthesizer, "budget"); }
  }
  await cleanupRun(runDir, removeIso);
  return finishPartial(collected, synthesizer, null);
}

async function cleanupRun(runDir, removeIso) {
  if (runDir && removeIso) await removeIso(runDir).catch(() => {}); // remove run dir + .owner marker
}

function actualPaths(actual) { return actual ? [...actual.added, ...actual.modified, ...actual.deleted] : []; }

async function settleWorker(r, { mergeSubtask, actuals }) {
  if (r.error || !r.wres || r.wres.status !== "complete") {
    return { st: r.st, status: "failed", lastFeedback: r.error?.message || "worker did not complete" };
  }
  if (!r.verdict?.pass) {
    return { st: r.st, status: "failed", lastFeedback: (r.verdict?.reasons || []).join("; ") || "review rejected" };
  }
  // actual write-scope validation (do not trust declared scope)
  const declared = r.st.context_scope?.files || [];
  const paths = actualPaths(r.actual);
  const stray = withinScope(paths, declared);
  if (stray.length) return { st: r.st, status: "failed", lastFeedback: `out-of-scope writes: ${stray.join(", ")}` };
  // cross-worker actual overlap (defense beyond declared disjointness)
  for (const other of actuals) {
    if (other.id === r.st.id) continue;
    if (overlaps(paths, other.paths)) return { st: r.st, status: "failed", lastFeedback: `actual file overlap with ${other.id}` };
  }
  const merged = await mergeSubtask(r);
  if (!merged.ok) return { st: r.st, status: "failed", lastFeedback: merged.reason };
  return { st: r.st, wres: r.wres, verdict: r.verdict, status: "complete", change_id: merged.change_id };
}

function workerPrompt(st, priorFeedback) {
  return [
    `Sub-task: ${st.goal}`,
    `Acceptance criteria:\n${(st.acceptance || []).map((a) => `- ${a}`).join("\n")}`,
    priorFeedback ? `A previous attempt was rejected. Address this feedback: ${priorFeedback}` : ""
  ].filter(Boolean).join("\n\n");
}
