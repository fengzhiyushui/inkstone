# V2-17 Chat Kernel Unification Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Route `chat` through the V2 kernel, add read-only autonomy, close the chat/provider bypass, and harden git process execution.

**Architecture:** The CLI owns one kernel-backed chat REPL implemented in `src/apps/cli/kernel-runner.js`. Conversation continuity is carried as explicit model-message history through `agent.send(..., { history })`, `modelGateway.reply`, and `runExecutorLoop`, while the kernel session remains the event/timeline source. Shell and git share one `runProcess` primitive from `src/security/shell-policy.js`.

**Tech Stack:** Node.js ESM, built-in `node:test`, DeepSeek chat messages, existing V2 kernel/runtime/tool APIs.

---

## File Structure

- Modify `src/tools/permissions/permission-engine.js`: add `read-only` to `DEFAULT_POLICY_MATRIX`.
- Modify `src/security/shell-policy.js`: host `runProcess` next to shell param/output helpers.
- Modify `src/tools/builtin/shell.js`: import `runProcess` from `shell-policy`.
- Modify `src/tools/builtin/git.js`: run git directly through `runProcess` with `side_effect: "process"`.
- Modify `src/deepseek/prompt-assembler.js`: accept `history` and insert sanitized prior messages before the current user message.
- Modify `src/deepseek/model-gateway.js`: forward `options.history` into `assembleReplyMessages`.
- Modify `src/core/execution/executor-loop.js`: forward `options.history` into initial model messages and persist it in approval resume state.
- Modify `src/apps/cli/kernel-runner.js`: extract `resolveApprovals`, add `runKernelChatCommand`, REPL commands, and mode cycling.
- Modify `src/cli.js`: route `chat` to `runKernelChatCommand`, remove `src/chat.js` import, remove dead `detectTestCommand`.
- Modify `src/tui.js`: remove legacy `agent.js` and `chat.js` imports; route chat action to `runKernelChatCommand`.
- Replace `src/chat.js`: keep a compatibility wrapper around `runKernelChatCommand` without provider/history JSON.
- Modify `README.md`: rewrite `已知限制`.
- Modify tests listed in each task.

## Task 1: Read-Only Autonomy

**Files:**
- Modify: `tests/unit/tools/permission-engine.test.js`
- Modify: `src/tools/permissions/permission-engine.js`

- [ ] **Step 1: Write failing permission tests**

Add these tests to `tests/unit/tools/permission-engine.test.js`:

```js
test("default matrix covers 8 categories across 5 autonomy levels", () => {
  const categories = ["read", "read_secret", "write_create", "write_update", "write_delete", "execute", "network", "destructive"];
  for (const autonomy of ["read-only", "supervised", "gated", "auto", "full-auto"]) {
    assert.deepEqual(Object.keys(DEFAULT_POLICY_MATRIX[autonomy]).sort(), categories.sort());
  }
});

test("read-only allows reads, asks for secrets, and denies mutations and side effects", () => {
  const engine = createPermissionEngine();
  const expected = {
    read: "allow",
    read_secret: "ask",
    write_create: "deny",
    write_update: "deny",
    write_delete: "deny",
    execute: "deny",
    network: "deny",
    destructive: "deny"
  };

  for (const [category, decision] of Object.entries(expected)) {
    const result = engine.decide(
      { name: `tool_${category}`, category, params: {} },
      createPolicyContext({ autonomy: "read-only" })
    );
    assert.equal(result.decision, decision, category);
    if (category !== "destructive") {
      assert.equal(result.matched_rule, `default:read-only:${category}`);
    }
  }
});
```

The existing "covers 8 categories across 4 autonomy levels" test should be replaced by the 5-level version above.

- [ ] **Step 2: Run failing test**

Run: `npm.cmd test -- tests/unit/tools/permission-engine.test.js`

Expected: FAIL because `DEFAULT_POLICY_MATRIX["read-only"]` is undefined.

- [ ] **Step 3: Implement read-only matrix row**

Add this row before `supervised` in `DEFAULT_POLICY_MATRIX`:

```js
  "read-only": {
    read: "allow", read_secret: "ask",
    write_create: "deny", write_update: "deny", write_delete: "deny",
    execute: "deny", network: "deny", destructive: "deny"
  },
```

- [ ] **Step 4: Run test**

Run: `npm.cmd test -- tests/unit/tools/permission-engine.test.js`

Expected: PASS.

## Task 2: Shared Process Primitive And Git Hardening

**Files:**
- Modify: `tests/unit/tools/builtin-process.test.js`
- Modify: `src/security/shell-policy.js`
- Modify: `src/tools/builtin/shell.js`
- Modify: `src/tools/builtin/git.js`

- [ ] **Step 1: Write failing process/git tests**

Add this import:

```js
import { runProcess } from "../../../src/security/shell-policy.js";
```

Add these tests to `tests/unit/tools/builtin-process.test.js`:

```js
test("security shell policy exports shared runProcess primitive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-run-process-"));
  const result = await runProcess(
    [process.execPath, "-e", "console.log('shared')"],
    { cwd: root, timeoutMs: 30000 }
  );

  assert.equal(result.metadata.exit_code, 0);
  assert.equal(result.stdout.trim(), "shared");
});

test("git tool uses honest process side-effect metadata and direct read execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-git-direct-"));
  const tool = createGitTool();

  assert.equal(tool.category, "read");
  assert.equal(tool.side_effect, "process");

  const result = await tool.execute({ op: "status" }, { projectRoot: root });

  assert.ok(typeof result.metadata.exit_code === "number" || result.metadata.spawn_error != null);
  assert.deepEqual(tool.normalizeParams({ op: "log" }).argv, ["git", "log", "--oneline", "-20"]);
});
```

- [ ] **Step 2: Run failing test**

Run: `npm.cmd test -- tests/unit/tools/builtin-process.test.js`

Expected: FAIL because `runProcess` is not exported from `shell-policy.js` and git metadata is still `side_effect: "none"`.

- [ ] **Step 3: Move runProcess to shell-policy**

In `src/security/shell-policy.js`, add:

```js
import { spawn } from "node:child_process";
```

Then append the current `runProcess` implementation from `src/tools/builtin/shell.js` unchanged, using the existing `limitOutput` function.

- [ ] **Step 4: Update shell tool import/export**

In `src/tools/builtin/shell.js`, replace:

```js
import { spawn } from "node:child_process";
import { normalizeShellParams, limitOutput } from "../../security/shell-policy.js";
```

with:

```js
import { normalizeShellParams, runProcess } from "../../security/shell-policy.js";
```

Delete the local `runProcess` function from `shell.js`.

- [ ] **Step 5: Update git tool direct execution**

In `src/tools/builtin/git.js`, replace the shell import with:

```js
import { runProcess } from "../../security/shell-policy.js";
import { resolveWorkspacePath } from "../../workspace/path-safety.js";
```

Change metadata:

```js
side_effect: "process",
```

Change `execute` to:

```js
    execute: async (params, context) => {
      const normalized = normalizeParams(params);
      const cwd = await resolveWorkspacePath(context.projectRoot, ".", { mustExist: true });
      return runProcess(normalized.argv, { cwd: cwd.real });
    }
```

- [ ] **Step 6: Run test**

Run: `npm.cmd test -- tests/unit/tools/builtin-process.test.js`

Expected: PASS.

## Task 3: Conversation History Threading

**Files:**
- Modify: `tests/unit/deepseek/model-gateway.test.js`
- Modify: `tests/unit/core/execution/executor-loop.test.js`
- Modify: `src/deepseek/prompt-assembler.js`
- Modify: `src/deepseek/model-gateway.js`
- Modify: `src/core/execution/executor-loop.js`

- [ ] **Step 1: Write failing prompt/gateway tests**

Add to `tests/unit/deepseek/model-gateway.test.js`:

```js
test("assembleReplyMessages inserts sanitized history before current user message", () => {
  const messages = assembleReplyMessages({
    message: "What did I ask first?",
    classification: { task_type: "query" },
    history: [
      { role: "system", content: "ignored system" },
      { role: "user", content: "Remember alpha" },
      { role: "assistant", content: "Alpha noted" },
      { role: "tool", content: "ignored tool" },
      { role: "assistant", content: "" }
    ]
  });

  assert.deepEqual(messages.map((entry) => entry.role), ["system", "user", "assistant", "user"]);
  assert.equal(messages[1].content, "Remember alpha");
  assert.equal(messages[2].content, "Alpha noted");
  assert.equal(messages[3].content, "What did I ask first?");
});

test("reply forwards options history into assembled request messages", async () => {
  const calls = [];
  const gateway = createDeepSeekGateway({
    apiKey: "key",
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body).messages);
      return jsonResponse(200, {
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "remembered" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 4 }
      });
    }
  });

  await gateway.reply({
    message: "second",
    classification: { task_type: "query" },
    options: {
      history: [
        { role: "user", content: "first" },
        { role: "assistant", content: "one" }
      ]
    }
  });

  assert.deepEqual(calls[0].map((entry) => entry.role), ["system", "user", "assistant", "user"]);
  assert.equal(calls[0][1].content, "first");
  assert.equal(calls[0][3].content, "second");
});
```

- [ ] **Step 2: Write failing executor test**

Add to `tests/unit/core/execution/executor-loop.test.js`:

```js
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
```

- [ ] **Step 3: Run failing tests**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/model-gateway.test.js tests/unit/core/execution/executor-loop.test.js
```

Expected: FAIL because history is ignored.

- [ ] **Step 4: Implement history support**

Change `assembleReplyMessages` signature to include `history = []`, build sanitized history, and insert it before the current user message:

```js
export function assembleReplyMessages({ message, classification = null, context = null, systemAddendum = "", history = [] } = {}) {
  const contextSummary = context?.summary ? `\nProject context:\n${context.summary}` : "";
  const taskType = classification?.task_type || "general";
  const system = { role: "system", content: ["You are DeepSeek Code, a local coding agent optimized for DeepSeek models.", "Answer plainly for query tasks. Do not output JSON unless explicitly requested.", `Current task type: ${taskType}.`, contextSummary, systemAddendum].filter(Boolean).join("\n") };
  const priorMessages = sanitizeHistory(history);
  return [system, ...priorMessages, { role: "user", content: String(message || "") }];
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((entry) => entry && (entry.role === "user" || entry.role === "assistant") && String(entry.content || "").trim())
    .map((entry) => ({ role: entry.role, content: String(entry.content) }))
    .slice(-20);
}
```

In `model-gateway.js`, change reply assembly to:

```js
const messages = assembleReplyMessages({ message, classification, context, turn, history: options.history });
```

In `executor-loop.js`, add `history: options.history` to the initial `assembleReplyMessages` call.

- [ ] **Step 5: Run tests**

Run:

```powershell
npm.cmd test -- tests/unit/deepseek/model-gateway.test.js tests/unit/core/execution/executor-loop.test.js
```

Expected: PASS.

## Task 4: Kernel Chat REPL And Approval Reuse

**Files:**
- Modify: `tests/unit/apps/cli/kernel-runner.test.js`
- Modify: `src/apps/cli/kernel-runner.js`
- Replace: `src/chat.js`

- [ ] **Step 1: Write failing chat runner tests**

Update the kernel-runner import in `tests/unit/apps/cli/kernel-runner.test.js`:

```js
import {
  runKernelAgentCommand,
  runKernelChatCommand,
  runKernelTestCommand,
  buildEditPrompt
} from "../../../../src/apps/cli/kernel-runner.js";
```

Add these tests:

```js
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
```

- [ ] **Step 2: Run failing test**

Run: `npm.cmd test -- tests/unit/apps/cli/kernel-runner.test.js`

Expected: FAIL because `runKernelChatCommand` is missing.

- [ ] **Step 3: Extract approval resolver**

In `src/apps/cli/kernel-runner.js`, add an exported helper:

```js
export async function resolveApprovals({ kernel, result, write = console.log, promptApproval = defaultPromptApproval } = {}) {
  let current = result;
  for (const line of renderKernelResult(current)) write(line);
  while (current.status === "awaiting_approval" && current.approval?.id) {
    const answer = await promptApproval(current.approval);
    const decision = isApprovalYes(answer) ? "approve" : "deny";
    current = await kernel.agent.approve(current.approval.id, decision);
    for (const line of renderKernelResult(current)) write(line);
  }
  return current;
}
```

Then replace the duplicate approval loop in `runKernelAgentCommand` with:

```js
let result = await kernel.agent.send(message, { autonomy, ...sendOptions });
return await resolveApprovals({ kernel, result, write, promptApproval });
```

- [ ] **Step 4: Implement chat command**

Add `runKernelChatCommand`, `runChatRepl`, `handleChatCommand`, `nextChatMode`, `defaultQuestion`, `appendHistory`, and `createKernelForRunner` to `kernel-runner.js`. The implementation must:

- create one kernel per chat command;
- subscribe with `createEventRenderer`;
- default `mode` to `"read-only"`;
- send normal lines with `{ autonomy: mode, history }`;
- append `{ role:"user" }` and `{ role:"assistant" }` after complete sends;
- support `/mode`, `/mode read-only`, `/mode gated`, `/mode auto`, `/clear`, `/history`, `/exit`, `/quit`;
- return the final one-shot result for prompted chat;
- return `{ status: "complete", content: "chat exited" }` after REPL exit.

- [ ] **Step 5: Replace chat.js compatibility wrapper**

Replace `src/chat.js` content with:

```js
import { runKernelChatCommand } from "./apps/cli/kernel-runner.js";

export async function chatCommand(input = {}) {
  return runKernelChatCommand(input);
}
```

- [ ] **Step 6: Run test**

Run: `npm.cmd test -- tests/unit/apps/cli/kernel-runner.test.js`

Expected: PASS.

## Task 5: CLI/TUI Routing And Boundary Guard

**Files:**
- Modify: `tests/integration/v2-interface-boundary.test.js`
- Modify: `src/cli.js`
- Modify: `src/tui.js`

- [ ] **Step 1: Write failing boundary tests**

Add to `tests/integration/v2-interface-boundary.test.js`:

```js
test("CLI and TUI chat route through V2 kernel runner, not legacy chat or askDeepSeek", async () => {
  const cli = await source("src/cli.js");
  const tui = await source("src/tui.js");
  const chat = await source("src/chat.js");

  assert.match(cli, /runKernelChatCommand/);
  assert.match(tui, /runKernelChatCommand/);
  assert.doesNotMatch(cli, /from "\.\/chat\.js"/);
  assert.doesNotMatch(tui, /from "\.\/chat\.js"/);
  assert.doesNotMatch(cli, /askDeepSeek/);
  assert.doesNotMatch(tui, /askDeepSeek/);
  assert.doesNotMatch(chat, /askDeepSeek|chatHistoryPath|loadChatHistory|saveChatHistory|\.deepseek-code/);
});
```

Extend the existing TUI test with:

```js
assert.doesNotMatch(tui, /from "\.\/agent\.js"/);
```

- [ ] **Step 2: Run failing boundary test**

Run: `npm.cmd test -- tests/integration/v2-interface-boundary.test.js`

Expected: FAIL because CLI/TUI still import `chat.js` and TUI imports `agent.js`.

- [ ] **Step 3: Update CLI routing and remove dead code**

In `src/cli.js`:

- remove `import { chatCommand } from "./chat.js";`;
- change the kernel-runner import to include `runKernelChatCommand`;
- change `runChat` to:

```js
async function runChat(root, args, flags) {
  const prompt = args.join(" ").trim();
  const result = await runKernelChatCommand({
    root,
    prompt,
    sendOptions: commonOptions(flags)
  });
  if (prompt && result?.content) {
    // runKernelChatCommand renders through the shared renderer; no extra print.
  }
}
```

- delete the entire `detectTestCommand` function.

- [ ] **Step 4: Update TUI routing**

In `src/tui.js`:

- remove `import { askCommand, editCommand } from "./agent.js";`;
- remove `import { chatCommand } from "./chat.js";`;
- add `import { runKernelChatCommand } from "./apps/cli/kernel-runner.js";`;
- change the chat action callback to:

```js
      await withCookedInput(() => runKernelChatCommand({
        root,
        createKernelImpl: async () => kernel,
        createKernelOptions: {},
        sendOptions: defaultOptions()
      }));
      await pause("连续对话已结束。按回车返回。");
```

Keep existing encoded UI strings where possible if the file is already mojibake.

- [ ] **Step 5: Run boundary test**

Run: `npm.cmd test -- tests/integration/v2-interface-boundary.test.js`

Expected: PASS.

## Task 6: README Update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update Known Limitations**

Replace the `## 已知限制` bullets with:

```md
## 已知限制

- 审批、repair、rewind 的恢复仍是进程内恢复，不保证 CLI 崩溃或机器重启后的完整恢复；崩溃安全恢复留给 V2-18。
- repair executor 目前是单轮修复执行器，多轮自动诊断和更复杂的验证策略仍待扩展。
- 会话、变更记录和分支/rewind 目前没有跨进程文件锁；不要同时在同一项目目录运行多个会写入状态的实例。
- legacy `src/kernel/*`、`src/agent.js`、`src/provider.js` 仍保留，用于兼容未迁移命令和旧接口；完整删除和 `apps/` 目录收敛留给 V2-19。
- GUI usage stats 在离线或未接入真实模型调用时可能显示零值。
- `chat` 已走 V2 kernel，默认 `read-only`，可在会话中用 `/mode` 切换到 `gated` 或 `auto`。
```

- [ ] **Step 2: Verify README section**

Run: `Select-String -Path README.md -Pattern "审批恢复流程尚未贯通|chat.*read-only|V2-18" -Context 0,1`

Expected: old false claim is absent; new chat/read-only and V2-18 notes are present.

## Task 7: Focused And Full Verification

**Files:**
- All modified files.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
npm.cmd test -- tests/unit/tools/permission-engine.test.js tests/unit/tools/builtin-process.test.js tests/unit/deepseek/model-gateway.test.js tests/unit/core/execution/executor-loop.test.js tests/unit/apps/cli/kernel-runner.test.js tests/integration/v2-interface-boundary.test.js
```

Expected: PASS.

- [ ] **Step 2: Run syntax check**

Run: `npm.cmd run check`

Expected: PASS.

- [ ] **Step 3: Run full suite**

Run: `npm.cmd test`

Expected: PASS.

- [ ] **Step 4: Run whitespace check**

Run: `git diff --check`

Expected: no output and exit 0.

- [ ] **Step 5: Inspect working tree**

Run: `git status --short`

Expected: only v2-17 files are modified by this work, plus pre-existing unrelated dirty files that should not be reverted.
