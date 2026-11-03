// tests/unit/apps/cli-runner.test.js — CLI 运行器(内核命令/渲染事件/敏感通知/模型目录/语义开关/FIM)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/apps/cli/kernel-runner.test.js
// ---------------------------------------------------------------------------
describe("unit/apps/cli/kernel-runner", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { runKernelAgentCommand, runKernelChatCommand, runKernelTestCommand, buildEditPrompt } = await import("../../../src/apps/cli/kernel-runner.js");

  function createMockKernel(result, events = []) {
    return {
      session: {
        subscribe(handler) {
          for (const event of events) handler(event);
          return { unsubscribe() { events.push({ unsubscribed: true }); } };
        }
      },
      agent: {
        send: async (message, options) => ({ ...result, seen: { message, options } })
      },
      tools: {
        execute: async (toolCall, options) => ({
          call: toolCall,
          options,
          status: "success",
          content: [{ type: "text", text: "test output" }],
          metadata: { argv: toolCall.params.argv || ["node", "--test"] }
        })
      }
    };
  }

  test("runKernelAgentCommand sends prompt through V2 kernel and renders result", async () => {
    const lines = [];
    const result = await runKernelAgentCommand({
      root: "/repo",
      prompt: "what is this?",
      autonomy: "gated",
      write: (line) => lines.push(line),
      createKernelImpl: async () => createMockKernel({ status: "complete", content: "answer" }, [
        { type: "tool:call", call: { name: "read" } }
      ])
    });

    assert.equal(result.status, "complete");
    assert.equal(result.seen.options.autonomy, "gated");
    assert.ok(lines.includes("- tool read"));
    assert.ok(lines.includes("answer"));
  });

  test("runKernelAgentCommand SIGINT interrupts current turn and removes handler", async () => {
    const lines = [];
    let rejectSend;
    let interrupted = 0;
    let unsubscribed = false;
    const kernel = {
      session: { subscribe: () => ({ unsubscribe() {} }) },
      agent: {
        send: () => new Promise((resolve, reject) => { rejectSend = reject; }),
        interrupt: () => {
          interrupted += 1;
          const error = new Error("turn was interrupted");
          error.code = "INTERRUPTED";
          rejectSend(error);
        }
      }
    };

    const result = await runKernelAgentCommand({
      root: "/repo",
      prompt: "long task",
      write: (line) => lines.push(line),
      createKernelImpl: async () => kernel,
      onSigint(handler) {
        queueMicrotask(handler);
        return () => { unsubscribed = true; };
      }
    });

    assert.equal(interrupted, 1);
    assert.equal(result.status, "interrupted");
    assert.equal(unsubscribed, true);
    assert.ok(lines.some((line) => line.includes("Interrupt requested")));
    assert.ok(lines.some((line) => line.includes("Turn interrupted")));
  });

  test("runKernelAgentCommand unsubscribes after send", async () => {
    const events = [];
    await runKernelAgentCommand({
      root: "/repo",
      prompt: "hello",
      write: () => {},
      createKernelImpl: async () => createMockKernel({ status: "complete", content: "ok" }, events)
    });

    assert.equal(events.at(-1).unsubscribed, true);
  });

  test("runKernelTestCommand executes V2 test tool directly", async () => {
    const lines = [];
    const result = await runKernelTestCommand({
      root: "/repo",
      argv: ["node", "--test"],
      write: (line) => lines.push(line),
      createKernelImpl: async () => createMockKernel({ status: "complete", content: "unused" })
    });

    assert.equal(result.call.name, "test");
    assert.deepEqual(result.call.params, { detect: false, argv: ["node", "--test"] });
    assert.equal(result.options.autonomy, "auto");
    assert.ok(lines.some((line) => line.includes("test output")));
  });

  test("buildEditPrompt preserves dry-run as an explicit model instruction", () => {
    assert.equal(
      buildEditPrompt("change README", { dryRun: true }),
      "change README\n\nConstraint: preview the diff only. Use diff_preview and do not apply changes."
    );
    assert.equal(buildEditPrompt("change README", { dryRun: false }), "change README");
  });

  test("runKernelTestCommand passes through non-zero exit code from shell tool", async () => {
    const result = await runKernelTestCommand({
      root: "/repo",
      argv: ["node", "-e", "process.exit(7)"],
      createKernelImpl: async () => ({
        session: { subscribe: () => ({ unsubscribe() {} }) },
        tools: {
          execute: async () => ({
            status: "success",
            content: [{ type: "text", text: "test output" }],
            metadata: { exit_code: 7, argv: ["node", "-e", "process.exit(7)"] }
          })
        }
      })
    });

    // V2 test tool returns status:"success" even when the command fails;
    // the real exit_code is in metadata and must be propagated by the CLI caller.
    assert.equal(result.status, "success");
    assert.equal(result.metadata.exit_code, 7);
  });

  test("runKernelAgentCommand prompts and resumes approval in process", async () => {
    const writes = [];
    const approvals = [];
    const result = await runKernelAgentCommand({
      root: "/repo",
      prompt: "modify a",
      write: (line) => writes.push(line),
      createKernelImpl: async () => ({
        session: { subscribe: () => ({ unsubscribe() {} }) },
        agent: {
          send: async () => ({ status: "awaiting_approval", approval: { id: "approval_1" }, content: "approval needed" }),
          approve: async (id, decision) => {
            approvals.push([id, decision]);
            return { status: "complete", content: "resumed final" };
          }
        }
      }),
      promptApproval: async () => "y"
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(approvals, [["approval_1", "approve"]]);
    assert.ok(writes.some((line) => line.includes("resumed final")));
  });

  test("runKernelAgentCommand loops until no more awaiting_approval", async () => {
    // Simulate: first approval (edit) resumes but immediately pauses again (shell)
    const writes = [];
    const approvals = [];
    let sendCalls = 0;
    const result = await runKernelAgentCommand({
      root: "/repo",
      prompt: "edit and run",
      write: (line) => writes.push(line),
      createKernelImpl: async () => ({
        session: { subscribe: () => ({ unsubscribe() {} }) },
        agent: {
          send: async () => {
            sendCalls += 1;
            return { status: "awaiting_approval", approval: { id: "approval_1" }, content: "first pause" };
          },
          approve: async (id, decision) => {
            approvals.push([id, decision]);
            if (approvals.length === 1) {
              return { status: "awaiting_approval", approval: { id: "approval_2" }, content: "second pause" };
            }
            return { status: "complete", content: "all done" };
          }
        }
      }),
      promptApproval: async (approval) => (approval.id === "approval_1" ? "y" : "y")
    });

    assert.equal(result.status, "complete");
    assert.equal(result.content, "all done");
    assert.deepEqual(approvals, [["approval_1", "approve"], ["approval_2", "approve"]]);
    assert.equal(sendCalls, 1);
  });

  test("runKernelChatCommand sends one-shot chat through V2 kernel in read-only mode", async () => {
    const sends = [];
    const writes = [];
    const result = await runKernelChatCommand({
      root: "/repo",
      prompt: "hello",
      write: (line) => writes.push(line),
      createKernelImpl: async () => ({
        session: { subscribe: () => ({ unsubscribe() {} }) },
        agent: {
          send: async (message, options) => {
            sends.push({ message, options });
            return { status: "complete", content: "hi" };
          }
        }
      })
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(sends, [{ message: "hello", options: { autonomy: "read-only", history: [] } }]);
    assert.ok(writes.includes("hi"));
  });

  test("runKernelChatCommand keeps multi-turn history across REPL sends", async () => {
    const sends = [];
    const questions = ["first", "second", "/exit"];
    const writes = [];

    await runKernelChatCommand({
      root: "/repo",
      write: (line) => writes.push(line),
      question: async () => questions.shift(),
      createKernelImpl: async () => ({
        session: { subscribe: () => ({ unsubscribe() {} }) },
        agent: {
          send: async (message, options) => {
            sends.push({ message, options });
            return { status: "complete", content: `answer:${message}` };
          }
        }
      })
    });

    assert.equal(sends.length, 2);
    assert.deepEqual(sends[0].options, { autonomy: "read-only", history: [] });
    assert.deepEqual(sends[1].options, {
      autonomy: "read-only",
      history: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer:first" }
      ]
    });
    assert.ok(writes.some((line) => line.includes("mode: read-only")));
  });

  test("runKernelChatCommand cycles mode and clears history", async () => {
    const sends = [];
    const questions = ["hello", "/mode", "edit", "/clear", "after", "/exit"];
    const writes = [];

    await runKernelChatCommand({
      root: "/repo",
      write: (line) => writes.push(line),
      question: async () => questions.shift(),
      createKernelImpl: async () => ({
        session: { subscribe: () => ({ unsubscribe() {} }) },
        agent: {
          send: async (message, options) => {
            sends.push({ message, options });
            return { status: "complete", content: `answer:${message}` };
          }
        }
      })
    });

    assert.equal(sends[1].options.autonomy, "gated");
    assert.deepEqual(sends[1].options.history, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "answer:hello" }
    ]);
    assert.deepEqual(sends[2].options, { autonomy: "gated", history: [] });
    assert.ok(writes.some((line) => line.includes("mode: gated")));
    assert.ok(writes.some((line) => line.includes("history cleared")));
  });

  test("runKernelChatCommand resolves approvals with shared approval loop", async () => {
    const approvals = [];
    const result = await runKernelChatCommand({
      root: "/repo",
      prompt: "edit",
      write: () => {},
      promptApproval: async () => "yes",
      createKernelImpl: async () => ({
        session: { subscribe: () => ({ unsubscribe() {} }) },
        agent: {
          send: async () => ({ status: "awaiting_approval", approval: { id: "approval_chat" }, content: "approval" }),
          approve: async (id, decision) => {
            approvals.push([id, decision]);
            return { status: "complete", content: "done" };
          }
        }
      })
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(approvals, [["approval_chat", "approve"]]);
  });

  test("chat repl renders recovery inbox", async () => {
    const questions = ["/recovery", "/exit"];
    const writes = [];
    await runKernelChatCommand({
      root: "/repo",
      write: (line) => writes.push(line),
      question: async () => questions.shift(),
      createKernelImpl: async () => ({
        session: { subscribe: () => ({ unsubscribe() {} }), getTimeline: async () => [] },
        agent: { send: async () => ({ status: "complete", content: "unused" }) },
        recovery: {
          list: async () => [{ id: "rec_pause_approval_1", type: "paused_turn", status: "pending", summary: "Approval required", allowed_actions: ["resume", "cancel"] }],
          report: async () => ({ found: [{ summary: "Approval required" }], done: [], blocked: [], next: ["/recovery resume rec_pause_approval_1"] })
        }
      })
    });

    assert.ok(writes.some((line) => line.includes("Recovery")));
    assert.ok(writes.some((line) => line.includes("rec_pause_approval_1")));
  });

  test("chat repl recovery cancel delegates to kernel", async () => {
    const questions = ["/recovery cancel rec_pause_approval_1", "/exit"];
    const calls = [];
    await runKernelChatCommand({
      root: "/repo",
      write: () => {},
      question: async () => questions.shift(),
      createKernelImpl: async () => ({
        session: { subscribe: () => ({ unsubscribe() {} }), getTimeline: async () => [] },
        agent: { send: async () => ({ status: "complete", content: "unused" }) },
        recovery: {
          cancel: async (id) => { calls.push(id); return { status: "cancelled" }; },
          list: async () => [],
          report: async () => ({ found: [], done: [], blocked: [], next: [] })
        }
      })
    });

    assert.deepEqual(calls, ["rec_pause_approval_1"]);
  });

  test("chat repl recovery resume delegates to kernel", async () => {
    const questions = ["/recovery resume rec_pause_approval_1", "/exit"];
    const calls = [];
    await runKernelChatCommand({
      root: "/repo",
      write: () => {},
      question: async () => questions.shift(),
      createKernelImpl: async () => ({
        session: { subscribe: () => ({ unsubscribe() {} }), getTimeline: async () => [] },
        agent: { send: async () => ({ status: "complete", content: "unused" }) },
        recovery: {
          resume: async (id, opts) => { calls.push([id, opts]); return { status: "resumed" }; },
          list: async () => [],
          report: async () => ({ found: [], done: [], blocked: [], next: [] })
        }
      })
    });

    assert.deepEqual(calls, [["rec_pause_approval_1", {}]]);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/apps/cli/render-events.test.js
// ---------------------------------------------------------------------------
describe("unit/apps/cli/render-events", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { summarizeKernelEvent, renderKernelResult, formatUsageLine, createEventRenderer } = await import("../../../src/apps/cli/render-events.js");

  const USAGE_SNAPSHOT = {
    requests: 4,
    total_prompt_tokens: 120,
    total_completion_tokens: 340,
    total_reasoning_tokens: 120,
    cache_hit_tokens: 80,
    cache_miss_tokens: 40,
    avg_latency_ms: 850
  };

  test("MCP event rendering shares safe state, correlation and quiet diagnostics", () => {
    const output = [];
    const render = createEventRenderer({ write: (line) => output.push(line) });
    render({ type: "mcp:log", entry: { serverId: "remote", level: "debug", message: "quiet" } });
    render({ type: "mcp:server_status", serverId: "remote", status: "CONNECTED" });
    assert.deepEqual(output, []);
    render({ type: "mcp:log", entry: { serverId: "remote", level: "error", category: "timeout", method: "tools/call", requestId: 0, durationMs: 12, message: "Timeout\x1b]0;owned\x07" } });
    assert.match(output.join("\n"), /remote.*tools\/call.*#0.*12ms.*Timeout/);
    assert.doesNotMatch(output.join("\n"), /[\x1b\x07]/);
    render({ type: "mcp:tool_test", serverId: "remote", status: "cancelled", runId: "trial_1", toolName: "mcp__remote__ping" });
    assert.match(output.at(-1), /remote.*cancelled.*mcp__remote__ping/);
  });

  // INKSTONE_SHOW_USAGE 进程级开关:用例现场改、finally 复原,不污染其它测试。
  function withUsageEnv(value, fn) {
    const prev = process.env.INKSTONE_SHOW_USAGE;
    if (value === undefined) delete process.env.INKSTONE_SHOW_USAGE;
    else process.env.INKSTONE_SHOW_USAGE = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.INKSTONE_SHOW_USAGE;
      else process.env.INKSTONE_SHOW_USAGE = prev;
    }
  }

  test("summarizeKernelEvent formats key V2 events without raw payload dumps", () => {
    assert.equal(
      summarizeKernelEvent({ type: "tool:call", call: { name: "read" } }),
      "tool read"
    );
    assert.equal(
      summarizeKernelEvent({ type: "file:diff_applied", change_id: "chg_1" }),
      "diff applied chg_1"
    );
    assert.equal(
      summarizeKernelEvent({ type: "approval:requested", approval: { id: "apr_1", summary: "edit requires approval" } }),
      "approval apr_1 edit requires approval"
    );
    assert.equal(
      summarizeKernelEvent({ type: "agent:final", content: "hello" }),
      "final hello"
    );
  });

  test("renderKernelResult returns final content and approval message", () => {
    assert.deepEqual(
      renderKernelResult({ status: "complete", content: "done" }),
      ["", "done"]
    );
    assert.deepEqual(
      renderKernelResult({ status: "awaiting_approval", approval: { id: "apr_1" } }),
      ["", "Approval required: apr_1", "Approve? y/N"]
    );
  });

  test("v1.9 M4 #11:renderKernelResult appends one-line usage summary when INKSTONE_SHOW_USAGE is set", () => {
    withUsageEnv("1", () => {
      const lines = renderKernelResult({ status: "complete", content: "done", usage: USAGE_SNAPSHOT });
      assert.equal(lines.length, 3);
      assert.equal(lines[0], "");
      assert.equal(lines[1], "done");
      assert.equal(lines[2], formatUsageLine(USAGE_SNAPSHOT));
      assert.ok(lines[2].includes("usage: tokens 120 prompt / 340 completion"));
      assert.ok(lines[2].includes("cache 80 hit / 40 miss"));
      assert.ok(lines[2].includes("reasoning 120 tok"));
      assert.ok(lines[2].includes("avg latency 850 ms"));
      // 缺 usage 快照时不追加(无数据不编造)
      assert.deepEqual(renderKernelResult({ status: "complete", content: "done" }), ["", "done"]);
      // 审批/错误终局不加 usage 行
      assert.deepEqual(renderKernelResult({ status: "error", error: "boom", usage: USAGE_SNAPSHOT }), ["", "Error: boom"]);
    });
  });

  test("v1.9 M4 #11:usage summary off by default and for falsy env values", () => {
    withUsageEnv(undefined, () => {
      assert.deepEqual(renderKernelResult({ status: "complete", content: "done", usage: USAGE_SNAPSHOT }), ["", "done"]);
    });
    for (const raw of ["", "0", "false"]) {
      withUsageEnv(raw, () => {
        assert.deepEqual(renderKernelResult({ status: "complete", content: "done", usage: USAGE_SNAPSHOT }), ["", "done"]);
      });
    }
  });

  test("v1.9 M4 #11:formatUsageLine renders all four segments, zero-safe", () => {
    const line = formatUsageLine(USAGE_SNAPSHOT);
    assert.equal(line, "usage: tokens 120 prompt / 340 completion · cache 80 hit / 40 miss · reasoning 120 tok · avg latency 850 ms");
    assert.equal(formatUsageLine({}), "usage: tokens 0 prompt / 0 completion · cache 0 hit / 0 miss · reasoning 0 tok · avg latency 0 ms");
    assert.equal(formatUsageLine(), "usage: tokens 0 prompt / 0 completion · cache 0 hit / 0 miss · reasoning 0 tok · avg latency 0 ms");
  });

  test("createEventRenderer writes only useful progress events", () => {
    const lines = [];
    const renderer = createEventRenderer({ write: (line) => lines.push(line) });

    renderer({ type: "user:message", content: "hi" });
    renderer({ type: "tool:result", result: { status: "success" } });
    renderer({ type: "model:request", purpose: "act" });

    assert.deepEqual(lines, ["- user hi", "- tool result success"]);
  });

  test("summarizeKernelEvent renders branch and rewind events", () => {
    assert.equal(
      summarizeKernelEvent({ type: "session:branch_created", branch_id: "br_child" }),
      "branch created br_child"
    );
    assert.equal(
      summarizeKernelEvent({ type: "session:branch_activated", branch_id: "br_child" }),
      "branch active br_child"
    );
    assert.equal(
      summarizeKernelEvent({ type: "session:rewind_preview", rollback_count: 3 }),
      "rewind preview 3 changes"
    );
    assert.equal(
      summarizeKernelEvent({ type: "session:rewind_applied", branch_id: "br_child", rollback_change_ids: ["a", "b"] }),
      "rewind applied br_child 2 changes"
    );
    assert.equal(
      summarizeKernelEvent({ type: "session:rewind_conflict", failed_change_id: "change_1" }),
      "rewind conflict change_1"
    );
    assert.equal(
      summarizeKernelEvent({ type: "session:rewind_failed", failed_change_id: "change_2" }),
      "rewind failed change_2"
    );
  });

  test("summarizeKernelEvent renders rewind recovery events", () => {
    assert.equal(
      summarizeKernelEvent({ type: "session:rewind_restore_started", applied_rollbacks: ["a", "b"] }),
      "rewind restoring 2 changes"
    );
    assert.equal(
      summarizeKernelEvent({ type: "session:rewind_restored", restored_files: ["a.txt"] }),
      "rewind restored 1 files"
    );
    assert.equal(
      summarizeKernelEvent({ type: "session:rewind_recovery_failed", reason: "restore_failed" }),
      "rewind recovery failed restore_failed"
    );
  });

  test("renderer summarizes recovery events without payload leaks", () => {
    const lines = [
      summarizeKernelEvent({ type: "recovery:report", found_count: 2, done_count: 1, blocked_count: 0 }),
      summarizeKernelEvent({ type: "tx:recovered", tx_id: "tx_123", kind: "edit", preserved_count: 1 }),
      summarizeKernelEvent({ type: "turn:rehydrated", approval_id: "approval_456", marker_status: "ok" })
    ];

    assert.ok(lines.some((line) => line.includes("recovery report: found 2, done 1, blocked 0")));
    assert.ok(lines.some((line) => line.includes("recovered edit tx_123")));
    assert.ok(lines.some((line) => line.includes("rehydrated approval approval_456")));
    assert.equal(lines.join("\n").includes("resume_state"), false);
  });

  test("summarizeKernelEvent renders multi-agent orchestration summaries", () => {
    assert.equal(summarizeKernelEvent({ type: "orchestration:routed", lane: "orchestrate" }), "routing: multi-agent");
    assert.equal(summarizeKernelEvent({ type: "orchestration:planned", subtasks: 1 }), "plan: 1 subtask");
    assert.equal(summarizeKernelEvent({ type: "orchestration:planned", subtasks: 3 }), "plan: 3 subtasks");
    assert.equal(summarizeKernelEvent({ type: "orchestration:round_started", round: 2, subtasks: 1 }), "round 2: 1 subtask");
    assert.equal(summarizeKernelEvent({ type: "orchestration:round_started", round: 2, subtasks: 4 }), "round 2: 4 subtasks");
    assert.equal(summarizeKernelEvent({ type: "orchestration:replanned", round: 3, new_subtasks: 1 }), "replan round 3: 1 new subtask");
    assert.equal(summarizeKernelEvent({ type: "orchestration:replanned", round: 3, new_subtasks: 2 }), "replan round 3: 2 new subtasks");
    assert.equal(summarizeKernelEvent({ type: "orchestration:completed", completed: 3, failed: 1, status: "partial" }), "orchestration complete: 3 succeeded, 1 failed (status: partial)");
  });

  test("subtask start/review: no dangling parens/commas, passed|failed literal", () => {
    assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_started", subtask_id: "s1", attempt: 1, tool_profile: "edit" }), "subtask s1: starting (attempt 1, profile edit)");
    assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_started", subtask_id: "s2", attempt: 2 }), "subtask s2: starting (attempt 2)");
    assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: true }), "subtask s1: review passed");
    assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: false, severity: "high" }), "subtask s1: review failed (severity: high)");
    assert.equal(summarizeKernelEvent({ type: "orchestration:subtask_reviewed", subtask_id: "s1", pass: false }), "subtask s1: review failed");
  });

  test("experience:retrieved printed only when count>0", () => {
    const lines = [];
    const renderer = createEventRenderer({ write: (l) => lines.push(l) });
    renderer({ type: "experience:retrieved", count: 0 });
    renderer({ type: "experience:retrieved", count: 2, tiers: ["T1", "T2"] });
    assert.deepEqual(lines, ["- experience: 2 recalled"]);
  });

  test("orchestration route respects lane: single vs orchestrate", () => {
    assert.equal(summarizeKernelEvent({ type: "orchestration:route_resolved", lane: "single" }), "routing: single-agent");
    assert.equal(summarizeKernelEvent({ type: "orchestration:routed", lane: "orchestrate" }), "routing: multi-agent");
    assert.equal(summarizeKernelEvent({ type: "orchestration:routed" }), "routing: multi-agent");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/apps/cli-sensitive-notice.test.js
// ---------------------------------------------------------------------------
describe("unit/apps/cli-sensitive-notice", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { formatSensitiveNotice } = await import("../../../src/apps/cli/render-events.js");
  const { describeSensitiveNotice } = await import("../../../src/apps/sensitive-notice-contract.js");

  function strip(lines) {
    // 去掉 ANSI 转义,便于断言文本(NO_COLOR/非 TTY 下本就没有)
    return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  }

  const descriptor = describeSensitiveNotice({
    paths: [{ path: ".env", reason: "secret-file" }],
    recordDir: ".deepseek-code/changes"
  });

  test("formatSensitiveNotice lists each path with a human reason label", () => {
    const text = strip(formatSensitiveNotice(descriptor)).join("\n");
    assert.match(text, /\.env/);
    assert.match(text, /secret file/);
    assert.match(text, /\.deepseek-code\/changes/);
  });

  // 这条是本提醒的设计要点:它**不是**权限审批,措辞必须让用户看出区别,
  // 否则会被按审批的肌肉记忆一路 y 下去。
  test("formatSensitiveNotice states plainly that it is NOT a permission prompt", () => {
    const text = strip(formatSensitiveNotice(descriptor)).join("\n");
    assert.match(text, /NOT a permission prompt/);
  });

  test("formatSensitiveNotice explains why the record cannot be redacted", () => {
    const text = strip(formatSensitiveNotice(descriptor)).join("\n");
    assert.match(text, /NOT redacted/);
    assert.match(text, /rollback needs the exact bytes/);
  });

  test("formatSensitiveNotice emits red-colored lines when color is enabled", () => {
    // theme.color 在非 TTY 下降级为原样返回,所以这里只断言「要么带红色码,要么纯文本」,
    // 不因运行环境不同而假红。
    const lines = formatSensitiveNotice(descriptor);
    const joined = lines.join("");
    const hasRed = joined.includes("\x1b[31m");
    const isPlain = !joined.includes("\x1b[");
    assert.ok(hasRed || isPlain, "要么全红要么纯文本,不得半途着色");
  });

  test("formatSensitiveNotice returns nothing for an empty descriptor", () => {
    assert.deepEqual(formatSensitiveNotice(null), []);
    assert.deepEqual(formatSensitiveNotice({ paths: [] }), []);
  });

  test("formatSensitiveNotice pluralizes correctly for multiple files", () => {
    const many = describeSensitiveNotice({
      paths: [{ path: ".env", reason: "secret-file" }, { path: ".npmrc", reason: "credential-file" }]
    });
    const text = strip(formatSensitiveNotice(many)).join("\n");
    assert.match(text, /these files/);
    assert.match(text, /credential file/);
    const one = strip(formatSensitiveNotice(descriptor)).join("\n");
    assert.match(one, /this file/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/apps/sensitive-notice-contract.test.js
// ---------------------------------------------------------------------------
describe("unit/apps/sensitive-notice-contract", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { describeSensitiveNotice, createSensitiveNoticeHandler, SENSITIVE_NOTICE_SEVERITY } = await import("../../../src/apps/sensitive-notice-contract.js");

  test("describeSensitiveNotice normalizes payload into a display descriptor", () => {
    const d = describeSensitiveNotice({
      paths: [{ path: ".env", reason: "secret-file" }, { path: ".npmrc", reason: "credential-file" }],
      recordDir: ".deepseek-code/changes"
    });
    assert.equal(d.kind, "sensitive-file-write");
    assert.equal(d.severity, SENSITIVE_NOTICE_SEVERITY);
    assert.equal(d.severity, "danger");
    assert.equal(d.count, 2);
    assert.deepEqual(d.paths, [
      { path: ".env", reason: "secret-file", reasonKey: "sensitive.reason.secret" },
      { path: ".npmrc", reason: "credential-file", reasonKey: "sensitive.reason.credential" }
    ]);
  });

  test("describeSensitiveNotice is total: never throws on junk input", () => {
    assert.equal(describeSensitiveNotice(null), null);
    assert.equal(describeSensitiveNotice({}), null);
    assert.equal(describeSensitiveNotice({ paths: [] }), null);
    const d = describeSensitiveNotice({ paths: [{}] });
    assert.equal(d.paths[0].path, "");
    assert.equal(d.paths[0].reasonKey, "sensitive.reason.other");
    assert.equal(d.recordDir, ".deepseek-code/changes");
  });

  test("handler allows only on explicit true and never caches the answer", async () => {
    const asked = [];
    const handler = createSensitiveNoticeHandler(async (d) => { asked.push(d); return true; });
    const notice = { paths: [{ path: ".env", reason: "secret-file" }] };

    assert.equal(await handler(notice), true);
    assert.equal(await handler(notice), true);
    // 同一份载荷问两次就得提问两次 —— 不缓存是本设计的硬要求
    assert.equal(asked.length, 2, "选择不得被缓存,每次都要提问");
  });

  test("handler declines on anything other than true, and reports it", async () => {
    const declined = [];
    const notice = { paths: [{ path: ".env", reason: "secret-file" }] };

    for (const answer of [false, undefined, null, "yes", 1]) {
      const handler = createSensitiveNoticeHandler(async () => answer, (d) => declined.push(d));
      assert.equal(await handler(notice), false, `${String(answer)} 不得被当作同意`);
    }
    assert.equal(declined.length, 5);
  });

  // 策略回归:没有任何自治档位能跳过提问 —— handler 从结构上就拿不到 autonomy,
  // ask 只收到展示描述符。这条测试锁住这个设计选择,防止后人加「按档位放行」。
  test("handler takes no autonomy input, so no autonomy level can skip the prompt", async () => {
    const calls = [];
    const handler = createSensitiveNoticeHandler(async (...args) => { calls.push(args); return true; });
    await handler({ paths: [{ path: ".env", reason: "secret-file" }], autonomy: "full-auto" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1, "ask 只接收展示描述符一个参数");
    const descriptor = calls[0][0];
    assert.equal(descriptor.autonomy, undefined, "描述符不得携带 autonomy");
    assert.deepEqual(
      Object.keys(descriptor).sort(),
      ["count", "kind", "paths", "recordDir", "severity"],
      "描述符字段集固定,不含任何档位信息"
    );
  });

  test("createSensitiveNoticeHandler requires an ask function", () => {
    assert.throws(() => createSensitiveNoticeHandler(null), /ask is required/);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/apps/model-catalog.test.js
// ---------------------------------------------------------------------------
describe("unit/apps/model-catalog", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { fetchModelIds } = await import("../../../src/apps/model-catalog.js");

  test("fetches /models with bearer auth and maps ids", async () => {
    const calls = [];
    const ids = await fetchModelIds({
      baseUrl: "https://api.example.com/",
      apiKey: "sk-x",
      fetchImpl: async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ data: [{ id: "m1" }, { id: "m2" }, {}] }) };
      }
    });
    assert.deepEqual(ids, ["m1", "m2"]);
    assert.equal(calls[0].url, "https://api.example.com/models");
    assert.equal(calls[0].opts.headers.Authorization, "Bearer sk-x");
  });

  test("throws without api key", async () => {
    await assert.rejects(() => fetchModelIds({ baseUrl: "x", apiKey: "" }), /no API key/);
  });

  test("throws on non-2xx with status detail", async () => {
    await assert.rejects(
      () => fetchModelIds({ baseUrl: "b", apiKey: "k", fetchImpl: async () => ({ ok: false, status: 401, text: async () => "denied" }) }),
      /401 denied/
    );
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/cli-semantic-flags.test.js
// ---------------------------------------------------------------------------
describe("cli-semantic-flags", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { semanticOverrideFromFlags } = await import("../../../src/cli.js");

  test("--include-method-hints implies enabled + hints", () => {
    assert.deepEqual(semanticOverrideFromFlags(new Map([["include-method-hints", true]])), { enabled: true, includeMethodHints: true });
  });
  test("--semantic-context enables semantic only", () => {
    assert.deepEqual(semanticOverrideFromFlags(new Map([["semantic-context", true]])), { enabled: true });
  });
  test("no flag -> null (no override, protects disabled-parity)", () => {
    assert.equal(semanticOverrideFromFlags(new Map()), null);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/cli-fim.test.js
// ---------------------------------------------------------------------------
describe("cli-fim", async () => {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { spawnSync } = await import("node:child_process");
  const { default: path } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { runFim } = await import("../../../src/cli.js");

  const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const binPath = path.join(repoRoot, "bin", "inkstone.js");

  // runFim 经 process.exitCode 报错(循 runTest 风格),而 node --test 以整个文件的
  // 进程退出码判定成败——故每个可能置位的用例前后保存/恢复,避免失败用例把绿测染红。
  async function captureExitCode(fn) {
    const original = process.exitCode;
    try {
      return await fn();
    } finally {
      process.exitCode = original;
    }
  }

  // 假 config:loadConfig(allowMissingKey:false) 的最小形态
  // (maxTokens 默认值来源 + limits.modelTimeoutMs 透传)。
  const fakeConfig = {
    apiKey: "sk-test",
    maxTokens: 4096,
    limits: { modelTimeoutMs: 120000 }
  };

  // 假内核:记录 fim.complete 入参;metrics.getUsage 在调用前返回空账、调用后返回
  // fim 通道入账(循 model-gateway recordUsage 之后的真实形态);dispose 记录调用。
  function createFakeKernel({ completion = "  return a + b;\n}", usage = null, failWith = null } = {}) {
    const recorded = { calls: [], disposed: false };
    return {
      get calls() { return recorded.calls; },
      get disposed() { return recorded.disposed; },
      fim: {
        async complete(prefix, suffix, options) {
          recorded.calls.push({ prefix, suffix, options });
          if (failWith) throw failWith;
          return completion;
        }
      },
      metrics: {
        getUsage: () => (recorded.calls.length === 0
          ? { by_channel: {}, by_model: {} }
          : usage || {
              by_channel: { fim: { requests: 1, prompt_tokens: 96, completion_tokens: 128, total_tokens: 224 } },
              by_model: { "deepseek-flash": { requests: 1, prompt_tokens: 96, completion_tokens: 128, total_tokens: 224 } }
            })
      },
      dispose() { recorded.disposed = true; }
    };
  }

  // runFim 的 deps 注入(循 kernel-runner 的 *Impl DI 模式):捕获 stdout/stderr、
  // 假 config / 假内核、假文件读、确定性时钟(每次调用 +500ms → 完成耗时恒 500ms)。
  function makeHarness({ kernel, config = fakeConfig, files = {}, loadConfigImpl } = {}) {
    const out = [];
    const err = [];
    const created = [];
    const builtWith = [];
    const fakeKernel = kernel || createFakeKernel();
    let clock = 0;
    const deps = {
      write: (line) => out.push(line),
      writeError: (line) => err.push(line),
      loadConfigImpl: loadConfigImpl || (async () => config),
      buildKernelOptionsImpl: async (root) => { builtWith.push(root); return { built: true }; },
      createKernelImpl: async (root, options) => { created.push({ root, options }); return fakeKernel; },
      readFileImpl: async (file) => {
        const key = path.resolve(file);
        if (!(key in files)) {
          throw Object.assign(new Error(`ENOENT: no such file, open '${key}'`), { code: "ENOENT" });
        }
        return files[key];
      },
      now: () => (clock += 500)
    };
    return { deps, out, err, kernel: fakeKernel, created, builtWith };
  }

  test("无 prefix 来源 → stderr 一行用法提示 + 退出码 1，不触达内核", async () => {
    await captureExitCode(async () => {
      const h = makeHarness();
      await runFim("/root", [], new Map(), h.deps);

      assert.equal(process.exitCode, 1);
      assert.equal(h.err.length, 1);
      assert.match(h.err[0], /^用法：inkstone fim --prefix <text>/);
      assert.deepEqual(h.out, []);
      assert.equal(h.builtWith.length, 0);
      assert.equal(h.created.length, 0);
    });
  });

  test("--prefix 空字符串同样走用法提示（空 prefix 无补全意义）", async () => {
    await captureExitCode(async () => {
      const h = makeHarness();
      await runFim("/root", [], new Map([["prefix", ""]]), h.deps);

      assert.equal(process.exitCode, 1);
      assert.match(h.err[0], /^用法：/);
      assert.equal(h.created.length, 0);
    });
  });

  test("--prefix 与 --file 同给 → 互斥报错，不读文件不建内核", async () => {
    await captureExitCode(async () => {
      const h = makeHarness({ files: { [path.resolve("/root/a.js")]: "content" } });
      await runFim("/root", [], new Map([["prefix", "p"], ["file", "a.js"]]), h.deps);

      assert.equal(process.exitCode, 1);
      assert.equal(h.err.length, 1);
      assert.match(h.err[0], /互斥/);
      assert.deepEqual(h.out, []);
      assert.equal(h.created.length, 0);
    });
  });

  test("--file 读取失败 → stderr 一行 + 退出码 1", async () => {
    await captureExitCode(async () => {
      const h = makeHarness({ files: {} });
      await runFim("/root", [], new Map([["file", "missing.js"]]), h.deps);

      assert.equal(process.exitCode, 1);
      assert.equal(h.err.length, 1);
      assert.match(h.err[0], /读取 --file 文件失败/);
      assert.equal(h.created.length, 0);
    });
  });

  test("--file 读文件全文作 prefix（未给 --prefix 时）", async () => {
    await captureExitCode(async () => {
      const filePath = path.resolve("/root", "src", "a.js");
      const h = makeHarness({ files: { [filePath]: "FILE PREFIX CONTENT" } });
      await runFim("/root", [], new Map([["file", path.join("src", "a.js")]]), h.deps);

      assert.equal(h.kernel.calls.length, 1);
      assert.equal(h.kernel.calls[0].prefix, "FILE PREFIX CONTENT");
      assert.equal(h.created.length, 1);
      assert.equal(h.created[0].root, "/root");
      assert.deepEqual(h.created[0].options, { built: true });
      assert.deepEqual(h.builtWith, ["/root"]);
    });
  });

  test("位置参数作 prefix（未给 --prefix/--file 时，循 search 的 join 约定）", async () => {
    await captureExitCode(async () => {
      const h = makeHarness();
      await runFim("/root", ["const", "x", "="], new Map(), h.deps);

      assert.equal(h.kernel.calls[0].prefix, "const x =");
    });
  });

  test("成功路径：正文原样 stdout + dim 用量摘要 + finally dispose", async () => {
    await captureExitCode(async () => {
      const h = makeHarness();
      await runFim("/root", [], new Map([["prefix", "function add(a, b) {"], ["suffix", "}"]]), h.deps);

      assert.ok(!process.exitCode, "成功路径不得留下非零退出码");
      assert.equal(h.kernel.calls.length, 1);
      const call = h.kernel.calls[0];
      assert.equal(call.prefix, "function add(a, b) {");
      assert.equal(call.suffix, "}");
      assert.equal(call.options.model, undefined, "未给 --model 时不覆盖 models.fim 解析");
      assert.equal(call.options.maxTokens, 4096, "默认取 config.maxTokens（4096）");
      assert.equal(call.options.timeoutMs, 120000, "config.limits.modelTimeoutMs 透传");
      assert.equal(h.out[0], "  return a + b;\n}", "补全正文原样落 stdout");
      assert.ok(h.out[1].includes("deepseek-flash"), "摘要含遥测解析出的模型");
      assert.ok(h.out[1].includes("128 completion tokens"));
      assert.ok(h.out[1].includes("500 ms"));
      assert.ok(h.out[1].includes("256 tps"));
      assert.equal(h.kernel.disposed, true);
    });
  });

  test("--model 显式覆盖并进摘要", async () => {
    await captureExitCode(async () => {
      const h = makeHarness();
      await runFim("/root", [], new Map([["prefix", "p"], ["model", "custom-fim"]]), h.deps);

      assert.equal(h.kernel.calls[0].options.model, "custom-fim");
      assert.ok(h.out[1].includes("custom-fim"));
    });
  });

  test("--max-tokens 缺省取 config.maxTokens（非 4096 时原样透传）", async () => {
    await captureExitCode(async () => {
      const h = makeHarness({ config: { ...fakeConfig, maxTokens: 2048 } });
      await runFim("/root", [], new Map([["prefix", "p"]]), h.deps);

      assert.equal(h.kernel.calls[0].options.maxTokens, 2048);
      assert.equal(h.err.length, 0, "未超限不提示");
    });
  });

  test("--max-tokens 超 4096 → 钳制为 4096 并提示，退出码不受影响", async () => {
    await captureExitCode(async () => {
      const h = makeHarness();
      await runFim("/root", [], new Map([["prefix", "p"], ["max-tokens", "99999"]]), h.deps);

      assert.equal(h.kernel.calls[0].options.maxTokens, 4096);
      assert.equal(h.err.length, 1);
      assert.match(h.err[0], /--max-tokens 99999 超过 4096 上限，已钳制为 4096/);
      assert.ok(!process.exitCode, "钳制是提示不是错误");
    });
  });

  test("fim.complete 失败 → stderr 静默一行 error message + 退出码 1 + 仍 dispose", async () => {
    await captureExitCode(async () => {
      const h = makeHarness({ kernel: createFakeKernel({ failWith: new Error("model request timed out after 120000ms") }) });
      await runFim("/root", [], new Map([["prefix", "p"]]), h.deps);

      assert.equal(process.exitCode, 1);
      assert.deepEqual(h.err, ["model request timed out after 120000ms"], "错误 message 原样一行，不加前缀");
      assert.deepEqual(h.out, [], "stdout 不漏错误文本");
      assert.equal(h.kernel.disposed, true);
    });
  });

  test("遥测缺账时摘要只含 latency（“若有”语义：不造假 tokens/model）", async () => {
    await captureExitCode(async () => {
      const h = makeHarness({ kernel: createFakeKernel({ usage: { by_channel: {}, by_model: {} } }) });
      await runFim("/root", [], new Map([["prefix", "p"]]), h.deps);

      assert.equal(h.out.length, 2);
      assert.equal(h.out[1], "500 ms");
    });
  });

  test("无 API 密钥 → loadConfig 抛出向上传播（循现有风格，由 bin 统一落 stderr + 退出码 1）", async () => {
    await captureExitCode(async () => {
      const h = makeHarness({
        loadConfigImpl: async () => {
          throw new Error("缺少 DeepSeek API 密钥。请运行 config init --api-key <key>，或设置 DEEPSEEK_API_KEY。");
        }
      });
      await assert.rejects(
        runFim("/root", [], new Map([["prefix", "p"]]), h.deps),
        /缺少 DeepSeek API 密钥/
      );
      assert.equal(h.created.length, 0, "密钥缺失不建内核");
    });
  });

  test("子进程：inkstone fim（无 prefix）→ 退出码 1 + stderr 用法提示", () => {
    const child = spawnSync(process.execPath, [binPath, "fim"], { encoding: "utf8" });

    assert.equal(child.status, 1, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    assert.match(child.stderr, /用法：inkstone fim --prefix/);
    assert.equal(child.stdout, "");
  });

  test("子进程：inkstone help 输出含 fim 命令行", () => {
    const child = spawnSync(process.execPath, [binPath, "help"], { encoding: "utf8" });

    assert.equal(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    assert.ok(child.stdout.includes("inkstone fim --prefix <text>"));
  });
});
