# V2-5 Interface Migration Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Move CLI, TUI, and Electron GUI onto the V2 public kernel in `src/index.js` while keeping legacy commands available during migration.

**Architecture:** V2-5 treats every interface as a thin client of the V2 kernel. CLI gains a small kernel runner and event renderer; TUI subscribes to V2 session events and sends ask/edit through `kernel.agent.send()`; GUI main process loads `src/index.js` through a testable kernel host and the renderer adapts V2 events. No runtime business logic is added to UI code.

**Tech Stack:** Node.js >= 20, ESM for root source, CommonJS for Electron main/preload, vanilla browser JS for renderer, `node:test`, `node:assert/strict`, no new dependencies.

---

## Scope Boundary

Implement V2-5 from `docs/specs/architecture/2026-05-30-deepseek-code-v2-clean-runtime-design.md`:

- CLI `ask`, `edit`, and `test` use the V2 kernel.
- TUI ask/edit actions use the V2 kernel and V2 session event stream.
- GUI main process imports `src/index.js` instead of `src/kernel/kernel-api.js`.
- GUI renderer understands V2 events: `agent:final`, `agent:error`, `approval:requested`, `tool:call`, `tool:result`, `file:diff_applied`, and `verification:result`.
- Legacy commands stay available: `chat`, `search`, `scan`, `diff`, `config`, `changes`, `rollback`, and `resume`.
- No full directory move to root-level `apps/*` in this phase. New CLI helpers live under `src/apps/cli/` so `bin/deepseek-code.js` can keep using `src/cli.js`.

Out of scope for V2-5:

- Full approval resume after `approval_required`.
- Deleting `src/agent.js`, `src/chat.js`, or `src/kernel/*`.
- Moving `gui/` to `apps/gui/`.
- Rewriting all garbled legacy Chinese text.
- Introducing React, Ink, bundlers, or new dependencies.
- Persisted V2 session timeline. `kernel.session.getTimeline()` may still return an empty array until the sessions phase.

## Design Decisions

- **One public runtime entry:** All migrated interface code imports or dynamically loads `createKernel()` from `src/index.js`.
- **CLI safety behavior:** `ask` uses V2 with `autonomy:"gated"`. `edit` defaults to `autonomy:"supervised"` so it can stop at approval; `edit --yes` maps to `autonomy:"gated"` for the current V2 permission matrix. `edit --dry-run` appends a preview-only instruction to the prompt.
- **CLI test behavior:** `deepseek-code test` executes the V2 `test` tool directly through `kernel.tools.execute()` with `autonomy:"auto"`, because test is a command, not a model conversation. User-provided argv maps to `{ detect:false, argv }`; no argv maps to `{ detect:false }` so the detected test command runs.
- **TUI compatibility:** TUI keeps readline/raw-mode and the existing menu. Only ask/edit and telemetry are migrated. Legacy menu actions continue to use old helpers.
- **GUI security unchanged:** `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, CSP, IPC whitelist, and `textContent` rendering stay mandatory.
- **Renderer testability:** Add a small pure CommonJS browser-compatible `gui/renderer/event-adapter.js` so V2 event formatting can be tested without Electron or DOM libraries.
- **Kernel host testability:** Add `gui/kernel-host.js` as a CommonJS wrapper around dynamic ESM import and kernel IPC operations. `gui/main.js` becomes a thin Electron shell.

## File Structure

Create:

```text
src/apps/cli/render-events.js
src/apps/cli/kernel-runner.js
src/apps/kernel-options.js
tests/unit/apps/kernel-options.test.js
tests/unit/apps/cli/render-events.test.js
tests/unit/apps/cli/kernel-runner.test.js
tests/integration/v2-cli-kernel-runner.test.js
gui/kernel-host.js
gui/renderer/event-adapter.js
tests/unit/gui/kernel-host.test.js
tests/unit/gui/renderer-event-adapter.test.js
```

Modify:

```text
src/cli.js
src/tui.js
gui/main.js
gui/renderer/index.html
gui/renderer/app.js
package.json
```

Responsibility map:

- `src/apps/cli/render-events.js`: turn V2 session events and final results into concise CLI text.
- `src/apps/cli/kernel-runner.js`: create V2 kernel, subscribe to events, send agent turns, and execute the V2 `test` tool.
- `src/apps/kernel-options.js`: bridge legacy `.deepseek-code/config.json` into V2 `createKernel()` DeepSeek options for non-Electron app clients.
- `src/cli.js`: dispatch selected commands to the V2 runner while leaving compatibility commands untouched.
- `src/tui.js`: create V2 kernel, subscribe to `kernel.session`, and run ask/edit through `kernel.agent.send()`.
- `gui/kernel-host.js`: own dynamic import of V2 kernel, state/usage/config compatibility responses, and event fan-out.
- `gui/main.js`: register Electron IPC and delegate to `kernel-host`.
- `gui/renderer/event-adapter.js`: pure event icon/summary/status/approval helpers.
- `gui/renderer/app.js`: consume V2 events through the adapter and keep DOM updates XSS-safe.

---

### Task 1: CLI V2 Event Renderer

**Files:**
- Create: `src/apps/cli/render-events.js`
- Test: `tests/unit/apps/cli/render-events.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/apps/cli/render-events.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeKernelEvent,
  renderKernelResult,
  createEventRenderer
} from "../../../../src/apps/cli/render-events.js";

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
    ["", "Approval required: apr_1", "V2-5 CLI only displays approval requests. Approval resume is a later phase."]
  );
});

test("createEventRenderer writes only useful progress events", () => {
  const lines = [];
  const renderer = createEventRenderer({ write: (line) => lines.push(line) });

  renderer({ type: "user:message", content: "hi" });
  renderer({ type: "tool:result", result: { status: "success" } });
  renderer({ type: "model:request", purpose: "act" });

  assert.deepEqual(lines, ["- user hi", "- tool result success"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/apps/cli/render-events.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Implement `src/apps/cli/render-events.js`**

```js
// src/apps/cli/render-events.js
const QUIET_EVENTS = new Set(["model:request", "model:response", "agent:step", "agent:turn_started"]);

export function summarizeKernelEvent(event = {}) {
  if (event.type === "user:message") return `user ${clip(event.content || "")}`;
  if (event.type === "tool:call") return `tool ${event.call?.name || event.tool?.name || event.tool || "unknown"}`;
  if (event.type === "tool:result") return `tool result ${event.result?.status || event.status || "unknown"}`;
  if (event.type === "permission:decision") return `permission ${event.permission?.decision || event.decision || "unknown"}`;
  if (event.type === "approval:requested") return `approval ${event.approval?.id || "unknown"} ${clip(event.approval?.summary || "")}`.trim();
  if (event.type === "file:diff_preview") return `diff preview ${event.summary || event.diff_hash || ""}`.trim();
  if (event.type === "file:diff_applied") return `diff applied ${event.change_id || event.record?.id || ""}`.trim();
  if (event.type === "file:rollback_applied") return `rollback ${event.change_id || event.record?.id || ""}`.trim();
  if (event.type === "verification:result") return `verification ${event.result?.status || event.status || "unknown"}`;
  if (event.type === "agent:final") return `final ${clip(event.content || "")}`.trim();
  if (event.type === "agent:error") return `error ${clip(event.message || event.error || "")}`.trim();
  return event.type || "event";
}

export function renderKernelResult(result = {}) {
  if (result.status === "awaiting_approval") {
    return [
      "",
      `Approval required: ${result.approval?.id || "unknown"}`,
      "V2-5 CLI only displays approval requests. Approval resume is a later phase."
    ];
  }
  if (result.status === "error") {
    return ["", `Error: ${result.error || result.message || "unknown error"}`];
  }
  return ["", result.content || ""];
}

export function createEventRenderer({ write = console.log } = {}) {
  return function renderEvent(event) {
    if (!event?.type || QUIET_EVENTS.has(event.type)) return;
    write(`- ${summarizeKernelEvent(event)}`);
  };
}

function clip(value, max = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm.cmd test -- tests/unit/apps/cli/render-events.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 5: Commit**

```powershell
git add src/apps/cli/render-events.js tests/unit/apps/cli/render-events.test.js
git commit -m "feat(v2): add CLI kernel event renderer"
```

---

### Task 2: CLI Kernel Runner

**Files:**
- Create: `src/apps/cli/kernel-runner.js`
- Test: `tests/unit/apps/cli/kernel-runner.test.js`
- Test: `tests/integration/v2-cli-kernel-runner.test.js`

- [ ] **Step 1: Write the failing unit test**

```js
// tests/unit/apps/cli/kernel-runner.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  runKernelAgentCommand,
  runKernelTestCommand,
  buildEditPrompt
} from "../../../../src/apps/cli/kernel-runner.js";

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

```

- [ ] **Step 2: Write the failing kernel options test**

```js
// tests/unit/apps/kernel-options.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { buildKernelOptions } from "../../../src/apps/kernel-options.js";

test("buildKernelOptions bridges legacy config into V2 DeepSeek options", async () => {
  const options = await buildKernelOptions("/repo", {}, async () => ({
    apiKey: "sk-test",
    baseUrl: "https://example.invalid"
  }));

  assert.deepEqual(options, {
    deepseek: { apiKey: "sk-test", baseUrl: "https://example.invalid" }
  });
});

test("buildKernelOptions preserves explicit modelGateway and does not read config", async () => {
  const gateway = { reply: async () => ({ content: "ok" }) };
  const options = await buildKernelOptions("/repo", { modelGateway: gateway }, async () => {
    throw new Error("should not load config");
  });

  assert.equal(options.modelGateway, gateway);
});
```

- [ ] **Step 3: Write the failing integration test**

```js
// tests/integration/v2-cli-kernel-runner.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runKernelAgentCommand } from "../../src/apps/cli/kernel-runner.js";

test("CLI kernel runner can drive a V2 read tool loop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-runner-"));
  await writeFile(path.join(root, "README.md"), "hello cli runner");
  let invokeCount = 0;
  const lines = [];

  const result = await runKernelAgentCommand({
    root,
    prompt: "inspect README",
    write: (line) => lines.push(line),
    createKernelOptions: {
      sessionId: "sess_cli_runner",
      modelGateway: {
        invoke: async (messages) => {
          invokeCount++;
          if (invokeCount === 1) {
            return { content: "", tool_calls: [{ id: "call_read", name: "read", arguments: { path: "README.md" } }] };
          }
          assert.ok(messages.some((message) => message.role === "tool" && message.content.includes("hello cli runner")));
          return { content: "README inspected", tool_calls: [] };
        },
        reply: async () => ({ content: "fast" })
      }
    }
  });

  assert.equal(result.status, "complete");
  assert.equal(result.content, "README inspected");
  assert.equal(invokeCount, 2);
  assert.ok(lines.some((line) => line.includes("README inspected")));
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/unit/apps/kernel-options.test.js tests/unit/apps/cli/kernel-runner.test.js tests/integration/v2-cli-kernel-runner.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 5: Implement `src/apps/kernel-options.js`**

```js
// src/apps/kernel-options.js
import { loadConfig } from "../config.js";

export async function buildKernelOptions(root, overrides = {}, loadConfigImpl = loadConfig) {
  if (overrides.modelGateway || overrides.deepseek) return overrides;
  let config = {};
  try {
    config = await loadConfigImpl(root, { allowMissingKey: true });
  } catch {
    config = {};
  }
  if (!config.apiKey) return overrides;
  return {
    ...overrides,
    deepseek: {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl
    }
  };
}
```

- [ ] **Step 6: Implement `src/apps/cli/kernel-runner.js`**

```js
// src/apps/cli/kernel-runner.js
import { createKernel } from "../../index.js";
import { createToolCall } from "../../core/protocol/index.js";
import { buildKernelOptions } from "../kernel-options.js";
import { createEventRenderer, renderKernelResult } from "./render-events.js";

export { buildKernelOptions } from "../kernel-options.js";

export async function runKernelAgentCommand({
  root,
  prompt,
  autonomy = "gated",
  write = console.log,
  createKernelImpl = createKernel,
  createKernelOptions = {},
  loadConfigImpl = loadConfig,
  sendOptions = {}
} = {}) {
  const message = String(prompt || "").trim();
  if (!message) throw new Error("prompt is required");

  const kernelOptions = createKernelImpl === createKernel
    ? await buildKernelOptions(root, createKernelOptions, loadConfigImpl)
    : createKernelOptions;
  const kernel = await createKernelImpl(root, kernelOptions);
  const renderEvent = createEventRenderer({ write });
  const subscription = kernel.session.subscribe(renderEvent);
  try {
    const result = await kernel.agent.send(message, { autonomy, ...sendOptions });
    for (const line of renderKernelResult(result)) write(line);
    return result;
  } finally {
    subscription.unsubscribe();
  }
}

export async function runKernelTestCommand({
  root,
  argv = [],
  write = console.log,
  createKernelImpl = createKernel,
  createKernelOptions = {},
  loadConfigImpl = loadConfig
} = {}) {
  const kernelOptions = createKernelImpl === createKernel
    ? await buildKernelOptions(root, createKernelOptions, loadConfigImpl)
    : createKernelOptions;
  const kernel = await createKernelImpl(root, kernelOptions);
  const params = argv.length ? { detect: false, argv } : { detect: false };
  const result = await kernel.tools.execute(
    createToolCall({
      name: "test",
      params,
      source: "cli",
      requestedByStepId: "cli:test"
    }),
    { autonomy: "auto", turnId: "cli:test" }
  );

  for (const item of result.content || []) {
    if (item.text) write(item.text);
  }
  if (result.metadata?.argv) write(`command: ${result.metadata.argv.join(" ")}`);
  return result;
}

export function buildEditPrompt(prompt, { dryRun = false } = {}) {
  const text = String(prompt || "").trim();
  if (!dryRun) return text;
  return `${text}\n\nConstraint: preview the diff only. Use diff_preview and do not apply changes.`;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run:

```powershell
npm.cmd test -- tests/unit/apps/kernel-options.test.js tests/unit/apps/cli/render-events.test.js tests/unit/apps/cli/kernel-runner.test.js tests/integration/v2-cli-kernel-runner.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 8: Commit**

```powershell
git add src/apps/kernel-options.js src/apps/cli/kernel-runner.js tests/unit/apps/kernel-options.test.js tests/unit/apps/cli/kernel-runner.test.js tests/integration/v2-cli-kernel-runner.test.js
git commit -m "feat(v2): add CLI kernel runner"
```

---

### Task 3: Migrate CLI Ask/Edit/Test Dispatch

**Files:**
- Modify: `src/cli.js`
- Test: `tests/unit/apps/cli/kernel-runner.test.js`
- Test: `tests/integration/v2-cli-kernel-runner.test.js`

- [ ] **Step 1: Add the V2 runner import**

At the top of `src/cli.js`, add this import near the other local imports:

```js
import { buildEditPrompt, runKernelAgentCommand, runKernelTestCommand } from "./apps/cli/kernel-runner.js";
```

Keep the existing legacy imports for `chat`, `search`, `scan`, `changes`, `rollback`, `diff`, and `config`.

- [ ] **Step 2: Replace `runAsk()` with V2 kernel dispatch**

Replace the `runAsk` function body with:

```js
async function runAsk(root, args, flags) {
  const prompt = args.join(" ").trim();
  if (!prompt) {
    throw new Error("ask command requires a question.");
  }

  await runKernelAgentCommand({
    root,
    prompt,
    autonomy: stringFlag(flags, "autonomy") || "gated",
    sendOptions: commonOptions(flags)
  });
}
```

- [ ] **Step 3: Replace `runEdit()` with V2 kernel dispatch**

Replace the `runEdit` function body with:

```js
async function runEdit(root, args, flags) {
  const prompt = args.join(" ").trim();
  if (!prompt) {
    throw new Error("edit command requires an edit request.");
  }

  const dryRun = boolFlag(flags, "dry-run");
  const yes = boolFlag(flags, "yes");
  const files = arrayFlag(flags, "file");
  const fileHint = files.length ? `\n\nRelevant files: ${files.join(", ")}` : "";

  await runKernelAgentCommand({
    root,
    prompt: buildEditPrompt(`${prompt}${fileHint}`, { dryRun }),
    autonomy: yes ? "gated" : "supervised",
    sendOptions: commonOptions(flags)
  });
}
```

- [ ] **Step 4: Replace `runTest()` with V2 test tool dispatch**

Replace the `runTest` function body with:

```js
async function runTest(root, args) {
  const result = await runKernelTestCommand({ root, argv: args });
  if (result.status === "error" || result.status === "denied") {
    process.exitCode = 1;
  }
}
```

Leave the old `detectTestCommand()` function in place for now. It is unused after this step, but removing legacy helpers is V2-6 cleanup.

- [ ] **Step 5: Run targeted syntax and runner tests**

Run:

```powershell
node --check src/cli.js src/apps/kernel-options.js src/apps/cli/render-events.js src/apps/cli/kernel-runner.js
npm.cmd test -- tests/unit/apps/kernel-options.test.js tests/unit/apps/cli/render-events.test.js tests/unit/apps/cli/kernel-runner.test.js tests/integration/v2-cli-kernel-runner.test.js
```

Expected:

```text
node --check exits 0
# fail 0
```

- [ ] **Step 6: Manually smoke-test CLI ask with mock gateway through direct runner**

Run:

```powershell
node --input-type=module -e "import { runKernelAgentCommand } from './src/apps/cli/kernel-runner.js'; let n=0; const result=await runKernelAgentCommand({root:process.cwd(), prompt:'hello?', write:(line)=>console.log(line), createKernelOptions:{sessionId:'sess_cli_smoke', modelGateway:{reply:async()=>({content:'hello from v2'}), invoke:async()=>{n++; return {content:'unused', tool_calls:[]};}}}}); console.log(JSON.stringify({status:result.status, content:result.content, invokes:n}));"
```

Expected output includes:

```text
hello from v2
"status":"complete"
"invokes":0
```

- [ ] **Step 7: Commit**

```powershell
git add src/cli.js
git commit -m "feat(v2): migrate CLI ask edit test to kernel"
```

---

### Task 4: TUI V2 Wiring

**Files:**
- Modify: `src/tui.js`
- Uses: `src/apps/kernel-options.js`
- Test: `tests/unit/apps/cli/render-events.test.js`

- [ ] **Step 1: Change the kernel import**

Replace the old V1 kernel import:

```js
import { createKernel } from "./kernel/kernel-api.js";
```

with:

```js
import { createKernel } from "./index.js";
```

Add the shared kernel options bridge import:

```js
import { buildKernelOptions } from "./apps/kernel-options.js";
```

- [ ] **Step 2: Use legacy config bridge when TUI creates its own kernel**

In `runTui()`, replace the current own-kernel creation call:

```js
      kernel = await createKernel(root, { config: { allowMissingKey: true } });
```

with:

```js
      kernel = await createKernel(root, await buildKernelOptions(root));
```

- [ ] **Step 3: Replace status state lookup with V2 runtime lookup**

Replace `renderStatusLine(kernel)` with:

```js
function renderStatusLine(kernel) {
  if (!kernel) return "";

  const state = kernel.runtime?.getState?.() || { current: "idle", channel: null };
  const publicConfig = kernel.config?.getPublicConfig?.() || {};
  const parts = [
    color.dim("|"),
    ` ${state.current || "idle"} `,
    color.dim("|"),
    ` ${state.channel || "-"} `,
    color.dim("|"),
    ` ${publicConfig.runtime || "v2"} `
  ];

  return parts.join("");
}
```

- [ ] **Step 4: Replace the V1 event subscription with V2 session subscription**

In `runTui()`, replace the `orchestratorSub` block with:

```js
  let sessionSub = null;
  if (kernel) {
    sessionSub = kernel.session.subscribe((event) => {
      recordTimelineEvent(event.type, summarizeTuiEvent(event));
    });
  }
```

Replace the cleanup line:

```js
    if (orchestratorSub) orchestratorSub.unsubscribe();
```

with:

```js
    if (sessionSub) sessionSub.unsubscribe();
```

Add this helper near the timeline helpers:

```js
function summarizeTuiEvent(event = {}) {
  if (event.type === "user:message") return `input: ${(event.content || "").slice(0, 50)}`;
  if (event.type === "tool:call") return `tool: ${event.call?.name || event.tool || "unknown"}`;
  if (event.type === "tool:result") return `tool result: ${event.result?.status || "unknown"}`;
  if (event.type === "approval:requested") return `approval: ${event.approval?.summary || event.approval?.id || ""}`;
  if (event.type === "file:diff_applied") return `diff applied: ${event.change_id || event.record?.id || ""}`;
  if (event.type === "verification:result") return `verification: ${event.result?.status || event.status || "unknown"}`;
  if (event.type === "agent:final") return `complete: ${(event.content || "").slice(0, 50)}`;
  if (event.type === "agent:error") return `Error: ${event.message || event.error || ""}`;
  return event.type || "event";
}
```

- [ ] **Step 5: Update timeline icons for V2 events**

In `renderTimeline()`, replace the `icon` map with:

```js
    const icon = {
      "user:message": "U",
      "tool:call": "T",
      "tool:result": "R",
      "permission:decision": "P",
      "approval:requested": "A",
      "file:diff_applied": "D",
      "verification:result": "V",
      "agent:final": "F",
      "agent:error": "E"
    }[e.type] || "-";
```

Use ASCII letters here to avoid adding more mojibake while the legacy file still contains garbled text.

- [ ] **Step 6: Add a V2 agent helper for ask/edit actions**

Add this helper near `runAction()`:

```js
async function sendKernelPrompt(kernel, prompt, options = {}) {
  if (!kernel) {
    throw new Error("V2 kernel is not available.");
  }
  const result = await kernel.agent.send(prompt, options);
  if (result.status === "awaiting_approval") {
    return `Approval required: ${result.approval?.id || "unknown"}\nV2-5 TUI only displays approval requests. Approval resume is a later phase.`;
  }
  return result.content || "";
}
```

- [ ] **Step 7: Migrate TUI ask action**

Inside `runAction()`, replace the `askCommand()` call in the `action.id === "ask"` branch with:

```js
      const answer = await withCookedInput(() => sendKernelPrompt(kernel, prompt, { autonomy: "gated" }));
```

Keep the surrounding prompt, output, and state message behavior unchanged.

- [ ] **Step 8: Migrate TUI edit action**

Inside the `action.id === "edit"` branch, replace the `editCommand()` call with:

```js
      const fileHint = splitFiles(files).length ? `\n\nRelevant files: ${splitFiles(files).join(", ")}` : "";
      const answer = await withCookedInput(() => sendKernelPrompt(kernel, `${prompt}${fileHint}`, { autonomy: "supervised" }));
```

Keep legacy search/scan/test/diff/changes/rollback/config actions unchanged.

- [ ] **Step 9: Run syntax check**

Run:

```powershell
node --check src/tui.js src/apps/kernel-options.js
```

Expected:

```text
Exit code 0.
```

- [ ] **Step 10: Commit**

```powershell
git add src/tui.js
git commit -m "feat(v2): wire TUI ask edit to kernel"
```

---

### Task 5: GUI V2 Kernel Host

**Files:**
- Create: `gui/kernel-host.js`
- Modify: `gui/main.js`
- Test: `tests/unit/gui/kernel-host.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/gui/kernel-host.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createKernelHost, resolveProjectRoot, zeroUsage, buildKernelOptions } = require("../../../gui/kernel-host.js");

test("resolveProjectRoot reads --project argument", () => {
  assert.equal(resolveProjectRoot(["electron", ".", "--project=C:\\repo"], "fallback"), "C:\\repo");
  assert.equal(resolveProjectRoot(["electron", "."], "fallback"), "fallback");
});

test("kernel host delegates send and pushes final event", async () => {
  const pushed = [];
  const host = createKernelHost({
    projectRoot: "/repo",
    pushEvent: (event) => pushed.push(event),
    kernelFactory: async () => ({
      session: {
        subscribe(handler) {
          handler({ type: "agent:final", content: "done" });
          return { unsubscribe() {} };
        },
        getTimeline: async () => [{ type: "agent:final" }]
      },
      agent: {
        send: async (message, opts) => ({ status: "complete", content: `${message}:${opts.autonomy}` }),
        approve: () => {},
        interrupt: () => {}
      },
      context: { snapshot: async () => ({ units: [] }) },
      config: { getPublicConfig: () => ({ runtime: "v2", has_api_key: false }) },
      runtime: { getState: () => ({ current: "idle", channel: null }) }
    })
  });

  await host.init();
  const response = await host.send("hello", { autonomy: "gated" });

  assert.deepEqual(response, { ok: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(pushed.some((event) => event.type === "agent:final"));
  assert.ok(pushed.some((event) => event.type === "agent:result" && event.result.content === "hello:gated"));
});

test("kernel host exposes safe default state and usage", async () => {
  const host = createKernelHost({
    projectRoot: "/repo",
    kernelFactory: async () => ({
      session: { subscribe: () => ({ unsubscribe() {} }), getTimeline: async () => [] },
      agent: { send: async () => ({ status: "complete" }), approve: () => {}, interrupt: () => {} },
      context: { snapshot: async () => ({ units: [] }) },
      config: { getPublicConfig: () => ({ runtime: "v2" }) },
      runtime: { getState: () => ({ current: "idle", channel: null }) }
    })
  });

  await host.init();
  assert.deepEqual(host.getUsage(), zeroUsage());
  assert.deepEqual(host.getState(), { current: "idle", channel: null });
  assert.deepEqual(host.getConfig(), { runtime: "v2" });
});

test("buildKernelOptions bridges legacy config into V2 DeepSeek options", async () => {
  const options = await buildKernelOptions("/repo", {}, async () => ({
    apiKey: "sk-gui",
    baseUrl: "https://example.invalid"
  }));

  assert.deepEqual(options, {
    deepseek: { apiKey: "sk-gui", baseUrl: "https://example.invalid" }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/gui/kernel-host.test.js
```

Expected:

```text
MODULE_NOT_FOUND
```

- [ ] **Step 3: Implement `gui/kernel-host.js`**

```js
// gui/kernel-host.js
const path = require("path");
const { pathToFileURL } = require("url");

function resolveProjectRoot(argv = process.argv, fallback = path.resolve(__dirname, "..")) {
  const projectArg = argv.find((arg) => arg.startsWith("--project="));
  return projectArg ? projectArg.slice("--project=".length) : fallback;
}

function zeroUsage() {
  return {
    requests: 0,
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    total_reasoning_tokens: 0,
    total_tokens: 0,
    cache_hit_tokens: 0,
    cache_miss_tokens: 0,
    cache_hit_rate: 0,
    avg_latency_ms: 0,
    by_channel: {},
    by_model: {}
  };
}

async function loadLegacyConfig(projectRoot) {
  const configPath = path.join(__dirname, "..", "src", "config.js");
  const mod = await import(pathToFileURL(configPath).href);
  return mod.loadConfig(projectRoot, { allowMissingKey: true });
}

async function buildKernelOptions(projectRoot, overrides = {}, configLoader = loadLegacyConfig) {
  if (overrides.modelGateway || overrides.deepseek) return overrides;
  let config = {};
  try {
    config = await configLoader(projectRoot);
  } catch {
    config = {};
  }
  if (!config.apiKey) return overrides;
  return {
    ...overrides,
    deepseek: {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl
    }
  };
}

function createKernelHost({
  projectRoot = resolveProjectRoot(),
  kernelFactory = null,
  kernelOptions = {},
  configLoader = loadLegacyConfig,
  pushEvent = () => {}
} = {}) {
  let kernel = null;
  let subscription = null;

  async function init() {
    if (!kernelFactory) {
      const kernelPath = path.join(__dirname, "..", "src", "index.js");
      const mod = await import(pathToFileURL(kernelPath).href);
      kernelFactory = mod.createKernel;
    }
    const options = await buildKernelOptions(projectRoot, kernelOptions, configLoader);
    kernel = await kernelFactory(projectRoot, options);
    subscription = kernel.session.subscribe((event) => pushEvent(event));
    return kernel;
  }

  function ready() {
    return Boolean(kernel);
  }

  function requireKernel() {
    if (!kernel) throw new Error("Kernel not ready");
    return kernel;
  }

  async function send(message, opts = {}) {
    const k = requireKernel();
    k.agent.send(message, opts).then((result) => {
      pushEvent({ type: "agent:result", result: result || { status: "complete" } });
    }).catch((error) => {
      pushEvent({ type: "agent:error", error: error.message });
    });
    return { ok: true };
  }

  function approve(id, decision) {
    requireKernel().agent.approve(id, decision);
    return { ok: true };
  }

  function interrupt() {
    requireKernel().agent.interrupt();
    return { ok: true };
  }

  async function getTimeline(count = 20) {
    return ready() ? requireKernel().session.getTimeline(count) : [];
  }

  async function getSnapshot() {
    return ready() ? requireKernel().context.snapshot() : { units: [] };
  }

  function getUsage() {
    return kernel?.modelGateway?.getUsageStats?.() || kernel?.metrics?.getUsage?.() || zeroUsage();
  }

  function getConfig() {
    return ready() ? requireKernel().config.getPublicConfig() : {};
  }

  function getState() {
    return ready() ? requireKernel().runtime.getState() : { current: "idle", channel: null };
  }

  function dispose() {
    subscription?.unsubscribe?.();
    subscription = null;
  }

  return { init, ready, send, approve, interrupt, getTimeline, getSnapshot, getUsage, getConfig, getState, dispose };
}

module.exports = { createKernelHost, resolveProjectRoot, zeroUsage, buildKernelOptions };
```

- [ ] **Step 4: Update `gui/main.js` to use the host**

Replace the file with:

```js
// gui/main.js - Electron main process
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { createKernelHost, resolveProjectRoot } = require("./kernel-host.js");

let host = null;
let ipcRegistered = false;

const IPC_CHANNELS = [
  "agent:send", "agent:approve", "agent:interrupt",
  "session:timeline", "context:snapshot", "model:usage",
  "config:get", "orchestrator:state"
];

async function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 400,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    },
    title: "DeepSeek Code"
  });

  host = createKernelHost({
    projectRoot: resolveProjectRoot(process.argv, path.resolve(__dirname, "..")),
    pushEvent: (event) => {
      if (win && !win.isDestroyed()) win.webContents.send("kernel:event", event);
    }
  });

  try {
    await host.init();
  } catch (error) {
    console.error("Kernel init failed:", error.message);
  }

  registerIpcHandlers();
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return win;
}

function registerIpcHandlers() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle("agent:send", async (_event, message, opts) => {
    try { return await host.send(message, opts || {}); }
    catch (error) { return { error: error.message }; }
  });
  ipcMain.handle("agent:approve", (_event, id, decision) => {
    try { return host.approve(id, decision); }
    catch (error) { return { error: error.message }; }
  });
  ipcMain.handle("agent:interrupt", () => {
    try { return host.interrupt(); }
    catch (error) { return { error: error.message }; }
  });
  ipcMain.handle("session:timeline", async (_event, count) => host?.getTimeline(count || 20) || []);
  ipcMain.handle("context:snapshot", async () => host?.getSnapshot() || { units: [] });
  ipcMain.handle("model:usage", () => host?.getUsage() || {});
  ipcMain.handle("config:get", () => host?.getConfig() || {});
  ipcMain.handle("orchestrator:state", () => host?.getState() || { current: "idle", channel: null });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  host?.dispose?.();
  app.quit();
});
```

Keep `IPC_CHANNELS` as an explicit whitelist marker even though handlers are registered manually.

- [ ] **Step 5: Run tests and syntax check**

Run:

```powershell
npm.cmd test -- tests/unit/gui/kernel-host.test.js
node --check gui/kernel-host.js gui/main.js
```

Expected:

```text
# fail 0
node --check exits 0
```

- [ ] **Step 6: Commit**

```powershell
git add gui/kernel-host.js gui/main.js tests/unit/gui/kernel-host.test.js
git commit -m "feat(v2): host GUI on V2 kernel"
```

---

### Task 6: GUI Renderer V2 Event Adapter

**Files:**
- Create: `gui/renderer/event-adapter.js`
- Modify: `gui/renderer/index.html`
- Modify: `gui/renderer/app.js`
- Test: `tests/unit/gui/renderer-event-adapter.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/gui/renderer-event-adapter.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const adapter = require("../../../gui/renderer/event-adapter.js");

test("renderer adapter summarizes V2 events", () => {
  assert.equal(adapter.eventIcon("agent:final"), "F");
  assert.equal(adapter.eventIcon("approval:requested"), "A");
  assert.equal(adapter.summarizeEvent({ type: "tool:call", call: { name: "read" } }), "tool read");
  assert.equal(adapter.summarizeEvent({ type: "verification:result", result: { status: "passed" } }), "verification passed");
  assert.equal(adapter.summarizeEvent({ type: "agent:result", result: { status: "complete" } }), "complete");
});

test("renderer adapter extracts approval ids from V2 approval events", () => {
  const approval = adapter.getApproval({ type: "approval:requested", approval: { id: "apr_1", summary: "edit requires approval" } });

  assert.deepEqual(approval, { id: "apr_1", summary: "edit requires approval" });
  assert.equal(adapter.getApproval({ type: "agent:final" }), null);
});

test("renderer adapter derives status bar state from V2 events", () => {
  assert.deepEqual(
    adapter.statusFromEvent({ type: "model:request", purpose: "act" }),
    { channel: "act" }
  );
  assert.deepEqual(
    adapter.statusFromEvent({ type: "agent:final" }),
    { channel: "idle" }
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-event-adapter.test.js
```

Expected:

```text
MODULE_NOT_FOUND
```

- [ ] **Step 3: Implement `gui/renderer/event-adapter.js`**

```js
// gui/renderer/event-adapter.js
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DeepSeekEventAdapter = factory();
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function eventIcon(type) {
    var icons = {
      "user:message": "U",
      "agent:turn_started": "S",
      "model:request": "M",
      "model:response": "M",
      "tool:call": "T",
      "tool:result": "R",
      "permission:decision": "P",
      "approval:requested": "A",
      "approval:resolved": "A",
      "file:diff_preview": "D",
      "file:diff_applied": "D",
      "file:rollback_applied": "B",
      "verification:result": "V",
      "agent:final": "F",
      "agent:result": "F",
      "agent:error": "E"
    };
    return icons[type] || "-";
  }

  function summarizeEvent(event) {
    if (!event) return "";
    if (event.type === "user:message") return clip(event.content || "");
    if (event.type === "tool:call") return "tool " + (event.call?.name || event.tool || "unknown");
    if (event.type === "tool:result") return "tool result " + (event.result?.status || event.status || "unknown");
    if (event.type === "permission:decision") return "permission " + (event.permission?.decision || event.decision || "unknown");
    if (event.type === "approval:requested") return "approval " + (event.approval?.summary || event.approval?.id || "");
    if (event.type === "file:diff_preview") return "diff preview";
    if (event.type === "file:diff_applied") return "diff applied " + (event.change_id || event.record?.id || "");
    if (event.type === "file:rollback_applied") return "rollback " + (event.change_id || event.record?.id || "");
    if (event.type === "verification:result") return "verification " + (event.result?.status || event.status || "unknown");
    if (event.type === "agent:final") return clip(event.content || "complete");
    if (event.type === "agent:result") return event.result?.status || "complete";
    if (event.type === "agent:error") return "error " + (event.error || event.message || "");
    return event.type || "event";
  }

  function getApproval(event) {
    if (event?.type !== "approval:requested" || !event.approval) return null;
    return {
      id: event.approval.id || "approval",
      summary: event.approval.summary || "Approval required"
    };
  }

  function statusFromEvent(event) {
    if (!event) return {};
    if (event.type === "model:request") return { channel: event.purpose || "model" };
    if (event.type === "tool:call") return { channel: "tool" };
    if (event.type === "verification:result") return { channel: "verify" };
    if (event.type === "agent:final" || event.type === "agent:result") return { channel: "idle" };
    if (event.type === "agent:error") return { channel: "error" };
    return {};
  }

  function clip(value, max) {
    var limit = max || 80;
    var text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > limit ? text.slice(0, limit - 3) + "..." : text;
  }

  return { eventIcon: eventIcon, summarizeEvent: summarizeEvent, getApproval: getApproval, statusFromEvent: statusFromEvent };
}));
```

- [ ] **Step 4: Load adapter before `app.js`**

In `gui/renderer/index.html`, replace the script line:

```html
  <script src="app.js"></script>
```

with:

```html
  <script src="event-adapter.js"></script>
  <script src="app.js"></script>
```

- [ ] **Step 5: Update `gui/renderer/app.js` to use V2 event adapter**

At the top of the IIFE, after `var api = window.deepseek;`, add:

```js
  var adapter = window.DeepSeekEventAdapter;
```

Replace `updateStatusBar(event)` with:

```js
  function updateStatusBar(event) {
    var status = adapter.statusFromEvent(event);
    if (status.channel) setText("status-channel", status.channel);
  }
```

Replace `eventIcon(type)` with:

```js
  function eventIcon(type) {
    return adapter.eventIcon(type);
  }
```

Replace `summarizeEvent(e)` with:

```js
  function summarizeEvent(e) {
    return adapter.summarizeEvent(e);
  }
```

Replace `checkApprovalState(event)` with:

```js
  function checkApprovalState(event) {
    var approval = adapter.getApproval(event);
    if (approval) showApprovalBox(approval);
  }
```

Replace `showApprovalBox(event)` with:

```js
  function showApprovalBox(approval) {
    showLayer("surface");
    var box = document.getElementById("approval-box");
    box.className = "";
    clearChildren(box);

    var card = document.createElement("div");
    card.className = "approval-card";

    var title = document.createElement("div");
    title.className = "approval-title";
    title.textContent = "Approval required";
    card.appendChild(title);

    var typeDiv = document.createElement("div");
    typeDiv.className = "approval-type";
    typeDiv.textContent = approval.summary || approval.id;
    card.appendChild(typeDiv);

    var actions = document.createElement("div");
    actions.className = "approval-actions";

    var btnApprove = document.createElement("button");
    btnApprove.textContent = "Allow";
    btnApprove.onclick = function () {
      api.approve(approval.id, "allow");
      box.className = "hidden";
      clearChildren(box);
    };
    actions.appendChild(btnApprove);

    var btnDeny = document.createElement("button");
    btnDeny.textContent = "Deny";
    btnDeny.onclick = function () {
      api.approve(approval.id, "deny");
      box.className = "hidden";
      clearChildren(box);
    };
    actions.appendChild(btnDeny);

    card.appendChild(actions);
    box.appendChild(card);
  }
```

In the kernel event handler, replace the `agent:result` block with:

```js
    if (event.type === "agent:final") {
      addMessage("assistant", event.content || "Done.");
      showLayer("surface");
    }
    if (event.type === "agent:result") {
      addMessage("assistant", event.result?.content || "Done.");
      showLayer("surface");
    }
```

Keep the existing `agent:error` block, but it must read both `event.error` and `event.message`.

- [ ] **Step 6: Run tests and syntax check**

Run:

```powershell
npm.cmd test -- tests/unit/gui/renderer-event-adapter.test.js
node --check gui/renderer/event-adapter.js gui/renderer/app.js
```

Expected:

```text
# fail 0
node --check exits 0
```

- [ ] **Step 7: Commit**

```powershell
git add gui/renderer/event-adapter.js gui/renderer/index.html gui/renderer/app.js tests/unit/gui/renderer-event-adapter.test.js
git commit -m "feat(v2): adapt GUI renderer to V2 events"
```

---

### Task 7: Package Check and Full Regression

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update `package.json` check script**

Append the new source files to the `check` script:

```text
src/apps/kernel-options.js src/apps/cli/render-events.js src/apps/cli/kernel-runner.js gui/kernel-host.js gui/renderer/event-adapter.js
```

Keep the existing command style as a chained `node --check` command.

- [ ] **Step 2: Run targeted V2-5 tests**

Run:

```powershell
npm.cmd test -- tests/unit/apps/kernel-options.test.js tests/unit/apps/cli/render-events.test.js tests/unit/apps/cli/kernel-runner.test.js tests/integration/v2-cli-kernel-runner.test.js tests/unit/gui/kernel-host.test.js tests/unit/gui/renderer-event-adapter.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 3: Run full regression**

Run:

```powershell
npm.cmd test
```

Expected:

```text
# fail 0
```

The test count must be greater than 284 because V2-5 adds CLI and GUI migration tests.

- [ ] **Step 4: Run syntax check**

Run:

```powershell
npm.cmd run check
```

Expected:

```text
No SyntaxError output and exit code 0.
```

- [ ] **Step 5: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected:

```text
Exit code 0.
```

- [ ] **Step 6: Commit**

```powershell
git add package.json
git commit -m "chore(v2): include interface migration checks"
```

---

## Acceptance Criteria

V2-5 is complete only when all items are true:

- `src/cli.js` uses `runKernelAgentCommand()` for `ask`.
- `src/cli.js` uses `runKernelAgentCommand()` for `edit`.
- `src/cli.js` uses `runKernelTestCommand()` for `test`.
- `chat`, `search`, `scan`, `diff`, `config`, `changes`, `rollback`, and `resume` remain available.
- `src/tui.js` imports `createKernel` from `src/index.js`.
- TUI ask/edit actions call `kernel.agent.send()`.
- TUI timeline records V2 session events through `kernel.session.subscribe()`.
- `gui/main.js` no longer imports `src/kernel/kernel-api.js`.
- `gui/kernel-host.js` dynamically imports `src/index.js`.
- GUI IPC handlers delegate to the V2 kernel host.
- GUI renderer handles `agent:final` and `agent:result`.
- GUI renderer displays `approval:requested` with the real approval id.
- GUI renderer keeps XSS-safe `textContent` rendering and does not use `innerHTML`.
- No DeepSeek `reasoning_content` is displayed in CLI, TUI, GUI, or IPC events.
- No new dependencies are added.
- `npm.cmd test` passes.
- `npm.cmd run check` passes.
- `git diff --check` passes.

## Review Checklist

Before reporting completion:

- Inspect `src/cli.js` and confirm migrated commands import only `src/apps/cli/kernel-runner.js`, not V1 kernel modules.
- Inspect `src/tui.js` and confirm the only kernel import is `./index.js`.
- Inspect `gui/main.js` and confirm the old dynamic import path `src/kernel/kernel-api.js` is gone.
- Inspect `gui/kernel-host.js` and confirm it imports `src/index.js` with `pathToFileURL()`.
- Inspect `gui/renderer/app.js` and confirm no `innerHTML` writes were introduced.
- Inspect GUI approval handling and confirm the real `approval.id` is passed to `api.approve()`.
- Inspect CLI edit behavior and confirm default autonomy is `supervised` while `--yes` maps to `gated`.
- Search for reasoning exposure:

```powershell
rg "reasoning_content" src gui
```

Expected: no UI rendering path references it.

## Manual Smoke Tests

After full regression passes, run these smoke tests:

```powershell
node --input-type=module -e "import { runKernelAgentCommand } from './src/apps/cli/kernel-runner.js'; const r=await runKernelAgentCommand({root:process.cwd(), prompt:'what is this?', createKernelOptions:{sessionId:'sess_v25_smoke', modelGateway:{reply:async()=>({content:'v2 cli ok'}), invoke:async()=>({content:'unused', tool_calls:[]})}}}); console.log(JSON.stringify({status:r.status, content:r.content}));"
```

Expected output includes:

```text
v2 cli ok
"status":"complete"
```

```powershell
node --check src/apps/kernel-options.js src/cli.js src/tui.js gui/main.js gui/kernel-host.js gui/renderer/app.js gui/renderer/event-adapter.js
```

Expected:

```text
Exit code 0.
```

## Commit Order

Use this order:

1. `feat(v2): add CLI kernel event renderer`
2. `feat(v2): add CLI kernel runner`
3. `feat(v2): migrate CLI ask edit test to kernel`
4. `feat(v2): wire TUI ask edit to kernel`
5. `feat(v2): host GUI on V2 kernel`
6. `feat(v2): adapt GUI renderer to V2 events`
7. `chore(v2): include interface migration checks`

## Handoff Notes

- Use `npm.cmd` on Windows PowerShell.
- Keep unrelated dirty files untouched.
- Do not move `gui/` to `apps/gui/` in V2-5.
- Do not delete old V0/V1 implementation files in V2-5.
- Do not add dependencies.
- Do not implement approval resume in V2-5.
- If GUI usage stats are unavailable, return zero usage rather than reaching into old V1 internals.
- Preserve Electron sandbox settings and CSP.
- Keep renderer DOM updates through `textContent` and `createElement`.
