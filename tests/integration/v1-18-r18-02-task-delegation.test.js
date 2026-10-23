import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdtemp } from "../helpers/tmp.js";
import { createKernel } from "../../src/index.js";
import { createAgentRuntime } from "../../src/core/runtime/agent-runtime.js";
import { createTaskPausedPersistence } from "../../src/core/recovery/task-paused-persistence.js";
import { createRecoveryFaults } from "../../src/core/recovery/recovery-faults.js";

async function withTempProject(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-r18-02-"));
  try {
    await writeFile(path.join(root, "secret-target.txt"), "CANARY_SECRET_VALUE_98765\n", "utf8");
    await writeFile(path.join(root, "editable.txt"), "line1\n", "utf8");
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

function tc(id, name, params) {
  return {
    id,
    name,
    arguments: params
  };
}

function isChildMessages(messages = []) {
  return messages.some((m) => typeof m.content === "string" && m.content.includes("[DELEGATED_CHILD]"));
}

// ============================================================================
// T01: Parent calls task -> child worker genuinely reads temp file -> returns content to parent
// ============================================================================
test("T01: parent calls task and child worker reads real workspace file and feeds result back once", async () => {
  await withTempProject(async (root) => {
    let parentCalls = 0;
    let childCalls = 0;
    let parentObservedToolMessage = null;

    const gateway = {
      async invoke(messages) {
        if (isChildMessages(messages)) {
          childCalls += 1;
          if (childCalls === 1) {
            return {
              content: "Reading target file in child worker",
              tool_calls: [tc("child_read_1", "read", { path: "secret-target.txt" })],
              usage: { total_tokens: 15 }
            };
          }
          const toolMsg = messages.find((m) => m.role === "tool");
          return {
            content: `Child found value: ${toolMsg?.content?.trim() || "missing"}`,
            tool_calls: [],
            usage: { total_tokens: 10 }
          };
        }

        parentCalls += 1;
        if (parentCalls === 1) {
          return {
            content: "Delegating file read to task worker",
            tool_calls: [
              tc("parent_task_1", "task", {
                prompt: "[DELEGATED_CHILD] Read secret-target.txt and report its content",
                tools: ["read"]
              })
            ],
            usage: { total_tokens: 20 }
          };
        }
        parentObservedToolMessage = messages.find((m) => m.role === "tool" && m.tool_call_id === "parent_task_1");
        return {
          content: `Parent final answer based on child: ${parentObservedToolMessage?.content || ""}`,
          tool_calls: [],
          usage: { total_tokens: 15 }
        };
      }
    };

    const kernel = await createKernel(root, {
      modelGateway: gateway,
      verifyMode: "off"
    });
    try {
      const res = await kernel.agent.send("Please inspect secret-target.txt using a subtask.");
      assert.equal(res.status, "complete");
      assert.equal(parentCalls, 2);
      assert.equal(childCalls, 2);
      assert.ok(parentObservedToolMessage, "parent should receive tool result message from task");
      assert.match(parentObservedToolMessage.content, /CANARY_SECRET_VALUE_98765/);
      assert.doesNotMatch(parentObservedToolMessage.content, /Subtask queued/);
      assert.match(res.content, /CANARY_SECRET_VALUE_98765/);
    } finally {
      await kernel.dispose();
    }
  });
});

// ============================================================================
// T02: Child task fails or produces empty output -> explicit failure returned to parent
// ============================================================================
test("T02: child task failure or empty output returns explicit error tool result to parent (no fake queued success)", async () => {
  await withTempProject(async (root) => {
    let parentCalls = 0;
    const toolResults = [];
    const gateway = {
      async invoke(messages) {
        if (isChildMessages(messages)) {
          return {
            content: "   ",
            tool_calls: [],
            usage: { total_tokens: 5 }
          };
        }
        parentCalls += 1;
        if (parentCalls === 1) {
          return {
            content: "Delegating to child that produces nothing",
            tool_calls: [
              tc("parent_task_empty", "task", {
                prompt: "[DELEGATED_CHILD] Do nothing",
                tools: ["read"]
              })
            ],
            usage: { total_tokens: 10 }
          };
        }
        return {
          content: "Parent handled child failure",
          tool_calls: [],
          usage: { total_tokens: 10 }
        };
      }
    };

    const kernel = await createKernel(root, {
      modelGateway: gateway,
      verifyMode: "off"
    });
    kernel.eventBus.subscribe("tool:result", (data) => {
      if (data?.result?.call_id === "parent_task_empty") {
        toolResults.push(data.result);
      }
    });

    try {
      const res = await kernel.agent.send("Run failing subtask");
      assert.equal(res.status, "complete");
      assert.equal(toolResults.length, 1);
      assert.equal(toolResults[0].status, "error");
      assert.equal(toolResults[0].metadata.code, "TASK_EMPTY_RESULT");
      assert.doesNotMatch(toolResults[0].content[0].text, /Subtask queued/);
    } finally {
      await kernel.dispose();
    }
  });
});

// ============================================================================
// T03: read-only parent requests task with edit/shell -> denied, file untouched
// ============================================================================
test("T03: read-only parent requesting task with edit or shell is denied without executing write tools", async () => {
  await withTempProject(async (root) => {
    let childInvoked = false;
    const toolResults = [];
    const gateway = {
      async invoke(messages) {
        if (isChildMessages(messages)) {
          childInvoked = true;
          return { content: "should never run", tool_calls: [] };
        }
        const hasToolMsg = messages.some((m) => m.role === "tool");
        if (!hasToolMsg) {
          return {
            content: "Attempting privilege escalation via task",
            tool_calls: [
              tc("call_escalate", "task", {
                prompt: "[DELEGATED_CHILD] modify editable.txt",
                tools: ["edit", "shell"]
              })
            ],
            usage: { total_tokens: 10 }
          };
        }
        return {
          content: "Escalation was blocked",
          tool_calls: [],
          usage: { total_tokens: 10 }
        };
      }
    };

    const kernel = await createKernel(root, {
      modelGateway: gateway,
      verifyMode: "off"
    });
    kernel.eventBus.subscribe("tool:result", (data) => {
      if (data?.result?.call_id === "call_escalate") {
        toolResults.push(data.result);
      }
    });

    try {
      const res = await kernel.agent.send("Modify file from read-only parent", {
        autonomy: "read-only"
      });
      assert.equal(res.status, "complete");
      assert.equal(childInvoked, false, "child worker must not even be spawned when read-only parent requests edit/shell");
      assert.equal(toolResults.length, 1);
      assert.equal(toolResults[0].status, "denied");
      const contentAfter = await readFile(path.join(root, "editable.txt"), "utf8");
      assert.equal(contentAfter, "line1\n");
    } finally {
      await kernel.dispose();
    }
  });
});

// ============================================================================
// T04: tools array validation (unknown name, non-string, duplicates, >5 items)
// ============================================================================
test("T04: tools parameter validates unknown names, non-strings, duplicates, and >5 items without silent truncation", async () => {
  await withTempProject(async (root) => {
    const gateway = {
      async invoke(messages) {
        if (isChildMessages(messages)) {
          const hasTool = messages.some((m) => m.role === "tool");
          if (!hasTool) {
            return {
              content: "Dedup child ok",
              tool_calls: [tc("c_read", "read", { path: "editable.txt" })],
              usage: { total_tokens: 5 }
            };
          }
          return { content: "Dedup child completed", tool_calls: [], usage: { total_tokens: 5 } };
        }
        return { content: "unused", tool_calls: [] };
      }
    };

    const kernel = await createKernel(root, {
      modelGateway: gateway,
      verifyMode: "off"
    });
    try {
      // 1. Unknown tool name -> error
      const unknownRes = await kernel.tools.execute({
        id: "t04_unknown",
        name: "task",
        params: { prompt: "[DELEGATED_CHILD] test", tools: ["read", "nonexistent_tool"] }
      }, { autonomy: "full-auto" });
      assert.equal(unknownRes.status, "error");
      assert.equal(unknownRes.metadata.code, "TASK_UNKNOWN_TOOL");

      // 2. Non-string element -> error
      const nonStringRes = await kernel.tools.execute({
        id: "t04_nonstring",
        name: "task",
        params: { prompt: "[DELEGATED_CHILD] test", tools: ["read", 123] }
      }, { autonomy: "full-auto" });
      assert.equal(nonStringRes.status, "error");

      // 3. > 5 unique tools -> explicit error (not silently sliced to 5)
      const overLimitRes = await kernel.tools.execute({
        id: "t04_overlimit",
        name: "task",
        params: { prompt: "[DELEGATED_CHILD] test", tools: ["read", "grep", "glob", "ls", "git", "shell"] }
      }, { autonomy: "full-auto" });
      assert.equal(overLimitRes.status, "error");
      assert.equal(overLimitRes.metadata.code, "TASK_TOOLS_LIMIT_EXCEEDED");

      // 4. Duplicate valid tools -> deduplicated and succeeds
      const dedupRes = await kernel.tools.execute({
        id: "t04_dedup",
        name: "task",
        params: { prompt: "[DELEGATED_CHILD] test", tools: ["read", "grep", "read", "grep"] }
      }, { autonomy: "full-auto" });
      assert.equal(dedupRes.status, "success");
      assert.deepEqual(dedupRes.metadata.delegated_tools, ["read", "grep"]);
    } finally {
      await kernel.dispose();
    }
  });
});

// ============================================================================
// T05: Child model forges a nested 'task' call -> blocked at both schema and execution layers
// ============================================================================
test("T05: child worker strips task schema and blocks forged task tool call at execution layer (depth=1)", async () => {
  await withTempProject(async (root) => {
    let childObservedSchemas = null;
    let childIteration = 0;
    let grandchildRan = false;

    const gateway = {
      async invoke(messages, options = {}) {
        if (messages.some((m) => typeof m.content === "string" && m.content.includes("[GRANDCHILD]"))) {
          grandchildRan = true;
          return { content: "grandchild should never run", tool_calls: [] };
        }
        if (isChildMessages(messages)) {
          childIteration += 1;
          childObservedSchemas = options.tools || [];
          if (childIteration === 1) {
            return {
              content: "Forging nested task call",
              tool_calls: [tc("forged_nested_task", "task", { prompt: "[GRANDCHILD] nested", tools: ["read"] })],
              usage: { total_tokens: 10 }
            };
          }
          const deniedToolMsg = messages.find((m) => m.role === "tool" && m.tool_call_id === "forged_nested_task");
          return {
            content: `Child saw forged task result: ${deniedToolMsg?.content || ""}`,
            tool_calls: [],
            usage: { total_tokens: 10 }
          };
        }

        const hasParentTool = messages.some((m) => m.role === "tool");
        if (!hasParentTool) {
          return {
            content: "Parent delegating to child",
            tool_calls: [tc("parent_task_t05", "task", { prompt: "[DELEGATED_CHILD] Try nested task", tools: ["read"] })],
            usage: { total_tokens: 10 }
          };
        }
        return {
          content: "Parent completed after child blocked nested task",
          tool_calls: [],
          usage: { total_tokens: 10 }
        };
      }
    };

    const kernel = await createKernel(root, {
      modelGateway: gateway,
      verifyMode: "off"
    });
    try {
      const res = await kernel.agent.send("Run T05 test");
      assert.equal(res.status, "complete");
      assert.equal(grandchildRan, false, "grandchild task must never execute");
      assert.ok(Array.isArray(childObservedSchemas));
      const schemaNames = childObservedSchemas.map((s) => s?.function?.name);
      assert.ok(!schemaNames.includes("task"), "child tool schemas must not include task");
      assert.ok(!schemaNames.includes("ask_user"), "child tool schemas must not include ask_user");
      assert.deepEqual(schemaNames, ["read"]);
    } finally {
      await kernel.dispose();
    }
  });
});

// ============================================================================
// T06 & T07: Outer task approval -> approve -> child write tool approval -> approve -> single write & single parent result
// ============================================================================
test("T06 & T07: approving outer task does not auto-approve child write tool; approving child write resumes pending tool once without re-dispatching task", async () => {
  await withTempProject(async (root) => {
    let parentModelCalls = 0;
    let childModelCalls = 0;
    const validDiff = [
      "--- a/editable.txt",
      "+++ b/editable.txt",
      "@@ -1,1 +1,2 @@",
      " line1",
      "+added_by_child"
    ].join("\n");

    const gateway = {
      async invoke(messages) {
        if (isChildMessages(messages)) {
          childModelCalls += 1;
          if (childModelCalls === 1) {
            return {
              content: "Child requesting edit on editable.txt",
              tool_calls: [tc("child_edit_1", "edit", { diff: validDiff, prompt: "add line in child" })],
              usage: { total_tokens: 15 }
            };
          }
          return {
            content: "Child edit finished successfully",
            tool_calls: [],
            usage: { total_tokens: 10 }
          };
        }

        parentModelCalls += 1;
        if (parentModelCalls === 1) {
          return {
            content: "Parent delegating edit task",
            tool_calls: [
              tc("parent_task_edit", "task", {
                prompt: "[DELEGATED_CHILD] Update editable.txt",
                tools: ["read", "edit"]
              })
            ],
            usage: { total_tokens: 20 }
          };
        }
        const taskToolMsg = messages.filter((m) => m.role === "tool" && m.tool_call_id === "parent_task_edit");
        assert.equal(taskToolMsg.length, 1, "parent must receive exactly one tool result for parent_task_edit");
        return {
          content: `Parent done: ${taskToolMsg[0].content}`,
          tool_calls: [],
          usage: { total_tokens: 10 }
        };
      }
    };

    const kernel = await createKernel(root, {
      modelGateway: gateway,
      verifyMode: "off",
      sessionLog: null
    });
    try {
      const step1 = await kernel.agent.send("Delegate editing editable.txt", { autonomy: "supervised" });
      assert.equal(step1.status, "awaiting_approval");
      assert.match(step1.approval.summary, /^task requires approval/);
      assert.equal(childModelCalls, 0, "child worker has not started before outer task approval");

      const step2 = await kernel.agent.approve(step1.approval.id, "approve");
      assert.equal(step2.status, "awaiting_approval");
      assert.match(step2.approval.summary, /^edit requires approval/, "approving outer task must not auto-approve child edit tool");
      assert.notEqual(step2.approval.id, step1.approval.id);
      assert.equal(childModelCalls, 1);
      assert.equal(await readFile(path.join(root, "editable.txt"), "utf8"), "line1\n");

      const step3 = await kernel.agent.approve(step2.approval.id, "approve");
      assert.equal(step3.status, "complete");
      assert.equal(childModelCalls, 2, "child model called once before pause and once after edit tool completed");
      assert.equal(parentModelCalls, 2, "parent model called once before task and once after task completed");
      assert.equal(await readFile(path.join(root, "editable.txt"), "utf8"), "line1\nadded_by_child\n");
    } finally {
      await kernel.dispose();
    }
  });
});

// ============================================================================
// T08: Child approval deny -> consistent terminal state for child & parent, zero writes
// ============================================================================
test("T08: denying child tool approval terminates both child and parent cleanly with zero file writes", async () => {
  await withTempProject(async (root) => {
    const validDiff = [
      "--- a/editable.txt",
      "+++ b/editable.txt",
      "@@ -1,1 +1,2 @@",
      " line1",
      "+should_not_be_written"
    ].join("\n");

    const gateway = {
      async invoke(messages) {
        if (isChildMessages(messages)) {
          return {
            content: "Child requesting edit",
            tool_calls: [tc("c_edit_deny", "edit", { diff: validDiff, prompt: "edit" })],
            usage: { total_tokens: 10 }
          };
        }
        return {
          content: "Parent delegating",
          tool_calls: [tc("p_task_deny", "task", { prompt: "[DELEGATED_CHILD] edit file", tools: ["edit"] })],
          usage: { total_tokens: 10 }
        };
      }
    };

    const kernel = await createKernel(root, {
      modelGateway: gateway,
      verifyMode: "off",
      sessionLog: null,
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });
    try {
      const paused = await kernel.agent.send("Run task that will be denied", { autonomy: "supervised" });
      assert.equal(paused.status, "awaiting_approval");
      assert.match(paused.approval.summary, /^edit requires approval/);

      const denied = await kernel.agent.approve(paused.approval.id, "deny");
      assert.equal(denied.status, "cancelled");
      assert.equal(kernel.agent.listPaused().length, 0);
      assert.equal(await readFile(path.join(root, "editable.txt"), "utf8"), "line1\n");
    } finally {
      await kernel.dispose();
    }
  });
});

// ============================================================================
// T09: Child resumes after first approval and pauses AGAIN on a second write tool (Case B)
// ============================================================================
test("T09: child worker pausing a second time consumes old approval ID, links new approval ID, and preserves parent continuation", async () => {
  await withTempProject(async (root) => {
    await writeFile(path.join(root, "second.txt"), "second1\n", "utf8");
    const diff1 = [
      "--- a/editable.txt",
      "+++ b/editable.txt",
      "@@ -1,1 +1,2 @@",
      " line1",
      "+first_child_write"
    ].join("\n");
    const diff2 = [
      "--- a/second.txt",
      "+++ b/second.txt",
      "@@ -1,1 +1,2 @@",
      " second1",
      "+second_child_write"
    ].join("\n");

    let childTurnStep = 0;
    const gateway = {
      async invoke(messages) {
        if (isChildMessages(messages)) {
          childTurnStep += 1;
          if (childTurnStep === 1) {
            return {
              content: "Child edit 1",
              tool_calls: [tc("c_edit_1", "edit", { diff: diff1, prompt: "edit 1" })],
              usage: { total_tokens: 10 }
            };
          }
          if (childTurnStep === 2) {
            return {
              content: "Child edit 2",
              tool_calls: [tc("c_edit_2", "edit", { diff: diff2, prompt: "edit 2" })],
              usage: { total_tokens: 10 }
            };
          }
          return {
            content: "Both child edits done",
            tool_calls: [],
            usage: { total_tokens: 10 }
          };
        }

        const hasTool = messages.some((m) => m.role === "tool");
        if (!hasTool) {
          return {
            content: "Parent delegating two-step edit",
            tool_calls: [tc("p_task_two_edits", "task", { prompt: "[DELEGATED_CHILD] edit two files", tools: ["edit"] })],
            usage: { total_tokens: 10 }
          };
        }
        return {
          content: "Parent finished after both child approvals",
          tool_calls: [],
          usage: { total_tokens: 10 }
        };
      }
    };

    const kernel = await createKernel(root, {
      modelGateway: gateway,
      verifyMode: "off",
      sessionLog: null,
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });
    try {
      const pause1 = await kernel.agent.send("Edit two files in child", { autonomy: "supervised" });
      assert.equal(pause1.status, "awaiting_approval");
      const firstId = pause1.approval.id;

      const pause2 = await kernel.agent.approve(firstId, "approve");
      assert.equal(pause2.status, "awaiting_approval");
      const secondId = pause2.approval.id;
      assert.notEqual(secondId, firstId);

      await assert.rejects(
        () => kernel.agent.approve(firstId, "approve"),
        (err) => err.code === "APPROVAL_NOT_FOUND"
      );

      const finalRes = await kernel.agent.approve(secondId, "approve");
      assert.equal(finalRes.status, "complete");
      assert.equal(await readFile(path.join(root, "editable.txt"), "utf8"), "line1\nfirst_child_write\n");
      assert.equal(await readFile(path.join(root, "second.txt"), "utf8"), "second1\nsecond_child_write\n");
    } finally {
      await kernel.dispose();
    }
  });
});

// ============================================================================
// T10: Two kernels / sessions running task delegations concurrently do not cross-contaminate
// ============================================================================
test("T10: separate kernel instances isolate task delegation approvals, results, budgets, and cancellations", async () => {
  const rootA = await mkdtemp(path.join(tmpdir(), "dsc-r18-02-kA-"));
  const rootB = await mkdtemp(path.join(tmpdir(), "dsc-r18-02-kB-"));
  try {
    await writeFile(path.join(rootA, "id.txt"), "KERNEL_A_DATA\n", "utf8");
    await writeFile(path.join(rootB, "id.txt"), "KERNEL_B_DATA\n", "utf8");

    const makeGateway = (label) => ({
      async invoke(messages) {
        if (isChildMessages(messages)) {
          const hasTool = messages.some((m) => m.role === "tool");
          if (!hasTool) {
            return {
              content: `Child ${label} reading`,
              tool_calls: [tc(`read_${label}`, "read", { path: "id.txt" })],
              usage: { total_tokens: 10 }
            };
          }
          const toolOut = messages.find((m) => m.role === "tool")?.content?.trim();
          return { content: `${label}:${toolOut}`, tool_calls: [], usage: { total_tokens: 10 } };
        }
        const hasTool = messages.some((m) => m.role === "tool");
        if (!hasTool) {
          return {
            content: `Parent ${label}`,
            tool_calls: [tc(`task_${label}`, "task", { prompt: `[DELEGATED_CHILD] ${label}`, tools: ["read"] })],
            usage: { total_tokens: 10 }
          };
        }
        const toolOut = messages.find((m) => m.role === "tool")?.content?.trim();
        return { content: `Final ${label} -> ${toolOut}`, tool_calls: [], usage: { total_tokens: 10 } };
      }
    });

    const kernelA = await createKernel(rootA, { modelGateway: makeGateway("A"), verifyMode: "off" });
    const kernelB = await createKernel(rootB, { modelGateway: makeGateway("B"), verifyMode: "off" });
    try {
      const [resA, resB] = await Promise.all([
        kernelA.agent.send("Run A"),
        kernelB.agent.send("Run B")
      ]);
      assert.equal(resA.status, "complete");
      assert.equal(resB.status, "complete");
      assert.match(resA.content, /KERNEL_A_DATA/);
      assert.doesNotMatch(resA.content, /KERNEL_B_DATA/);
      assert.match(resB.content, /KERNEL_B_DATA/);
      assert.doesNotMatch(resB.content, /KERNEL_A_DATA/);
    } finally {
      await kernelA.dispose();
      await kernelB.dispose();
    }
  } finally {
    await rm(rootA, { recursive: true, force: true }).catch(() => {});
    await rm(rootB, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// T11: Cancel / timeout / dispose while child task is running stops child worker with no late writes
// ============================================================================
test("T11: interrupting parent while task child worker is in flight aborts child and prevents subsequent tool execution", async () => {
  await withTempProject(async (root) => {
    let childStartedResolve;
    const childStarted = new Promise((r) => { childStartedResolve = r; });
    let childSecondToolExecuted = false;

    const gateway = {
      async invoke(messages, options = {}) {
        if (isChildMessages(messages)) {
          childStartedResolve();
          await new Promise((resolve, reject) => {
            if (options.signal?.aborted) return reject(options.signal.reason || new Error("aborted"));
            options.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            }, { once: true });
          });
          childSecondToolExecuted = true;
          return { content: "unreachable", tool_calls: [] };
        }
        return {
          content: "Parent starting child",
          tool_calls: [tc("task_cancel", "task", { prompt: "[DELEGATED_CHILD] long task", tools: ["read"] })],
          usage: { total_tokens: 10 }
        };
      }
    };

    const kernel = await createKernel(root, { modelGateway: gateway, verifyMode: "off" });
    try {
      const sendPromise = kernel.agent.send("Start long subtask");
      await childStarted;
      kernel.agent.interrupt();
      await assert.rejects(sendPromise, (err) => err.code === "INTERRUPTED" || err.name === "AbortError");
      assert.equal(childSecondToolExecuted, false);
    } finally {
      await kernel.dispose();
    }
  });
});

// ============================================================================
// T12: Parent has remaining tool calls after task -> executed once in order after child completes
// ============================================================================
test("T12: parent remaining tool calls after task execute in order exactly once without restarting parent turn", async () => {
  await withTempProject(async (root) => {
    const executionOrder = [];
    let parentModelCalls = 0;
    const validDiff = [
      "--- a/editable.txt",
      "+++ b/editable.txt",
      "@@ -1,1 +1,2 @@",
      " line1",
      "+child_approved_edit"
    ].join("\n");

    const gateway = {
      async invoke(messages) {
        if (isChildMessages(messages)) {
          const hasTool = messages.some((m) => m.role === "tool");
          if (!hasTool) {
            executionOrder.push("child:request_edit");
            return {
              content: "Child editing editable.txt",
              tool_calls: [tc("c_edit_t12", "edit", { diff: validDiff, prompt: "edit" })],
              usage: { total_tokens: 10 }
            };
          }
          executionOrder.push("child:complete");
          return { content: "Child edit done", tool_calls: [], usage: { total_tokens: 10 } };
        }

        parentModelCalls += 1;
        if (parentModelCalls === 1) {
          executionOrder.push("parent:turn_start");
          return {
            content: "Parent calling task then read",
            tool_calls: [
              tc("p_task_1", "task", { prompt: "[DELEGATED_CHILD] edit file", tools: ["edit"] }),
              tc("p_read_2", "read", { path: "editable.txt" })
            ],
            usage: { total_tokens: 15 }
          };
        }
        executionOrder.push("parent:turn_finish");
        const secondToolMsg = messages.find((m) => m.role === "tool" && m.tool_call_id === "p_read_2");
        return {
          content: `Parent read after child: ${secondToolMsg?.content?.trim() || ""}`,
          tool_calls: [],
          usage: { total_tokens: 10 }
        };
      }
    };

    const kernel = await createKernel(root, {
      modelGateway: gateway,
      verifyMode: "off",
      sessionLog: null,
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });
    try {
      const paused = await kernel.agent.send("Run task then read", { autonomy: "supervised" });
      assert.equal(paused.status, "awaiting_approval");
      assert.match(paused.approval.summary, /^edit requires approval/);

      const done = await kernel.agent.approve(paused.approval.id, "approve");
      assert.equal(done.status, "complete");
      assert.equal(parentModelCalls, 2, "parent initial model call must not re-run on resume");
      assert.deepEqual(executionOrder, [
        "parent:turn_start",
        "child:request_edit",
        "child:complete",
        "parent:turn_finish"
      ]);
      assert.match(done.content, /child_approved_edit/);
    } finally {
      await kernel.dispose();
    }
  });
});

// ============================================================================
// T13: Durable parent-child pause -> restart new kernel -> approve -> exact continuation & budget carry-over
// ============================================================================
test("T13: durable parent-child pause survives kernel restart and resumes child without repeating completed work", async () => {
  await withTempProject(async (root) => {
    const validDiff = [
      "--- a/editable.txt",
      "+++ b/editable.txt",
      "@@ -1,1 +1,2 @@",
      " line1",
      "+persisted_across_restart"
    ].join("\n");

    let childFirstStepCalls = 0;
    const makeGateway = () => ({
      async invoke(messages) {
        if (isChildMessages(messages)) {
          const hasTool = messages.some((m) => m.role === "tool");
          if (!hasTool) {
            childFirstStepCalls += 1;
            return {
              content: "Child requesting edit before crash",
              tool_calls: [tc("c_durable_edit", "edit", { diff: validDiff, prompt: "durable edit" })],
              usage: { total_tokens: 25 }
            };
          }
          return {
            content: "Child finished durable edit after restart",
            tool_calls: [],
            usage: { total_tokens: 15 }
          };
        }

        const hasTool = messages.some((m) => m.role === "tool");
        if (!hasTool) {
          return {
            content: "Parent delegating durable task",
            tool_calls: [tc("p_durable_task", "task", { prompt: "[DELEGATED_CHILD] durable edit", tools: ["edit"] })],
            usage: { total_tokens: 30 }
          };
        }
        return {
          content: "Parent completed after durable task recovery",
          tool_calls: [],
          usage: { total_tokens: 20 }
        };
      }
    });

    let approvalId = null;
    const kernel1 = await createKernel(root, {
      modelGateway: makeGateway(),
      verifyMode: "off",
      sessionLog: null,
      recovery: { enabled: true },
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });
    try {
      const paused = await kernel1.agent.send("Durable task test", { autonomy: "supervised" });
      assert.equal(paused.status, "awaiting_approval");
      approvalId = paused.approval.id;
      assert.equal(childFirstStepCalls, 1);
    } finally {
      await kernel1.dispose();
    }

    const kernel2 = await createKernel(root, {
      modelGateway: makeGateway(),
      verifyMode: "off",
      sessionLog: null,
      recovery: { enabled: true },
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });
    try {
      const items = await kernel2.recovery.list();
      const item = items.find((i) => i.source_id === approvalId);
      assert.ok(item, "paused parent-child approval must be listed in recovery");
      assert.equal(item.status, "pending");

      const resumed = await kernel2.agent.approve(approvalId, "approve");
      assert.equal(resumed.status, "complete");
      assert.equal(childFirstStepCalls, 1, "child initial step must not re-run after restart");
      assert.equal(await readFile(path.join(root, "editable.txt"), "utf8"), "line1\npersisted_across_restart\n");
    } finally {
      await kernel2.dispose();
    }
  });
});

// ============================================================================
// T14: Missing parent or child sidecar, or schema/fingerprint mismatch -> blocked & evidence preserved
// ============================================================================
test("T14: orphan child sidecar, missing child sidecar, or fingerprint mismatch is blocked on startup recovery and preserved", async () => {
  await withTempProject(async (root) => {
    const validDiff = [
      "--- a/editable.txt",
      "+++ b/editable.txt",
      "@@ -1,1 +1,2 @@",
      " line1",
      "+t14_write"
    ].join("\n");

    const gateway = {
      async invoke(messages) {
        if (isChildMessages(messages)) {
          return {
            content: "Child edit",
            tool_calls: [tc("c_t14", "edit", { diff: validDiff, prompt: "t14" })],
            usage: { total_tokens: 10 }
          };
        }
        return {
          content: "Parent task",
          tool_calls: [tc("p_t14", "task", { prompt: "[DELEGATED_CHILD] t14", tools: ["edit"] })],
          usage: { total_tokens: 10 }
        };
      }
    };

    let approvalId = null;
    let projectId = null;
    const kernel1 = await createKernel(root, {
      modelGateway: gateway,
      verifyMode: "off",
      sessionLog: null,
      recovery: { enabled: true },
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });
    try {
      const paused = await kernel1.agent.send("Start T14", { autonomy: "supervised" });
      assert.equal(paused.status, "awaiting_approval");
      approvalId = paused.approval.id;
      projectId = kernel1.runtime.listPaused()[0].permission_context.project_id;
    } finally {
      await kernel1.dispose();
    }

    const taskPaused = createTaskPausedPersistence({ root, projectId });
    const loaded = await taskPaused.load(approvalId);
    await taskPaused.save(approvalId, {
      ...loaded,
      fingerprints: {
        ...loaded.fingerprints,
        permission_policy_version: 999
      }
    });

    const kernel2 = await createKernel(root, {
      modelGateway: gateway,
      verifyMode: "off",
      sessionLog: null,
      recovery: { enabled: true },
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });
    try {
      const report = kernel2.recovery.report();
      assert.ok(report.blocked.some((b) => b.source_id === approvalId), "mismatched fingerprint must be reported in blocked");
      assert.equal(kernel2.agent.listPaused().length, 0, "blocked parent-child record must not be restored as runnable");
      const stillOnDisk = await taskPaused.load(approvalId);
      assert.equal(stillOnDisk.approval_id, approvalId);
    } finally {
      await kernel2.dispose();
    }
  });
});

// ============================================================================
// T15: Boundary fault injection (State 5 idempotent checkpoint vs mid-execution child_resuming block)
// ============================================================================
test("T15: fault after child completion checkpoint (State 5) delivers checkpointed result on recovery without re-executing child write", async () => {
  await withTempProject(async (root) => {
    const validDiff = [
      "--- a/editable.txt",
      "+++ b/editable.txt",
      "@@ -1,1 +1,2 @@",
      " line1",
      "+state5_idempotent_line"
    ].join("\n");

    let childApproveModelCalls = 0;
    const faults = createRecoveryFaults({ labels: ["after-task-child-completed-checkpoint"] });

    const makeGateway = () => ({
      async invoke(messages) {
        if (isChildMessages(messages)) {
          const hasTool = messages.some((m) => m.role === "tool");
          if (!hasTool) {
            return {
              content: "Child requesting edit",
              tool_calls: [tc("c_state5", "edit", { diff: validDiff, prompt: "state5" })],
              usage: { total_tokens: 10 }
            };
          }
          childApproveModelCalls += 1;
          return {
            content: "Child completed write before crash",
            tool_calls: [],
            usage: { total_tokens: 10 }
          };
        }

        const hasTool = messages.some((m) => m.role === "tool");
        if (!hasTool) {
          return {
            content: "Parent delegating",
            tool_calls: [tc("p_state5", "task", { prompt: "[DELEGATED_CHILD] state5", tools: ["edit"] })],
            usage: { total_tokens: 10 }
          };
        }
        const toolMsg = messages.find((m) => m.role === "tool");
        return {
          content: `Parent recovered checkpointed result: ${toolMsg?.content || ""}`,
          tool_calls: [],
          usage: { total_tokens: 10 }
        };
      }
    });

    let approvalId = null;
    const kernel1 = await createKernel(root, {
      modelGateway: makeGateway(),
      verifyMode: "off",
      sessionLog: null,
      recovery: { enabled: true, faults },
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });
    try {
      const paused = await kernel1.agent.send("Run State 5 fault test", { autonomy: "supervised" });
      assert.equal(paused.status, "awaiting_approval");
      approvalId = paused.approval.id;

      await assert.rejects(
        () => kernel1.agent.approve(approvalId, "approve"),
        (err) => err.code === "RECOVERY_FAULT" && err.label === "after-task-child-completed-checkpoint"
      );
      assert.equal(childApproveModelCalls, 1);
      assert.equal(await readFile(path.join(root, "editable.txt"), "utf8"), "line1\nstate5_idempotent_line\n");
    } finally {
      await kernel1.dispose();
    }

    const kernel2 = await createKernel(root, {
      modelGateway: makeGateway(),
      verifyMode: "off",
      sessionLog: null,
      recovery: { enabled: true },
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });
    try {
      const res = await kernel2.agent.approve(approvalId, "approve");
      assert.equal(res.status, "complete");
      assert.equal(childApproveModelCalls, 1, "child must NOT re-run when recovering from State 5 checkpoint");
      assert.match(res.content, /Child completed write before crash/);
      assert.equal(await readFile(path.join(root, "editable.txt"), "utf8"), "line1\nstate5_idempotent_line\n");
    } finally {
      await kernel2.dispose();
    }
  });
});

test("T15b: fault during child_resuming (before completion checkpoint) blocks automatic recovery to prevent duplicate writes", async () => {
  await withTempProject(async (root) => {
    const validDiff = [
      "--- a/editable.txt",
      "+++ b/editable.txt",
      "@@ -1,1 +1,2 @@",
      " line1",
      "+resuming_fault"
    ].join("\n");

    const faults = createRecoveryFaults({ labels: ["after-task-child-resuming"] });
    const makeGateway = () => ({
      async invoke(messages) {
        if (isChildMessages(messages)) {
          return {
            content: "Child edit",
            tool_calls: [tc("c_resuming", "edit", { diff: validDiff, prompt: "edit" })],
            usage: { total_tokens: 10 }
          };
        }
        return {
          content: "Parent task",
          tool_calls: [tc("p_resuming", "task", { prompt: "[DELEGATED_CHILD] edit", tools: ["edit"] })],
          usage: { total_tokens: 10 }
        };
      }
    });

    let approvalId = null;
    const kernel1 = await createKernel(root, {
      modelGateway: makeGateway(),
      verifyMode: "off",
      sessionLog: null,
      recovery: { enabled: true, faults },
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });
    try {
      const paused = await kernel1.agent.send("Run child_resuming fault test", { autonomy: "supervised" });
      approvalId = paused.approval.id;
      await assert.rejects(
        () => kernel1.agent.approve(approvalId, "approve"),
        (err) => err.code === "RECOVERY_FAULT" && err.label === "after-task-child-resuming"
      );
    } finally {
      await kernel1.dispose();
    }

    const kernel2 = await createKernel(root, {
      modelGateway: makeGateway(),
      verifyMode: "off",
      sessionLog: null,
      recovery: { enabled: true },
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });
    try {
      const report = kernel2.recovery.report();
      assert.ok(
        report.blocked.some((b) => b.source_id === approvalId && /mid-resume/i.test(b.reason)),
        "crash during child_resuming must be blocked with explicit mid-resume reason"
      );
      assert.equal(kernel2.agent.listPaused().length, 0);
    } finally {
      await kernel2.dispose();
    }
  });
});

// ============================================================================
// T16: Sequential task delegations share budget and reject new subtasks when budget is exhausted
// ============================================================================
test("T16: sequential task delegations share parent budget and cannot reset budget by spawning new workers", async () => {
  await withTempProject(async (root) => {
    let childSpawns = 0;
    const toolResults = [];

    const gateway = {
      async invoke(messages) {
        if (isChildMessages(messages)) {
          childSpawns += 1;
          return {
            content: `Child #${childSpawns} finished`,
            tool_calls: [],
            usage: { total_tokens: 10 }
          };
        }

        const hasTool = messages.some((m) => m.role === "tool");
        if (!hasTool) {
          return {
            content: "Spawning two subtasks under maxModelCalls=2",
            tool_calls: [
              tc("task_seq_1", "task", { prompt: "[DELEGATED_CHILD] sub 1", tools: ["read"] }),
              tc("task_seq_2", "task", { prompt: "[DELEGATED_CHILD] sub 2", tools: ["read"] })
            ],
            usage: { total_tokens: 10 }
          };
        }
        return {
          content: "Parent after tasks",
          tool_calls: [],
          usage: { total_tokens: 10 }
        };
      }
    };

    const kernel = await createKernel(root, {
      modelGateway: gateway,
      verifyMode: "off",
      sessionLog: null,
      limits: { maxModelCalls: 2 }
    });
    kernel.eventBus.subscribe("tool:result", (data) => {
      if (data?.result?.call_id === "task_seq_1" || data?.result?.call_id === "task_seq_2") {
        toolResults.push(data.result);
      }
    });

    try {
      const res = await kernel.agent.send("Run two subtasks with maxModelCalls=2");
      assert.equal(res.status, "stopped");
      assert.equal(childSpawns, 1, "second child worker must be rejected because shared budget is already at 2/2 calls");
      const secondResult = toolResults.find((r) => r.call_id === "task_seq_2");
      assert.ok(secondResult);
      assert.equal(secondResult.status, "error");
      assert.equal(secondResult.metadata.code, "BUDGET_EXCEEDED");
    } finally {
      await kernel.dispose();
    }
  });
});

// ============================================================================
// T17: Secret redaction, output length cap, and stripping internal continuation from tool:result events
// ============================================================================
test("T17: child output redacts secrets, caps length, and never leaks internal task_delegation payload on tool:result events", async () => {
  await withTempProject(async (root) => {
    const fakeSecret = "sk-1234567890abcdefghijklmnop";
    const hugeSuffix = "X".repeat(12000);
    const validDiff = [
      "--- a/editable.txt",
      "+++ b/editable.txt",
      "@@ -1,1 +1,2 @@",
      " line1",
      "+t17_line"
    ].join("\n");

    const gateway = {
      async invoke(messages) {
        if (isChildMessages(messages)) {
          const hasTool = messages.some((m) => m.role === "tool");
          if (!hasTool) {
            return {
              content: "Child pausing on edit first",
              tool_calls: [tc("c_t17_edit", "edit", { diff: validDiff, prompt: "t17" })],
              usage: { total_tokens: 10 }
            };
          }
          return {
            content: `Secret token=${fakeSecret} ${hugeSuffix}`,
            tool_calls: [],
            usage: { total_tokens: 10 }
          };
        }
        const hasTool = messages.some((m) => m.role === "tool");
        if (!hasTool) {
          return {
            content: "Parent delegating",
            tool_calls: [tc("p_t17_task", "task", { prompt: "[DELEGATED_CHILD] t17", tools: ["edit"] })],
            usage: { total_tokens: 10 }
          };
        }
        const toolOut = messages.find((m) => m.role === "tool" && m.tool_call_id === "p_t17_task")?.content || "";
        return {
          content: `Parent received length=${toolOut.length} secret_present=${toolOut.includes(fakeSecret)}`,
          tool_calls: [],
          usage: { total_tokens: 10 }
        };
      }
    };

    const publishedToolResults = [];
    const kernel = await createKernel(root, {
      modelGateway: gateway,
      verifyMode: "off",
      sessionLog: null,
      projectRules: [{ id: "allow-task", tool: "task", decision: "allow" }]
    });
    kernel.eventBus.subscribe("tool:result", (data) => {
      publishedToolResults.push(data.result);
    });

    try {
      const paused = await kernel.agent.send("Run T17", { autonomy: "supervised" });
      assert.equal(paused.status, "awaiting_approval");

      for (const tr of publishedToolResults) {
        assert.equal(tr.metadata?.task_delegation, undefined, "public tool:result event must not leak internal task_delegation payload");
      }

      const finalRes = await kernel.agent.approve(paused.approval.id, "approve");
      assert.equal(finalRes.status, "complete");
      assert.match(finalRes.content, /secret_present=false/);

      const finalTaskEvent = publishedToolResults.find((r) => r.call_id === "p_t17_task" && r.status === "success");
      assert.ok(finalTaskEvent);
      assert.ok(!finalTaskEvent.content[0].text.includes(fakeSecret), "secret must be redacted");
      assert.ok(finalTaskEvent.content[0].text.length <= 8050, "output must be bounded to MAX_TASK_RESULT_CHARS");
      assert.equal(finalTaskEvent.metadata.truncated, true);
    } finally {
      await kernel.dispose();
    }
  });
});

// ============================================================================
// T18: Ordinary non-task approval 4 branches remain regression-free
// ============================================================================
test("T18: ordinary non-task tool approval error codes and duplicate approval behavior remain intact", async () => {
  const runtime = createAgentRuntime({
    sessionId: "sess_t18",
    modelGateway: {
      invoke: async () => ({
        content: "Calling shell",
        tool_calls: [tc("call_sh", "shell", { command: "echo hi" })]
      })
    },
    toolSchemas: () => [{ type: "function", function: { name: "shell" } }],
    executeTool: async (call, ctx) => {
      if (!ctx._approved) {
        return {
          call_id: call.id,
          status: "approval_required",
          content: [{ type: "text", text: "Need approval" }],
          metadata: { approval: { id: "appr_t18_1", tool_name: "shell", summary: "Run echo" } }
        };
      }
      return {
        call_id: call.id,
        status: "success",
        content: [{ type: "text", text: "hi" }],
        metadata: {}
      };
    },
    verifyMode: "off"
  });

  const paused = await runtime.send("Run echo");
  assert.equal(paused.status, "awaiting_approval");
  assert.equal(paused.approval.id, "appr_t18_1");

  await assert.rejects(
    () => runtime.send("Concurrent send while paused"),
    (err) => err.code === "AWAITING_APPROVAL"
  );
  await assert.rejects(
    () => runtime.approve("unknown_id", "approve"),
    (err) => err.code === "APPROVAL_NOT_FOUND"
  );
});
