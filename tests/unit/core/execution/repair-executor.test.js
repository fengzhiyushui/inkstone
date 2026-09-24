import test from "node:test";
import assert from "node:assert/strict";
import { runRepairExecutor } from "../../../../src/core/execution/repair-executor.js";

test("repair executor invokes repair model and executes tool calls through executeTool", async () => {
  const executed = [];
  const modelCalls = [];
  const result = await runRepairExecutor({
    turnId: "turn_repair",
    messages: [{ role: "user", content: "repair" }],
    modelGateway: {
      invoke: async (messages, options) => {
        modelCalls.push({ messages, options });
        return {
          content: "",
          tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }]
        };
      }
    },
    toolSchemas: [{ type: "function", function: { name: "edit" } }],
    executeTool: async (toolCall) => {
      executed.push(toolCall);
      return { call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }], metadata: { change_id: "chg_1" } };
    },
    createPolicyContext: ({ phase }) => ({ autonomy: "gated", phase })
  });

  assert.equal(result.status, "complete");
  assert.equal(modelCalls[0].options.purpose, "repair");
  assert.equal(executed[0].name, "edit");
  assert.equal(result.toolResults.length, 1);
});

test("repair executor returns awaiting_approval with V2-7 resume_state", async () => {
  const result = await runRepairExecutor({
    turnId: "turn_repair_approval",
    messages: [{ role: "user", content: "repair" }],
    modelGateway: {
      invoke: async () => ({
        content: "",
        tool_calls: [
          { id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } },
          { id: "call_edit", name: "edit", arguments: { diff: "d" } }
        ]
      })
    },
    toolSchemas: [],
    executeTool: async (toolCall) => ({
      call_id: toolCall.id,
      status: "approval_required",
      content: [{ type: "text", text: "needs approval" }],
      metadata: { approval: { id: "approval_repair" } }
    }),
    createPolicyContext: () => ({ autonomy: "supervised" })
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.approval.id, "approval_repair");
  assert.equal(result.resume_state.pending_tool_call.name, "shell");
  assert.equal(result.resume_state.turn_id, "turn_repair_approval");
  assert.equal(result.resume_state.options.purpose, "repair");
});

test("repair executor stores context in approval resume state", async () => {
  const result = await runRepairExecutor({
    turnId: "turn_repair_context",
    messages: [{ role: "user", content: "{}" }],
    modelGateway: {
      invoke: async () => ({
        content: "",
        tool_calls: [{ id: "call_shell", name: "shell", arguments: { argv: ["npm", "test"] } }]
      })
    },
    toolSchemas: [],
    executeTool: async (toolCall) => ({
      call_id: toolCall.id,
      status: "approval_required",
      content: [{ type: "text", text: "approval" }],
      metadata: { approval: { id: "approval_repair_ctx" } }
    }),
    createPolicyContext: () => ({}),
    options: { context: { snapshot_id: "ctxsnap_repair", summary: "Project files:\n- a.txt" } }
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.resume_state.context.snapshot_id, "ctxsnap_repair");
});

test("repair executor returns final content when model has no tool calls", async () => {
  const result = await runRepairExecutor({
    turnId: "turn_repair_final",
    messages: [{ role: "user", content: "repair" }],
    modelGateway: {
      invoke: async () => ({ content: "cannot repair", tool_calls: [] })
    },
    executeTool: async () => { throw new Error("should not execute tools"); },
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  assert.equal(result.status, "complete");
  assert.equal(result.content, "cannot repair");
  assert.deepEqual(result.toolResults, []);
});

test("repair executor replays model reasoning_content in assistant message", async () => {
  // DeepSeek 协议:请求带 tools 时,历史 assistant 消息必须完整回传
  // reasoning_content,否则后续请求 HTTP 400。repair 完成后返回的 messages
  // 会被拼回后续请求,其中的 assistant 工具消息必须携带该字段且值与上游一致。
  const result = await runRepairExecutor({
    turnId: "turn_repair_reasoning",
    messages: [{ role: "user", content: "repair" }],
    modelGateway: {
      invoke: async () => ({
        content: "",
        reasoning_content: "fix the diff first, then re-run tests.",
        tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }]
      })
    },
    toolSchemas: [{ type: "function", function: { name: "edit" } }],
    executeTool: async (toolCall) => ({
      call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }]
    }),
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  assert.equal(result.status, "complete");
  const assistantMessages = result.messages.filter((message) => message.role === "assistant");
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].reasoning_content, "fix the diff first, then re-run tests.");
  assert.equal(assistantMessages[0].tool_calls[0].id, "call_edit");
});

test("repair executor omits reasoning_content key when model returns none", async () => {
  // 反向用例:上游模型结果无 reasoning_content 时,回传的 assistant 消息
  // 不得包含该键(不能用 undefined 占位),保持旧 mock 行为逐字节不变。
  const result = await runRepairExecutor({
    turnId: "turn_repair_no_reasoning",
    messages: [{ role: "user", content: "repair" }],
    modelGateway: {
      invoke: async () => ({
        content: "",
        tool_calls: [{ id: "call_edit", name: "edit", arguments: { diff: "d" } }]
      })
    },
    toolSchemas: [{ type: "function", function: { name: "edit" } }],
    executeTool: async (toolCall) => ({
      call_id: toolCall.id, status: "success", content: [{ type: "text", text: "applied" }]
    }),
    createPolicyContext: () => ({ autonomy: "gated" })
  });

  assert.equal(result.status, "complete");
  const assistantMessages = result.messages.filter((message) => message.role === "assistant");
  assert.equal(assistantMessages.length, 1);
  assert.ok(!("reasoning_content" in assistantMessages[0]));
  assert.deepEqual(Object.keys(assistantMessages[0]), ["role", "content", "tool_calls"]);
});
