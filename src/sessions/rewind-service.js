import { makeId } from "../shared/id.js";
import {
  buildCheckpointIndex,
  computeRollbackPlan,
  resolveRewindTarget
} from "./checkpoint-index.js";
import {
  captureRewindSnapshots,
  restoreRewindSnapshots,
  safeRewindError
} from "./rewind-transaction.js";

export function createRewindService({
  eventBus = null,
  projectRoot = null,
  getTimeline,
  getActiveBranchId,
  createBranch = null,
  activateBranch = null,
  rollback,
  captureSnapshots = captureRewindSnapshots,
  restoreSnapshots = restoreRewindSnapshots,
  recoveryJournal = null,
  assertOwner = async () => {},
  faults = null
} = {}) {
  if (typeof getTimeline !== "function") throw new Error("getTimeline is required");
  if (typeof getActiveBranchId !== "function") throw new Error("getActiveBranchId is required");
  if (typeof rollback !== "function") throw new Error("rollback is required");

  async function preview({ target, branch_id = null } = {}) {
    const branchId = branch_id || await getActiveBranchId();
    const timeline = await getTimeline({ count: 10000, branch_id: branchId });
    const index = buildCheckpointIndex(timeline, { branch_id: branchId });
    const resolvedTarget = resolveRewindTarget(index, target);
    const plan = computeRollbackPlan(index, resolvedTarget);
    const plannedBranchId = makeId("br");
    const result = {
      status: "success",
      target: resolvedTarget,
      current_branch_id: branchId,
      planned_branch_id: plannedBranchId,
      rollback_change_ids: plan.change_ids,
      rollback_count: plan.rollback_count,
      files: plan.files,
      force_required: false
    };
    publish("session:rewind_preview", safeRewindPayload(result));
    return result;
  }

  async function restoreAfterFailure({
    previewResult,
    snapshots,
    appliedRollbacks,
    phase,
    reason,
    force
  }) {
    const base = {
      current_branch_id: previewResult.current_branch_id,
      attempted_branch_id: previewResult.planned_branch_id,
      phase,
      applied_rollbacks: appliedRollbacks,
      forced: Boolean(force),
      reason
    };
    publish("session:rewind_restore_started", base);
    try {
      const restoredFiles = projectRoot ? await restoreSnapshots(projectRoot, snapshots) : [];
      const restored = {
        status: "failed_restored",
        ...base,
        restored_files: restoredFiles
      };
      publish("session:rewind_restored", restored);
      publish("session:rewind_failed", restored);
      return restored;
    } catch (restoreError) {
      const failed = {
        status: "failed_unrestorable",
        ...base,
        restored_files: [],
        restore_error: safeRewindError(restoreError, "restore")
      };
      publish("session:rewind_recovery_failed", failed);
      publish("session:rewind_failed", failed);
      return failed;
    }
  }

  async function restoreAfterConflict({
    previewResult,
    snapshots,
    appliedRollbacks,
    failedChangeId,
    conflicts,
    force
  }) {
    if (appliedRollbacks.length === 0) {
      const conflict = {
        status: "conflict",
        current_branch_id: previewResult.current_branch_id,
        attempted_branch_id: previewResult.planned_branch_id,
        failed_change_id: failedChangeId,
        applied_rollbacks: appliedRollbacks,
        remaining_change_ids: previewResult.rollback_change_ids.slice(appliedRollbacks.length),
        conflicts,
        forced: Boolean(force)
      };
      publish("session:rewind_conflict", conflict);
      return conflict;
    }
    const restored = await restoreAfterFailure({
      previewResult,
      snapshots,
      appliedRollbacks,
      phase: "rollback",
      reason: "rollback_failed",
      force
    });
    const conflictRestored = {
      ...restored,
      status: restored.status === "failed_unrestorable" ? "failed_unrestorable" : "conflict_restored",
      failed_change_id: failedChangeId,
      conflicts
    };
    publish("session:rewind_conflict", conflictRestored);
    return conflictRestored;
  }

  async function apply({ target, branch_id = null, force = false, label = "" } = {}) {
    if (typeof createBranch !== "function") throw new Error("createBranch is required for apply");
    if (typeof activateBranch !== "function") throw new Error("activateBranch is required for apply");
    const previewResult = await preview({ target, branch_id });
    const currentBranchId = previewResult.current_branch_id;

    const transaction_id = `tx_rewind_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;

    // Open recovery journal before mutations
    let journalEntry = null;
    if (recoveryJournal) {
      journalEntry = await recoveryJournal.open({
        kind: "rewind",
        tx_id: transaction_id,
        session_id: currentBranchId,
        turn_id: previewResult.target.turn_id || "rewind",
        owner_epoch: 0,
        paths: previewResult.files,
        rewind_branch_state: {
          current_branch_id: currentBranchId,
          target_branch_id: previewResult.planned_branch_id,
          target_event_id: previewResult.target.event_id,
          target_seq: previewResult.target.seq,
          target_turn_id: previewResult.target.turn_id,
          rollback_change_ids: previewResult.rollback_change_ids
        },
        target: {
          type: "rewind",
          description: `rewind to ${previewResult.target.turn_id || previewResult.target.event_id}`
        }
      });
      if (faults) await faults.maybe("after-journal-write");
    }

    publish("session:rewind_started", {
      current_branch_id: currentBranchId,
      target: previewResult.target,
      rollback_change_ids: previewResult.rollback_change_ids,
      forced: Boolean(force)
    });

    const snapshots = projectRoot
      ? await captureSnapshots(projectRoot, previewResult.files)
      : [];

    const appliedRollbacks = [];
    for (const changeId of previewResult.rollback_change_ids) {
      try {
        await assertOwner();
        if (faults) await faults.maybe("before-rollback");
      } catch (error) {
        if (journalEntry) await recoveryJournal.abort(transaction_id).catch(() => {});
        return restoreAfterFailure({
          previewResult,
          snapshots,
          appliedRollbacks,
          phase: "rollback",
          reason: safeRewindError(error, "assertOwner"),
          force
        });
      }

      const result = await rollback({ change_id: changeId, force: Boolean(force), branch_id: previewResult.planned_branch_id });
      if (result.status === "conflict") {
        if (journalEntry) await recoveryJournal.abort(transaction_id).catch(() => {});
        return restoreAfterConflict({
          previewResult,
          snapshots,
          appliedRollbacks,
          failedChangeId: changeId,
          conflicts: result.metadata?.conflicts || [],
          force
        });
      }
      if (result.status !== "success") {
        if (journalEntry) await recoveryJournal.abort(transaction_id).catch(() => {});
        return restoreAfterFailure({
          previewResult,
          snapshots,
          appliedRollbacks,
          phase: "rollback",
          reason: safeRewindError(new Error("rollback failed"), "rollback"),
          force
        });
      }
      appliedRollbacks.push(changeId);
      if (faults) await faults.maybe("after-rollback");
    }

    let branch;
    try {
      await assertOwner();
      branch = await createBranch({
        parent_branch_id: currentBranchId,
        forked_from_event_id: previewResult.target.event_id,
        forked_from_seq: previewResult.target.seq,
        forked_from_turn_id: previewResult.target.turn_id,
        label: label || `rewind to ${previewResult.target.turn_id || previewResult.target.event_id || previewResult.target.seq}`,
        branch_id: previewResult.planned_branch_id
      });
      if (faults) await faults.maybe("after-branch-created");
    } catch (error) {
      if (journalEntry) await recoveryJournal.abort(transaction_id).catch(() => {});
      return restoreAfterFailure({
        previewResult,
        snapshots,
        appliedRollbacks,
        phase: "create_branch",
        reason: safeRewindError(error, "create_branch"),
        force
      });
    }
    publish("session:branch_created", {
      branch_id: branch.branch_id,
      parent_branch_id: branch.parent_branch_id,
      forked_from_event_id: branch.forked_from_event_id,
      forked_from_seq: branch.forked_from_seq,
      forked_from_turn_id: branch.forked_from_turn_id
    });
    try {
      await assertOwner();
      await activateBranch(branch.branch_id);
      if (faults) await faults.maybe("after-branch-activated");
    } catch (error) {
      if (journalEntry) await recoveryJournal.abort(transaction_id).catch(() => {});
      return restoreAfterFailure({
        previewResult,
        snapshots,
        appliedRollbacks,
        phase: "activate_branch",
        reason: safeRewindError(error, "activate_branch"),
        force
      });
    }
    publish("session:branch_activated", {
      branch_id: branch.branch_id,
      parent_branch_id: branch.parent_branch_id
    });

    // Commit journal after successful rewind
    if (journalEntry) {
      try {
        await recoveryJournal.commit(transaction_id, {
          branch_id: branch.branch_id,
          rollback_change_ids: previewResult.rollback_change_ids,
          files: previewResult.files
        });
        if (faults) await faults.maybe("after-manifest-committed");
      } catch (commitError) {
        if (journalEntry) await recoveryJournal.abort(transaction_id).catch(() => {});
        return restoreAfterFailure({
          previewResult,
          snapshots,
          appliedRollbacks,
          phase: "commit_journal",
          reason: safeRewindError(commitError, "commit_journal"),
          force
        });
      }
    }

    const success = {
      status: "success",
      previous_branch_id: currentBranchId,
      branch_id: branch.branch_id,
      target: previewResult.target,
      rollback_change_ids: previewResult.rollback_change_ids,
      applied_rollbacks: appliedRollbacks,
      files: previewResult.files,
      forced: Boolean(force)
    };
    publish("session:rewind_applied", success);
    return success;
  }

  function publish(type, data) {
    eventBus?.publish?.(type, data);
  }

  return { preview, apply };
}

function safeRewindPayload(result) {
  return {
    target: result.target,
    current_branch_id: result.current_branch_id,
    planned_branch_id: result.planned_branch_id,
    rollback_change_ids: result.rollback_change_ids,
    rollback_count: result.rollback_count,
    files: result.files,
    force_required: result.force_required
  };
}
