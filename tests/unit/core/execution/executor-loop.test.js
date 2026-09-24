import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "../../../../src/shared/event-bus.js";
import { runExecutorLoop, resumeExecutorLoop } from "../../../../src/core/execution/executor-loop.js";

test("executor loop executes tool calls and feeds results back to model", async () => {
  const calls = [];
  const executed = [];
  const modelGateway = {
    invoke: async (messages, options) => {
      calls.push({ messages, options });
      if (calls.length === 1) {
        return {
          content: "",
          tool_calls: [{ id: "call_read", name: "read", arguments: { path: "README.md" } }]
        };
      }
      return { content: "Read result handled", tool_calls: [] };
    }
  };

  const result = await runExecutorLoop({
    message: "read README",
    classification: { task_type: "diagnostic" },
    turnId: "turn_1",
    modelGateway,
    toolSchemas: [{ type: "function", function: { name: "read" } }],
    executeTool: async (toolCall) => {
      executed.push(toolCall);
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "README content" }], metadata: { path: "README.md" } };
    },
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  assert.equal(result.status, "complete");
  assert.equal(result.content, "Read result handled");
  assert.equal(executed[0].name, "read");
  assert.equal(calls.length, 2);
  assert.ok(calls[1].messages.some((entry) => entry.role === "tool"));
});

test("executor loop includes prior chat history in initial model messages", async () => {
  const calls = [];
  const result = await runExecutorLoop({
    message: "modify after context",
    classification: { task_type: "edit" },
    turnId: "turn_history",
    modelGateway: {
      invoke: async (messages) => {
        calls.push(messages);
        return { content: "done", tool_calls: [] };
      }
    },
    toolSchemas: [],
    executeTool: async () => { throw new Error("no tools expected"); },
    createPolicyContext: () => ({ autonomy: "gated" }),
    options: {
      history: [
        { role: "user", content: "first request" },
        { role: "assistant", content: "first answer" }
      ]
    }
  });

  assert.equal(result.status, "complete");
  assert.deepEqual(calls[0].map((entry) => entry.role), ["system", "user", "assistant", "user"]);
  assert.equal(calls[0][1].content, "first request");
  assert.equal(calls[0][3].content, "modify after context");
});

test("executor loop stops on approval_required", async () => {
  const result = await runExecutorLoop({
    message: "edit file",
    classification: { task_type: "edit" },
    turnId: "turn_1",
    modelGateway: {
      invoke: async () => ({
        content: "",
        tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "--- a/a.txt\n+++ b/a.txt" } }]
      })
    },
    toolSchemas: [],
    executeTool: async (toolCall) => ({
      call_id: toolCall.id,
      status: "approval_required",
      content: [{ type: "text", text: "edit requires approval" }],
      metadata: { approval: { id: "approval_1" } }
    }),
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.approval.id, "approval_1");
});

test("executor loop enforces max iterations", async () => {
  await assert.rejects(
    () => runExecutorLoop({
      message: "loop",
      classification: { task_type: "general" },
      turnId: "turn_1",
      maxIterations: 2,
      modelGateway: {
        invoke: async () => ({
          content: "",
          tool_calls: [{ id: `call_${Date.now()}`, name: "read", arguments: { path: "README.md" } }]
        })
      },
      toolSchemas: [],
      executeTool: async (toolCall) => ({ call_id: toolCall.id, status: "success", content: [{ type: "text", text: "ok" }] }),
      createPolicyContext: () => ({ autonomy: "gated" })
    }),
    /maximum tool iterations exceeded/
  );
});

test("executor loop reports malformed tool arguments", async () => {
  await assert.rejects(
    () => runExecutorLoop({
      message: "bad tool",
      classification: { task_type: "general" },
      turnId: "turn_1",
      modelGateway: {
        invoke: async () => ({
          content: "",
          tool_calls: [{ id: "bad", name: "read", arguments: null, arguments_parse_error: "Unexpected token" }]
        })
      },
      toolSchemas: [],
      executeTool: async () => { throw new Error("should not execute"); },
      createPolicyContext: () => ({ autonomy: "gated" })
    }),
    /invalid tool arguments/
  );
});

test("executor loop returns resume_state when approval is required", async () => {
  const result = await runExecutorLoop({
    message: "edit file",
    classification: { task_type: "edit" },
    turnId: "turn_approval",
    modelGateway: {
      invoke: async () => ({
        content: "",
        tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "--- a/a.txt\n+++ b/a.txt" } }]
      })
    },
    toolSchemas: [],
    executeTool: async (toolCall) => ({
      call_id: toolCall.id,
      status: "approval_required",
      content: [{ type: "text", text: "edit requires approval" }],
      metadata: { approval: { id: "approval_1", summary: "edit requires approval" } }
    }),
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.resume_state.pending_tool_call.name, "edit");
  assert.equal(result.resume_state.iteration, 0);
  assert.equal(result.resume_state.tool_results.length, 0);
});

test("resumeExecutorLoop executes pending and remaining tools then finishes", async () => {
  const modelCalls = [];
  const executed = [];
  const modelGateway = {
    invoke: async (messages) => {
      modelCalls.push(messages);
      return { content: "done after approval", tool_calls: [] };
    }
  };
  const resumeState = {
    turn_id: "turn_resume",
    message: "edit and read",
    classification: { task_type: "edit" },
    messages: [{ role: "user", content: "edit and read" }],
    model_result: { content: "", tool_calls: [
      { id: "call_edit", name: "edit", arguments: { diff: "d" } },
      { id: "call_read", name: "read", arguments: { path: "a.txt" } }
    ] },
    raw_tool_calls: [
      { id: "call_edit", name: "edit", arguments: { diff: "d" } },
      { id: "call_read", name: "read", arguments: { path: "a.txt" } }
    ],
    pending_tool_call: { id: "call_edit", name: "edit", params: { diff: "d" }, requested_by_step_id: "model:turn_resume:0" },
    remaining_tool_calls: [{ id: "call_read", name: "read", params: { path: "a.txt" }, requested_by_step_id: "model:turn_resume:0" }],
    iteration: 0,
    tool_results: [],
    tool_schemas: [],
    max_iterations: 5,
    options: {}
  };

  const result = await resumeExecutorLoop({
    resumeState,
    modelGateway,
    executeTool: async (toolCall) => {
      executed.push(toolCall.name);
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: `${toolCall.name} ok` }], metadata: {} };
    },
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(result.status, "complete");
  assert.equal(result.content, "done after approval");
  assert.deepEqual(executed, ["edit", "read"]);
  assert.equal(modelCalls.length, 1);
  assert.ok(modelCalls[0].some((message) => message.role === "tool"));
});

test("resumeExecutorLoop includes pre-approval tool results in model messages", async () => {
  // Scenario: model returns read + edit + grep. Read succeeds, edit pauses.
  // On resume, edit and grep succeed. Model must see ALL three results.
  const modelCalls = [];
  const resumeState = {
    turn_id: "turn_resume_pre",
    message: "read edit grep",
    classification: { task_type: "edit" },
    messages: [{ role: "user", content: "read edit grep" }],
    model_result: { content: "", tool_calls: [
      { id: "call_read", name: "read", arguments: { path: "a.txt" } },
      { id: "call_edit", name: "edit", arguments: { diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new" } },
      { id: "call_grep", name: "grep", arguments: { pattern: "TODO" } }
    ] },
    raw_tool_calls: [
      { id: "call_read", name: "read", arguments: { path: "a.txt" } },
      { id: "call_edit", name: "edit", arguments: { diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new" } },
      { id: "call_grep", name: "grep", arguments: { pattern: "TODO" } }
    ],
    pending_tool_call: { id: "call_edit", name: "edit", params: { diff: "d" }, requested_by_step_id: "model:turn_resume_pre:0" },
    remaining_tool_calls: [{ id: "call_grep", name: "grep", params: { pattern: "TODO" }, requested_by_step_id: "model:turn_resume_pre:0" }],
    iteration: 0,
    tool_results: [
      { call_id: "call_read", status: "success", content: [{ type: "text", text: "read ok" }], metadata: { path: "a.txt" } }
    ],
    tool_schemas: [],
    max_iterations: 5,
    options: {}
  };

  const result = await resumeExecutorLoop({
    resumeState,
    modelGateway: {
      invoke: async (messages) => {
        modelCalls.push(messages);
        return { content: "all done", tool_calls: [] };
      }
    },
    executeTool: async (toolCall) => ({
      call_id: toolCall.id, status: "success", content: [{ type: "text", text: `${toolCall.name} ok` }]
    }),
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(result.status, "complete");
  // Model should have received tool messages for all 3 tool calls
  const toolMessages = modelCalls[0].filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 3);
  assert.ok(toolMessages.some((m) => m.tool_call_id === "call_read"));
  assert.ok(toolMessages.some((m) => m.tool_call_id === "call_edit"));
  assert.ok(toolMessages.some((m) => m.tool_call_id === "call_grep"));
});

test("resume after cross-iteration pause does not duplicate prior-iteration results", async () => {
  // Iteration 0: model returns [read] → executes → messages get read tool result
  // Iteration 1: model returns [shell, edit] → shell succeeds, edit pauses
  // resume_state.tool_results MUST NOT include the iteration-0 read result
  // (it's already in messages). On resume model should see each result once.
  const modelCalls = [];
  let invokeCount = 0;
  const modelGateway = {
    invoke: async (messages) => {
      invokeCount += 1;
      modelCalls.push({ invokeCount, messages: [...messages] });
      if (invokeCount === 1) {
        return { content: "", tool_calls: [{ id: "call_read", name: "read", arguments: { path: "a.txt" } }] };
      }
      if (invokeCount === 2) {
        return { content: "", tool_calls: [
          { id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } },
          { id: "call_edit", name: "edit", arguments: { diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new" } }
        ] };
      }
      return { content: "all done", tool_calls: [] };
    }
  };

  const paused = await runExecutorLoop({
    message: "read then shell edit",
    classification: { task_type: "edit" },
    turnId: "turn_cross_iter",
    modelGateway,
    toolSchemas: [],
    executeTool: async (toolCall) => {
      if (toolCall.name === "edit") {
        return {
          call_id: toolCall.id, status: "approval_required",
          content: [{ type: "text", text: "edit needs approval" }],
          metadata: { approval: { id: "approval_edit" } }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: `${toolCall.name} ok` }] };
    },
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(paused.status, "awaiting_approval");
  // resume_state.tool_results should only contain iteration-1 pre-approval results (shell)
  // NOT the iteration-0 read result (that's already baked into messages)
  assert.equal(paused.resume_state.iteration, 1);

  const modelCallsAfterResume = [];
  const resumed = await resumeExecutorLoop({
    resumeState: paused.resume_state,
    modelGateway: {
      invoke: async (messages) => {
        modelCallsAfterResume.push([...messages]);
        return { content: "done after resume", tool_calls: [] };
      }
    },
    executeTool: async (toolCall) => ({
      call_id: toolCall.id, status: "success", content: [{ type: "text", text: `${toolCall.name} ok` }]
    }),
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(resumed.status, "complete");
  // Verify no duplicate tool call_ids in the messages sent to model after resume
  const toolMessages = modelCallsAfterResume[0].filter((m) => m.role === "tool");
  const ids = toolMessages.map((m) => m.tool_call_id);
  const uniqueIds = new Set(ids);
  assert.equal(ids.length, uniqueIds.size, `duplicate tool ids found: ${JSON.stringify(ids)}`);
  // All 3 results should be present: read (iter0), shell (iter1 pre), edit (resume)
  assert.ok(uniqueIds.has("call_read"), "missing read");
  assert.ok(uniqueIds.has("call_shell"), "missing shell");
  assert.ok(uniqueIds.has("call_edit"), "missing edit");
});

test("executor loop stores context in approval resume state", async () => {
  const result = await runExecutorLoop({
    message: "modify a.txt",
    classification: { task_type: "edit" },
    turnId: "turn_context_resume",
    context: { snapshot_id: "ctxsnap_1", summary: "Project files:\n- a.txt" },
    modelGateway: {
      invoke: async () => ({
        content: "",
        tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }]
      })
    },
    toolSchemas: [],
    executeTool: async (toolCall) => ({
      call_id: toolCall.id,
      status: "approval_required",
      content: [{ type: "text", text: "approval" }],
      metadata: { approval: { id: "approval_ctx" } }
    }),
    createPolicyContext: () => ({})
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.resume_state.context.snapshot_id, "ctxsnap_1");
});

test("resumeExecutorLoop preserves context through model-iteration re-pause", async () => {
  // After pending+remaining tools succeed, model returns more tool calls,
  // and one of them requires approval. Context must survive this re-pause too.
  const resumeState = {
    turn_id: "turn_resume_ctx_iter",
    message: "edit then check",
    classification: { task_type: "edit" },
    messages: [{ role: "user", content: "edit then check" }],
    model_result: { content: "", tool_calls: [
      { id: "call_edit", name: "edit", arguments: { diff: "d" } }
    ] },
    raw_tool_calls: [
      { id: "call_edit", name: "edit", arguments: { diff: "d" } }
    ],
    pending_tool_call: { id: "call_edit", name: "edit", params: { diff: "d" }, requested_by_step_id: "model:turn_resume_ctx_iter:0" },
    remaining_tool_calls: [],
    iteration: 0,
    tool_results: [],
    tool_schemas: [],
    max_iterations: 5,
    options: {},
    context: { snapshot_id: "ctxsnap_iter_pause", summary: "Project files:\n- a.txt" }
  };

  const result = await resumeExecutorLoop({
    resumeState,
    modelGateway: {
      invoke: async () => ({
        content: "",
        tool_calls: [
          { id: "call_shell_new", name: "shell", arguments: { argv: ["npm", "test"] } },
          { id: "call_grep", name: "grep", arguments: { pattern: "TODO" } }
        ]
      })
    },
    executeTool: async (toolCall) => {
      if (toolCall.name === "shell") {
        return {
          call_id: toolCall.id,
          status: "approval_required",
          content: [{ type: "text", text: "shell requires approval" }],
          metadata: { approval: { id: "approval_iter_ctx" } }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: `${toolCall.name} ok` }] };
    },
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.approval.id, "approval_iter_ctx");
  assert.equal(result.resume_state.pending_tool_call.name, "shell");
  // Context must survive model-iteration re-pause
  assert.equal(result.resume_state.context.snapshot_id, "ctxsnap_iter_pause");
});

test("resumeExecutorLoop can pause again on a remaining tool approval", async () => {
  const resumeState = {
    turn_id: "turn_resume_again",
    message: "edit then shell",
    classification: { task_type: "edit" },
    messages: [{ role: "user", content: "edit then shell" }],
    model_result: { content: "", tool_calls: [
      { id: "call_edit", name: "edit", arguments: { diff: "d" } },
      { id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } }
    ] },
    raw_tool_calls: [
      { id: "call_edit", name: "edit", arguments: { diff: "d" } },
      { id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } }
    ],
    pending_tool_call: { id: "call_edit", name: "edit", params: { diff: "d" }, requested_by_step_id: "model:turn_resume_again:0" },
    remaining_tool_calls: [{ id: "call_shell", name: "shell", params: { argv: ["npm", "test"] }, requested_by_step_id: "model:turn_resume_again:0" }],
    iteration: 0,
    tool_results: [],
    tool_schemas: [],
    max_iterations: 5,
    options: {}
  };

  const result = await resumeExecutorLoop({
    resumeState,
    modelGateway: { invoke: async () => ({ content: "should not call model", tool_calls: [] }) },
    executeTool: async (toolCall) => {
      if (toolCall.name === "shell") {
        return {
          call_id: toolCall.id,
          status: "approval_required",
          content: [{ type: "text", text: "shell requires approval" }],
          metadata: { approval: { id: "approval_shell" } }
        };
      }
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "edit ok" }] };
    },
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.approval.id, "approval_shell");
  assert.equal(result.resume_state.pending_tool_call.name, "shell");
  assert.equal(result.resume_state.tool_results.length, 1);
});

test("executor loop replays model reasoning_content in second-round assistant message", async () => {
  // DeepSeek 协议:请求带 tools 时,历史每轮 assistant 消息必须完整回传
  // reasoning_content,否则第二轮请求 HTTP 400。这里捕捉第二轮请求体,
  // 断言首条 assistant 消息携带该字段且值与上游返回一致。
  const calls = [];
  const modelGateway = {
    invoke: async (messages) => {
      calls.push(messages);
      if (calls.length === 1) {
        return {
          content: "",
          reasoning_content: "I should read the README first.",
          tool_calls: [{ id: "call_read", name: "read", arguments: { path: "README.md" } }]
        };
      }
      return { content: "Read result handled", tool_calls: [] };
    }
  };

  const result = await runExecutorLoop({
    message: "read README",
    classification: { task_type: "diagnostic" },
    turnId: "turn_reasoning",
    modelGateway,
    toolSchemas: [{ type: "function", function: { name: "read" } }],
    executeTool: async (toolCall) => ({
      call_id: toolCall.id, status: "success", content: [{ type: "text", text: "README content" }]
    }),
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  assert.equal(result.status, "complete");
  assert.equal(calls.length, 2);
  const assistantMessages = calls[1].filter((entry) => entry.role === "assistant");
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].reasoning_content, "I should read the README first.");
  assert.equal(assistantMessages[0].tool_calls[0].id, "call_read");
});

test("executor loop omits reasoning_content key when model returns none", async () => {
  // 反向用例:上游模型结果无 reasoning_content 时,第二轮请求体的 assistant
  // 消息不得包含该键(不能用 undefined 占位),保持旧 mock 行为逐字节不变。
  const calls = [];
  const modelGateway = {
    invoke: async (messages) => {
      calls.push(messages);
      if (calls.length === 1) {
        return {
          content: "",
          tool_calls: [{ id: "call_read", name: "read", arguments: { path: "README.md" } }]
        };
      }
      return { content: "Read result handled", tool_calls: [] };
    }
  };

  const result = await runExecutorLoop({
    message: "read README",
    classification: { task_type: "diagnostic" },
    turnId: "turn_no_reasoning",
    modelGateway,
    toolSchemas: [{ type: "function", function: { name: "read" } }],
    executeTool: async (toolCall) => ({
      call_id: toolCall.id, status: "success", content: [{ type: "text", text: "README content" }]
    }),
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  assert.equal(result.status, "complete");
  assert.equal(calls.length, 2);
  const assistantMessages = calls[1].filter((entry) => entry.role === "assistant");
  assert.equal(assistantMessages.length, 1);
  assert.ok(!("reasoning_content" in assistantMessages[0]));
  assert.deepEqual(Object.keys(assistantMessages[0]), ["role", "content", "tool_calls"]);
});

test("resumeExecutorLoop replays reasoning_content in assistant message appended on resume", async () => {
  // resume 路径(executor-loop.js 中审批恢复后追加 assistant 工具消息处)同样
  // 回传 reasoning_content:审批恢复后的第一次模型请求,首条 assistant 消息
  // 由 resume_state.model_result 构造,缺失该字段同样会触发 400。
  const modelCalls = [];
  const resumeState = {
    turn_id: "turn_resume_reasoning",
    message: "edit and read",
    classification: { task_type: "edit" },
    messages: [{ role: "user", content: "edit and read" }],
    model_result: {
      content: "",
      reasoning_content: "apply the edit, then verify the result.",
      tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }]
    },
    raw_tool_calls: [
      { id: "call_edit", name: "edit", arguments: { diff: "d" } }
    ],
    pending_tool_call: { id: "call_edit", name: "edit", params: { diff: "d" }, requested_by_step_id: "model:turn_resume_reasoning:0" },
    remaining_tool_calls: [],
    iteration: 0,
    tool_results: [],
    tool_schemas: [],
    max_iterations: 5,
    options: {}
  };

  const result = await resumeExecutorLoop({
    resumeState,
    modelGateway: {
      invoke: async (messages) => {
        modelCalls.push(messages);
        return { content: "done after resume", tool_calls: [] };
      }
    },
    executeTool: async (toolCall) => ({
      call_id: toolCall.id, status: "success", content: [{ type: "text", text: "edit ok" }]
    }),
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(result.status, "complete");
  assert.equal(result.content, "done after resume");
  const assistantMessages = modelCalls[0].filter((message) => message.role === "assistant");
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].reasoning_content, "apply the edit, then verify the result.");
});

function captureModelResponses() {
  const responses = [];
  return { responses, eventBus: { publish: (type, data) => { if (type === "model:response") responses.push(data); } } };
}

test("v1.9.0 M1: model:response carries the four new top-level keys when the model result has them", async () => {
  // mock 带 reasoning_content/latency_ms/usage:事件附 reasoning/tps/session_id/latency_ms 四键。
  // tps = completion_tokens / (latency_ms/1000) = 300 / (4000/1000) = 75(保留 1 位小数)。
  const { responses, eventBus } = captureModelResponses();
  const result = await runExecutorLoop({
    message: "read README",
    classification: { task_type: "diagnostic" },
    turnId: "turn_extras",
    sessionId: "sess_extras",
    modelGateway: {
      invoke: async () => ({
        content: "done",
        reasoning_content: "think first",
        latency_ms: 4000,
        usage: { completion_tokens: 300 },
        tool_calls: []
      })
    },
    toolSchemas: [],
    executeTool: async () => { throw new Error("no tools expected"); },
    createPolicyContext: () => ({ autonomy: "gated" }),
    eventBus
  });

  assert.equal(result.status, "complete");
  assert.equal(responses.length, 1);
  const evt = responses[0];
  assert.equal(evt.reasoning, "think first");
  assert.equal(evt.tps, 75);
  assert.equal(evt.session_id, "sess_extras");
  assert.equal(evt.latency_ms, 4000);
  // 既有七键逐字节不动
  assert.equal(evt.turn_id, "turn_extras");
  assert.equal(evt.purpose, "plan");
  assert.equal(evt.iteration, 0);
  assert.equal(evt.content, "done");
  assert.equal(evt.tool_call_count, 0);
  assert.deepEqual(evt.usage, { completion_tokens: 300 });
  assert.equal(evt.model, undefined);
  assert.equal(evt.channel, undefined);
});

test("v1.9.0 M1: model:response omits the four new keys when the model result lacks them", async () => {
  // 反向:mock 不带 reasoning_content/latency_ms/usage 且无 sessionId 时,
  // 事件不得包含四新键(不能用 undefined 占位),旧 mock 行为逐字节不变。
  const { responses, eventBus } = captureModelResponses();
  const result = await runExecutorLoop({
    message: "read README",
    classification: { task_type: "diagnostic" },
    turnId: "turn_no_extras",
    modelGateway: {
      invoke: async () => ({ content: "done", tool_calls: [] })
    },
    toolSchemas: [],
    executeTool: async () => { throw new Error("no tools expected"); },
    createPolicyContext: () => ({ autonomy: "gated" }),
    eventBus
  });

  assert.equal(result.status, "complete");
  assert.equal(responses.length, 1);
  const evt = responses[0];
  assert.ok(!("reasoning" in evt));
  assert.ok(!("tps" in evt));
  assert.ok(!("session_id" in evt));
  assert.ok(!("latency_ms" in evt));
  // 旧形态:既有八键(turn_id/purpose/iteration/content/tool_call_count/usage/model/channel)齐全,
  // usage 仍为 null,无任何 undefined 占位的新键漏进事件。
  assert.deepEqual(Object.keys(evt).sort(),
    ["channel", "content", "iteration", "model", "purpose", "tool_call_count", "turn_id", "usage"]);
  assert.equal(evt.usage, null);
});

test("v1.9.0 M1: model:response truncates reasoning at 500 chars and rounds tps to one decimal", async () => {
  // reasoning_content 600 字 → 500 字 + 「…」(共 501 字符);
  // tps = 100 / (300/1000) = 333.333… → 333.3(1 位小数)。
  const { responses, eventBus } = captureModelResponses();
  await runExecutorLoop({
    message: "read README",
    classification: { task_type: "diagnostic" },
    turnId: "turn_truncate",
    sessionId: "sess_truncate",
    modelGateway: {
      invoke: async () => ({
        content: "done",
        reasoning_content: "x".repeat(600),
        latency_ms: 300,
        usage: { completion_tokens: 100 },
        tool_calls: []
      })
    },
    toolSchemas: [],
    executeTool: async () => { throw new Error("no tools expected"); },
    createPolicyContext: () => ({ autonomy: "gated" }),
    eventBus
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].reasoning, `${"x".repeat(500)}…`);
  assert.equal(responses[0].reasoning.length, 501);
  assert.equal(responses[0].tps, 333.3);
});

test("v1.9.0 M1: model:response skips tps when latency is missing or non-positive but keeps latency_ms=0", async () => {
  // 缺 usage → 无 tps;latency_ms=0 → 无 tps 但 latency_ms 键照附(有限数);
  // latency_ms 缺省 → 两个键都不附。
  const { responses, eventBus } = captureModelResponses();
  await runExecutorLoop({
    message: "a",
    classification: { task_type: "general" },
    turnId: "turn_zero_latency",
    modelGateway: { invoke: async () => ({ content: "done", latency_ms: 0, tool_calls: [] }) },
    toolSchemas: [],
    executeTool: async () => { throw new Error("no tools expected"); },
    createPolicyContext: () => ({ autonomy: "gated" }),
    eventBus
  });
  assert.equal(responses.length, 1);
  assert.ok(!("tps" in responses[0]));
  assert.equal(responses[0].latency_ms, 0);

  const noLatency = captureModelResponses();
  await runExecutorLoop({
    message: "b",
    classification: { task_type: "general" },
    turnId: "turn_no_latency",
    modelGateway: { invoke: async () => ({ content: "done", usage: { completion_tokens: 10 }, tool_calls: [] }) },
    toolSchemas: [],
    executeTool: async () => { throw new Error("no tools expected"); },
    createPolicyContext: () => ({ autonomy: "gated" }),
    eventBus: noLatency.eventBus
  });
  assert.equal(noLatency.responses.length, 1);
  assert.ok(!("tps" in noLatency.responses[0]));
  assert.ok(!("latency_ms" in noLatency.responses[0]));
});

test("v1.9.0 M1: resumeExecutorLoop model:response carries the four new keys with sessionId", async () => {
  const { responses, eventBus } = captureModelResponses();
  const resumeState = {
    turn_id: "turn_resume_extras",
    message: "edit and read",
    classification: { task_type: "edit" },
    messages: [{ role: "user", content: "edit and read" }],
    model_result: { content: "", tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }] },
    raw_tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }],
    pending_tool_call: { id: "call_edit", name: "edit", params: { diff: "d" }, requested_by_step_id: "model:turn_resume_extras:0" },
    remaining_tool_calls: [],
    iteration: 0,
    tool_results: [],
    tool_schemas: [],
    max_iterations: 5,
    options: {}
  };

  const result = await resumeExecutorLoop({
    resumeState,
    sessionId: "sess_resume_extras",
    modelGateway: {
      invoke: async () => ({
        content: "done after resume",
        reasoning_content: "resume reasoning",
        latency_ms: 2000,
        usage: { completion_tokens: 100 },
        tool_calls: []
      })
    },
    executeTool: async (toolCall) => ({
      call_id: toolCall.id, status: "success", content: [{ type: "text", text: "edit ok" }]
    }),
    createPolicyContext: () => ({ autonomy: "supervised" }),
    eventBus
  });

  assert.equal(result.status, "complete");
  assert.equal(responses.length, 1);
  const evt = responses[0];
  assert.equal(evt.turn_id, "turn_resume_extras");
  assert.equal(evt.purpose, "act");
  assert.equal(evt.reasoning, "resume reasoning");
  assert.equal(evt.tps, 50); // 100 / (2000/1000)
  assert.equal(evt.session_id, "sess_resume_extras");
  assert.equal(evt.latency_ms, 2000);
});
