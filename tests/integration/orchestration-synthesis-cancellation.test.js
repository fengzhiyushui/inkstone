import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createKernel } from "../../src/index.js";
import { mkdtemp } from "../helpers/tmp.js";

const request = "逐一处理 a.js 的输入校验";
const originalFile = "export const value = 0;\n";
const editedFile = "export const value = 1;\n";

function response(content, toolCalls = []) {
  return {
    ok: true, status: 200, headers: new Map(),
    json: async () => ({
      choices: [{ finish_reason: toolCalls.length ? "tool_calls" : "stop", message: {
        role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content), tool_calls: toolCalls
      } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })
  };
}

async function fixture(t, { cancelAt = 1, durable = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-synthesis-cancel-"));
  await fs.writeFile(path.join(root, "a.js"), originalFile);
  const kernels = [];
  t.after(async () => {
    for (const kernel of [...kernels].reverse()) {
      kernel.agent.interrupt();
      await kernel.dispose();
    }
  });
  const state = { synthesisCalls: 0, planCalls: 0, fetchAborted: false, editRequested: false };
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const events = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const text = body.messages.map((message) => message.content).join("\n");
    if (text.includes("Classify this coding request")) return response({ lane: "orchestrate", reason: "multiple tasks" });
    if (text.includes("Break the user's request")) {
      state.planCalls += 1;
      return response({ task_summary: "cancellation fixture", done_when: "done", subtasks: [{
        id: "st_1", goal: "edit a.js", acceptance: ["done"], context_scope: { files: ["a.js"] },
        tool_profile: durable ? "edit" : "readonly", depends_on: []
      }] });
    }
    if (text.includes("INDEPENDENT reviewer")) return response({ pass: true, severity: "warn", reasons: [], checked: ["read"] });
    if (text.includes("Synthesize a final answer")) {
      state.synthesisCalls += 1;
      if (state.synthesisCalls !== cancelAt) return response("round summary");
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          state.fetchAborted = true;
          reject(Object.assign(new Error("synthesis interrupted"), { name: "AbortError" }));
        };
        if (init.signal.aborted) onAbort();
        else init.signal.addEventListener("abort", onAbort, { once: true });
        notifyStarted();
      });
    }
    if (durable && !state.editRequested) {
      state.editRequested = true;
      return response("", [{ id: "edit_1", type: "function", function: {
        name: "diff_apply",
        arguments: JSON.stringify({ diff: "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-export const value = 0;\n+export const value = 1;\n" })
      } }]);
    }
    return response("worker complete");
  };
  async function makeKernel(sessionId) {
    const kernel = await createKernel(root, {
      sessionLog: null, branchStore: null, verifyMode: "off", projectId: "synthesis-cancel", sessionId,
      recovery: { enabled: durable, lock: false, surface: "cli" },
      orchestration: { maxRounds: 1, budget: { maxModelCalls: 30 } },
      deepseek: { apiKey: "mock-key-no-network", fetchImpl }
    });
    kernels.push(kernel);
    for (const name of ["orchestration:completed", "orchestration:cancelled"]) {
      kernel.eventBus.subscribe(name, (data) => events.push({ name, data }));
    }
    return kernel;
  }
  let kernel = await makeKernel("before-restart");
  let approvalId;
  if (durable) {
    const paused = await kernel.agent.send(request, { autonomy: "supervised" });
    assert.equal(paused.status, "awaiting_approval");
    approvalId = paused.approval.id;
    assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), originalFile);
    await kernel.dispose();
    kernel = await makeKernel("after-restart");
  }
  return {
    root, kernel, started, state, events, cancelAt,
    run: () => durable ? kernel.agent.approve(approvalId, "approve") : kernel.agent.send(request, { autonomy: "auto" })
  };
}

async function cancelSynthesis(f, action) {
  // Attach the rejection handler before cancellation, including when dispose awaits cleanup.
  const pending = f.run().then((result) => ({ result }), (error) => ({ error }));
  let timer;
  try {
    await Promise.race([
      f.started,
      pending.then(({ error }) => { throw error || new Error("request ended before synthesis barrier"); }),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("synthesis barrier not reached")), 5000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (action === "dispose") await f.kernel.dispose();
  else f.kernel.agent.interrupt();
  const { result, error } = await pending;
  assert.ifError(error);
  assert.equal(f.state.fetchAborted, true, "in-flight HTTP receives cancellation");
  assert.equal(f.state.synthesisCalls, f.cancelAt, "cancellation prevents further synthesis");
  assert.equal(f.state.planCalls, 1, "resume does not replan the paused task");
  assert.equal(result.status, "cancelled");
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(result.collected.map((c) => [c.st.id, c.status]), [["st_1", "complete"]]);
  assert.deepEqual(f.events.map((event) => event.name), ["orchestration:cancelled"]);
}

for (const [phase, cancelAt] of [["round", 1], ["final", 2]]) {
  for (const action of ["interrupt", "dispose"]) {
    test(`${action} during ${phase} synthesis returns one cancelled terminal event`, { timeout: 10000 }, async (t) => {
      await cancelSynthesis(await fixture(t, { cancelAt }), action);
    });
  }
}

for (const action of ["interrupt", "dispose"]) {
  test(`${action} during round synthesis after durable approval preserves collected work`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t, { durable: true });
    await cancelSynthesis(f, action);
    assert.equal(await fs.readFile(path.join(f.root, "a.js"), "utf8"), editedFile);
  });
}
