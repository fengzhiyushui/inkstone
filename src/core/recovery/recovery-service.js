import { isOrchestrationWorkerSidecar, orchestrationResumeGate } from "../orchestration/orchestration-recovery-contract.js";
import {
  isTaskDelegationParentRecord,
  isTaskChildWorkerRecord,
  taskDelegationResumeGate
} from "../orchestration/task-delegation-contract.js";

export function createRecoveryService({
  projectId,
  lock,
  paused,
  pausedTurnStore,
  inbox,
  appendMarker,
  resumePaused = null,
  cancelPaused = null,
  transactionJournal = null,
  orchPersistence = null,
  resumeOrchestration = null,
  taskPausedPersistence = null,
  rehydrateTaskDelegation = null
}) {
  let latestReport = null;

  async function recoverOnStartup() {
    await lock.assertOwner();
    const recoveryId = `recovery_${Date.now()}`;
    await appendMarker("recovery:started", { recovery_id: recoveryId, project_id: projectId, lock_epoch: lock.epoch });

    const found = [];
    const done = [];
    const blocked = [];
    const next = [];

    async function blockOrchestration(approvalId, reason) {
      blocked.push({ type: "orchestration_paused", summary: `Blocked orchestration: ${approvalId}`, reason });
      await inbox.upsert({ id: `rec_orch_${approvalId}`, type: "blocked_recovery", status: "blocked", source_id: approvalId,
        summary: `Blocked orchestration recovery: ${approvalId}`, evidence: { reason }, allowed_actions: ["cancel"] });
      await appendMarker("recovery:blocked", { item_id: `rec_orch_${approvalId}`, source_id: approvalId, reason });
    }

    async function blockTaskDelegation(approvalId, reason) {
      blocked.push({ type: "paused_turn", source_id: approvalId, summary: `Blocked task delegation: ${approvalId}`, reason });
      await inbox.upsert({
        id: `rec_pause_${approvalId}`,
        type: "blocked_recovery",
        status: "blocked",
        source_id: approvalId,
        summary: `Blocked task delegation recovery: ${approvalId}`,
        evidence: { reason },
        allowed_actions: ["cancel"]
      });
      await appendMarker("recovery:blocked", {
        item_id: `rec_pause_${approvalId}`,
        source_id: approvalId,
        reason
      });
    }

    // Scan transaction journals
    if (transactionJournal) {
      const journals = await transactionJournal.scan();
      for (const journal of journals) {
        if (journal.state === "open" || journal.state === "aborting") {
          found.push({ type: "transaction_journal", summary: `Open ${journal.kind} transaction: ${journal.tx_id}` });
          await inbox.upsert({
            id: `rec_journal_${journal.tx_id}`,
            type: "transaction_journal",
            status: "pending",
            source_id: journal.tx_id,
            summary: `Open ${journal.kind} transaction from ${journal.session_id}`,
            evidence: {
              kind: journal.kind,
              tx_id: journal.tx_id,
              session_id: journal.session_id,
              turn_id: journal.turn_id,
              paths: journal.paths?.map(p => p.path) || [],
              state: journal.state
            },
            allowed_actions: ["abort_journal", "commit_journal"],
            metadata: {
              kind: journal.kind,
              tx_id: journal.tx_id,
              session_id: journal.session_id,
              turn_id: journal.turn_id,
              state: journal.state,
              rewind_branch_state: journal.rewind_branch_state
            }
          });
          await appendMarker("recovery:transaction_journal_found", {
            tx_id: journal.tx_id,
            kind: journal.kind,
            state: journal.state,
            session_id: journal.session_id
          });
          next.push(`/recovery abort_journal rec_journal_${journal.tx_id}`);
        } else if (journal.state === "committed") {
          // Committed journals are informational only
          found.push({ type: "transaction_journal", summary: `Committed ${journal.kind} transaction: ${journal.tx_id}` });
        } else if (journal.state === "corrupt") {
          found.push({ type: "transaction_journal", summary: `Corrupt transaction journal: ${journal.tx_id}` });
          blocked.push({ type: "transaction_journal", summary: `Corrupt journal: ${journal.tx_id}`, reason: journal.error });
          await inbox.upsert({
            id: `rec_journal_${journal.tx_id}`,
            type: "blocked_recovery",
            status: "blocked",
            source_id: journal.tx_id,
            summary: `Corrupt transaction journal: ${journal.tx_id}`,
            evidence: { error: journal.error },
            allowed_actions: ["remove_journal"]
          });
        }
      }
    }

    // Scan paused sidecars. Orchestration-owned worker sidecars and task-delegation parent
    // sidecars are deferred to their respective joins below (never treated as single-agent — CST-4 / T14).
    const scanned = await paused.scan();
    const orchWorkers = new Map();   // approvalId -> valid orchestration worker sidecar
    const taskParents = new Map();   // approvalId -> valid task delegation parent sidecar
    for (const item of scanned) {
      if (item.status === "corrupt") {
        found.push({ type: "paused_turn", summary: `Corrupt paused sidecar: ${item.approval_id}` });
        blocked.push({ type: "paused_turn", summary: `Corrupt paused sidecar: ${item.approval_id}`, reason: item.reason });
        await inbox.upsert({ id: `rec_pause_${item.approval_id}`, type: "blocked_recovery", status: "blocked", source_id: item.approval_id,
          summary: `Corrupt paused sidecar: ${item.approval_id}`, evidence: { sidecar_path: item.path }, allowed_actions: ["cancel"] });
        await appendMarker("recovery:blocked", { item_id: `rec_pause_${item.approval_id}`, source_id: item.approval_id, reason: item.reason || "corrupt sidecar" });
        continue;
      }
      if (item.status === "consumed") continue;
      if (isTaskChildWorkerRecord(item)) {
        await blockTaskDelegation(item.approval_id, "orphaned task child worker sidecar in parent paused directory");
        continue;
      }
      if (isOrchestrationWorkerSidecar(item)) { orchWorkers.set(item.approval_id, item); continue; }  // defer to join
      if (isTaskDelegationParentRecord(item)) { taskParents.set(item.approval_id, item); continue; }  // defer to task delegation join
      // Valid single-agent paused record (unchanged path)
      found.push({ type: "paused_turn", summary: `Paused approval: ${item.approval_id}` });
      pausedTurnStore.restore(item);
      await inbox.upsert({ id: `rec_pause_${item.approval_id}`, type: "paused_turn", status: "pending", source_id: item.approval_id,
        summary: `Paused ${item.surface || "turn"}: ${item.approval?.summary || "approval required"}`, evidence: { sidecar_path: paused.baseDir },
        allowed_actions: ["resume", "cancel"], metadata: { turn_id: item.turn_id, autonomy: item.permission_context?.autonomy || item.turn?.autonomy, surface: item.surface } });
      await appendMarker("turn:rehydrated", { approval_id: item.approval_id, turn_id: item.turn_id, original_session_id: item.session_id, marker_status: "ok" });
      done.push({ type: "paused_turn", summary: `Rehydrated approval: ${item.approval_id}` });
      next.push(`/recovery resume rec_pause_${item.approval_id}`);
    }

    // Pre-scan task-paused sidecars so both single-turn task delegation and orchestrated task delegation can join
    const taskScanned = taskPausedPersistence ? await taskPausedPersistence.scan() : [];
    const taskSidecars = new Map();
    const handledTaskApprovals = new Set();
    for (const tc of taskScanned) {
      if (tc.status === "consumed") continue;
      taskSidecars.set(tc.approval_id, tc);
    }

    // Orchestration join: match each orchestration sidecar to its worker sidecar under
    // the authoritative gate (CST-6 + CST-7). Everything that fails -> blocked (CST-4).
    const handledOrchWorkers = new Set();
    const orchScanned = orchPersistence ? await orchPersistence.scan() : [];
    for (const oc of orchScanned) {
      if (oc.status === "consumed") continue;
      const approvalId = oc.approvalId;
      const workerRecord = orchWorkers.get(approvalId) || null;
      if (workerRecord) handledOrchWorkers.add(approvalId);
      if (oc.status === "corrupt") { await blockOrchestration(approvalId, oc.reason || "corrupt orchestration sidecar"); continue; }
      const gate = orchestrationResumeGate({ sidecar: oc, workerRecord });
      if (!gate.ok) { await blockOrchestration(approvalId, gate.reason); continue; }
      if (isTaskDelegationParentRecord(workerRecord)) {
        handledTaskApprovals.add(approvalId);
        const childSidecar = taskSidecars.get(approvalId) || null;
        if (childSidecar?.status === "corrupt") {
          await blockOrchestration(approvalId, childSidecar.reason || "corrupt task child sidecar");
          continue;
        }
        const taskGate = taskDelegationResumeGate({ parentRecord: workerRecord, childSidecar });
        if (!taskGate.ok) {
          await blockOrchestration(approvalId, taskGate.reason);
          continue;
        }
        rehydrateTaskDelegation?.({ parentRecord: workerRecord, childSidecar, mode: taskGate.mode });
      }
      // OK: restore the worker turn into the shared store so the rebuilt worker's approve sees it.
      pausedTurnStore.restore(workerRecord);
      const completed = (oc.allCollected || []).filter((c) => c.status === "complete").length;
      found.push({ type: "orchestration_paused", summary: `Paused orchestration ${oc.taskId} round ${oc.round}` });
      await inbox.upsert({ id: `rec_orch_${approvalId}`, type: "orchestration_paused", status: "pending", source_id: approvalId,
        summary: `Paused orchestration task ${oc.taskId} (round ${oc.round})`, evidence: { taskId: oc.taskId, round: oc.round, completed },
        allowed_actions: ["resume", "cancel"], metadata: { taskId: oc.taskId, round: oc.round, session_id: oc.sessionId } });
      await appendMarker("turn:rehydrated", { approval_id: approvalId, turn_id: workerRecord.turn_id, original_session_id: oc.sessionId, marker_status: "ok" });
      done.push({ type: "orchestration_paused", summary: `Rehydrated orchestration: ${approvalId}` });
      next.push(`/recovery resume rec_orch_${approvalId}`);
    }
    // Orphan orchestration workers: marked but no matching (valid) orchestration sidecar -> blocked (CST-4).
    for (const [approvalId] of orchWorkers) {
      if (handledOrchWorkers.has(approvalId)) continue;
      const reason = orchPersistence ? "orphaned orchestration worker sidecar (no matching orchestration sidecar)" : "orchestration recovery unavailable";
      blocked.push({ type: "paused_turn", summary: `Blocked orphan orchestration worker: ${approvalId}`, reason });
      await inbox.upsert({ id: `rec_pause_${approvalId}`, type: "blocked_recovery", status: "blocked", source_id: approvalId,
        summary: `Blocked orphan orchestration worker: ${approvalId}`, evidence: { reason }, allowed_actions: ["cancel"] });
      await appendMarker("recovery:blocked", { item_id: `rec_pause_${approvalId}`, source_id: approvalId, reason });
    }

    // Task delegation join (R18-02 T13, T14, T15): match each parent task_delegation record with its task-paused child sidecar.
    for (const [approvalId, childSidecar] of taskSidecars) {
      if (handledTaskApprovals.has(approvalId)) continue;
      handledTaskApprovals.add(approvalId);
      const parentRecord = taskParents.get(approvalId) || null;
      if (childSidecar.status === "corrupt") {
        found.push({ type: "paused_turn", summary: `Corrupt task child sidecar: ${approvalId}` });
        await blockTaskDelegation(approvalId, childSidecar.reason || "corrupt task child sidecar");
        continue;
      }
      const gate = taskDelegationResumeGate({ parentRecord, childSidecar });
      if (!gate.ok) {
        found.push({ type: "paused_turn", summary: `Blocked task delegation: ${approvalId}` });
        await blockTaskDelegation(approvalId, gate.reason);
        continue;
      }
      rehydrateTaskDelegation?.({ parentRecord, childSidecar, mode: gate.mode });
      pausedTurnStore.restore(parentRecord);
      found.push({ type: "paused_turn", summary: `Paused task delegation approval: ${approvalId}` });
      await inbox.upsert({
        id: `rec_pause_${approvalId}`,
        type: "paused_turn",
        status: "pending",
        source_id: approvalId,
        summary: `Paused ${parentRecord.surface || "turn"}: ${parentRecord.approval?.summary || "task approval required"}`,
        evidence: { sidecar_path: paused.baseDir, child_id: childSidecar.child_id, state: childSidecar.state },
        allowed_actions: ["resume", "cancel"],
        metadata: {
          turn_id: parentRecord.turn_id,
          autonomy: parentRecord.permission_context?.autonomy || parentRecord.turn?.autonomy,
          surface: parentRecord.surface,
          child_id: childSidecar.child_id
        }
      });
      await appendMarker("turn:rehydrated", {
        approval_id: approvalId,
        turn_id: parentRecord.turn_id,
        original_session_id: parentRecord.session_id,
        marker_status: "ok"
      });
      done.push({ type: "paused_turn", summary: `Rehydrated task delegation approval: ${approvalId}` });
      next.push(`/recovery resume rec_pause_${approvalId}`);
    }

    // Orphan parent task delegation records with no matching child sidecar -> blocked (T14)
    for (const [approvalId] of taskParents) {
      if (handledTaskApprovals.has(approvalId)) continue;
      const reason = taskPausedPersistence
        ? "orphaned parent task delegation sidecar (task child sidecar missing)"
        : "task delegation recovery persistence unavailable";
      found.push({ type: "paused_turn", summary: `Blocked orphan parent task delegation: ${approvalId}` });
      await blockTaskDelegation(approvalId, reason);
    }

    latestReport = { found, done, blocked, next };
    await appendMarker("recovery:report", {
      recovery_id: recoveryId,
      found_count: found.length,
      done_count: done.length,
      blocked_count: blocked.length,
      next_actions: next
    });

    return latestReport;
  }

  async function list({ includeCleared = false } = {}) {
    const inboxItems = await inbox.list({ includeCleared });
    // Filter out resumed/cancelled items unless includeCleared is true
    const filtered = includeCleared ? inboxItems : inboxItems.filter(item =>
      item.status !== "resumed" && item.status !== "cancelled"
    );
    // Also include any in-memory paused records not yet in inbox
    const memoryPaused = pausedTurnStore.list ? pausedTurnStore.list() : [];
    const inboxIds = new Set(filtered.map(item => item.source_id));
    const memoryItems = memoryPaused
      .filter(record => !inboxIds.has(record.approval_id))
      .map(record => ({
        id: `rec_pause_${record.approval_id}`,
        type: "paused_turn",
        status: "pending",
        source_id: record.approval_id,
        summary: record.approval?.summary || "Approval paused",
        evidence: { sidecar_path: paused.baseDir },
        allowed_actions: ["resume", "cancel"],
        metadata: {
          turn_id: record.turn_id,
          autonomy: record.permission_context?.autonomy || record.turn?.autonomy || "gated",
          surface: record.surface || "unknown"
        },
        created_at: record.created_at || new Date().toISOString(),
        updated_at: record.created_at || new Date().toISOString()
      }));
    return [...filtered, ...memoryItems].sort((a, b) => {
      const byCreated = (a.created_at || "").localeCompare(b.created_at || "");
      return byCreated || a.id.localeCompare(b.id);
    });
  }

  async function resume(id, { decision = "approve" } = {}) {
    if (id.startsWith("rec_orch_")) {
      const approvalId = id.replace(/^rec_orch_/, "");
      if (!resumeOrchestration) throw new Error("orchestration recovery resume not wired");
      const result = await resumeOrchestration(approvalId, decision);
      const item = await inbox.get(id);
      if (item) await inbox.mark(id, { status: "resumed" });
      return { status: "resumed", item, result };
    }
    if (!id.startsWith("rec_pause_")) {
      throw new Error(`invalid resume target: ${id}`);
    }
    const approvalId = id.replace(/^rec_pause_/, "");
    if (!resumePaused) {
      throw new Error("recovery resume not wired");
    }
    const result = await resumePaused(approvalId, decision);
    // Mark as resumed in inbox
    const item = await inbox.get(id);
    if (item) {
      await inbox.mark(id, { status: "resumed" });
    }
    return { status: "resumed", item, result };
  }

  async function cancel(id) {
    if (id.startsWith("rec_orch_")) {
      const approvalId = id.replace(/^rec_orch_/, "");
      const item = await inbox.get(id);
      const orchResult = orchPersistence ? await orchPersistence.quarantine(approvalId, "operator cancelled orchestration recovery").catch(() => null) : null;
      await paused.quarantine(approvalId, "operator cancelled orchestration recovery").catch(() => {});   // best-effort worker sidecar
      if (item) await inbox.mark(id, { status: "cancelled" });
      return { status: "cancelled", item, result: orchResult };
    }
    if (!id.startsWith("rec_pause_")) {
      throw new Error(`invalid cancel target: ${id}`);
    }
    const approvalId = id.replace(/^rec_pause_/, "");

    // Check if this is a blocked corrupt sidecar
    const item = await inbox.get(id);
    if (item && item.type === "blocked_recovery" && item.status === "blocked") {
      // Quarantine the corrupt sidecar (both parent paused and task-paused if present)
      const result = await paused.quarantine(approvalId, "operator cancelled corrupt sidecar");
      if (taskPausedPersistence) {
        await taskPausedPersistence.quarantine(approvalId, "operator cancelled blocked task recovery").catch(() => {});
      }
      await inbox.mark(id, { status: "cancelled" });
      return { status: result.status, item, result };
    }

    // Normal paused turn cancellation
    if (!cancelPaused) {
      throw new Error("recovery cancel not wired");
    }
    const result = await cancelPaused(approvalId);
    if (item) {
      await inbox.mark(id, { status: "cancelled" });
    }
    return { status: "cancelled", item, result };
  }

  async function clear(id) {
    await inbox.clear(id);
    return { status: "cleared" };
  }

  async function abortJournal(id) {
    if (!id.startsWith("rec_journal_")) {
      throw new Error(`invalid abort_journal target: ${id}`);
    }
    if (!transactionJournal) {
      throw new Error("transaction journal not wired");
    }
    const txId = id.replace(/^rec_journal_/, "");
    const item = await inbox.get(id);

    const result = await transactionJournal.abort(txId);

    if (item) {
      await inbox.mark(id, { status: "aborted" });
    }

    await appendMarker("recovery:transaction_journal_aborted", {
      tx_id: txId,
      preserved_count: result.preserved_count
    });

    return { status: "aborted", item, result };
  }

  async function commitJournal(id) {
    if (!id.startsWith("rec_journal_")) {
      throw new Error(`invalid commit_journal target: ${id}`);
    }
    if (!transactionJournal) {
      throw new Error("transaction journal not wired");
    }
    const txId = id.replace(/^rec_journal_/, "");
    const item = await inbox.get(id);

    await transactionJournal.commit(txId, { manual_commit: true });

    if (item) {
      await inbox.mark(id, { status: "committed" });
    }

    await appendMarker("recovery:transaction_journal_committed", {
      tx_id: txId
    });

    return { status: "committed", item };
  }

  function report() {
    return latestReport || { found: [], done: [], blocked: [], next: [] };
  }

  return {
    recoverOnStartup,
    list,
    resume,
    cancel,
    clear,
    abortJournal,
    commitJournal,
    report
  };
}
