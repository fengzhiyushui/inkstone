import { createKernel } from "../../index.js";
import { createToolCall } from "../../core/protocol/index.js";
import { buildKernelOptions } from "../kernel-options.js";
import { createSensitiveNoticeHandler } from "../sensitive-notice-contract.js";
import { createEventRenderer, formatSensitiveNotice, renderKernelResult } from "./render-events.js";
import { createMcpInputResponder } from "../mcp-input-form.js";
import { createCliMcpInputPrompt } from "./mcp-input.js";

export { buildKernelOptions } from "../kernel-options.js";

export async function runKernelAgentCommand({
  root,
  prompt,
  autonomy = "gated",
  write = console.log,
  createKernelImpl = createKernel,
  createKernelOptions = {},
  loadConfigImpl = null,
  sendOptions = {},
  promptApproval = defaultPromptApproval,
  promptApprovalScope = null,
  askSensitive = defaultAskSensitive,
  promptMcpInput = null,
  onSigint = defaultOnSigint
} = {}) {
  const message = String(prompt || "").trim();
  if (!message) throw new Error("prompt is required");

  const kernel = await createKernelForRunner({ root, createKernelImpl, createKernelOptions, loadConfigImpl, write, askSensitive });
  const renderEvent = createEventRenderer({ write });
  const mcpInput = createMcpInputResponder({ kernel, write, prompt: promptMcpInput || createCliMcpInputPrompt({ kernel, write }) });
  const subscription = kernel.session.subscribe((event) => { mcpInput.handle(event); renderEvent(event); });
  void mcpInput.refresh();
  try {
    const result = await withTurnInterrupt({
      kernel,
      write,
      onSigint,
      run: () => kernel.agent.send(message, { autonomy, ...sendOptions })
    });
    return await resolveApprovals({
      kernel,
      result,
      write,
      promptApproval,
      promptApprovalScope: promptApprovalScope ?? (process.stdin?.isTTY ? promptApprovalScopeInteractive : null),
      onSigint
    });
  } finally {
    subscription.unsubscribe();
    await mcpInput.close();
  }
}

export async function runKernelChatCommand({
  root,
  prompt = "",
  write = console.log,
  question = defaultQuestion,
  createKernelImpl = createKernel,
  createKernelOptions = {},
  loadConfigImpl = null,
  sendOptions = {},
  promptApproval = defaultPromptApproval,
  promptApprovalScope = null,
  askSensitive = defaultAskSensitive,
  promptMcpInput = null,
  onSigint = defaultOnSigint
} = {}) {
  const kernel = await createKernelForRunner({ root, createKernelImpl, createKernelOptions, loadConfigImpl, write, askSensitive });
  const renderEvent = createEventRenderer({ write });
  const mcpInput = createMcpInputResponder({ kernel, write, prompt: promptMcpInput || createCliMcpInputPrompt({ kernel, write }) });
  const subscription = kernel.session.subscribe((event) => { mcpInput.handle(event); renderEvent(event); });
  void mcpInput.refresh();
  try {
    const initialPrompt = String(prompt || "").trim();
    if (initialPrompt) {
      const result = await withTurnInterrupt({
        kernel,
        write,
        onSigint,
        run: () => kernel.agent.send(initialPrompt, {
          ...sendOptions,
          autonomy: "read-only",
          history: []
        })
      });
      return await resolveApprovals({
        kernel,
        result,
        write,
        promptApproval,
        promptApprovalScope: promptApprovalScope ?? (process.stdin?.isTTY ? promptApprovalScopeInteractive : null),
        onSigint
      });
    }

    return await runChatRepl({
      kernel,
      write,
      question,
      sendOptions,
      promptApproval,
      promptApprovalScope,
      onSigint
    });
  } finally {
    subscription.unsubscribe();
    await mcpInput.close();
  }
}

export async function resolveApprovals({ kernel, result, write = console.log, promptApproval = defaultPromptApproval, promptApprovalScope = null, onSigint = defaultOnSigint } = {}) {
  let current = result;
  for (const line of renderKernelResult(withUsage(current, kernel))) write(line);
  while (current.status === "awaiting_approval" && current.approval?.id) {
    const answer = await promptApproval(current.approval);
    const decision = isApprovalYes(answer) ? "approve" : "deny";
    // v1.13.1:三级批准。**只有调用方显式提供 promptApprovalScope 时才追问范围** ——
    // 否则按"仅本次(session)"处理,避免给非交互调用方/既有测试引入阻塞。
    // destructive 工具同样不追问(validateApprovalScope 会在内核侧锁死持久化)。
    let scope = "session";
    if (decision === "approve" && current.approval?.category !== "destructive" && promptApprovalScope) {
      scope = await promptApprovalScope(current.approval);
    }
    current = await withTurnInterrupt({
      kernel,
      write,
      onSigint,
      run: () => kernel.agent.approve(current.approval.id, decision, { scope })
    });
    for (const line of renderKernelResult(withUsage(current, kernel))) write(line);
  }
  return current;
}

/**
 * v1.13.1:交互式批准范围追问(由 CLI 入口注入,非默认值)。
 * p = 本项目 / a = 永久 / 其它 = 仅本次。
 */
export async function promptApprovalScopeInteractive(approval) {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question("放行范围？[p] 本项目  [a] 永久  [其它] 仅本次 > ", resolve));
    const normalized = String(answer || "").trim().toLowerCase();
    if (normalized === "p") return "project";
    if (normalized === "a") return "always";
    return "session";
  } finally {
    rl.close();
  }
}

// v1.9 M4 #11:给终局渲染挂 usage 快照。agent.send/approve 的 result 不带 usage,
// 渲染层读不到就永远不出摘要行;遥测读取失败静默跳过(循 cli.js readFimUsage 兜底风格)。
function withUsage(current, kernel) {
  if (!kernel?.metrics?.getUsage) return current;
  try {
    return { ...current, usage: kernel.metrics.getUsage() };
  } catch {
    return current;
  }
}

async function runChatRepl({ kernel, write, question, sendOptions, promptApproval, promptApprovalScope, onSigint }) {
  let mode = "read-only";
  let history = [];
  write("chat mode: read-only");
  write("commands: /mode [read-only|gated|auto], /clear, /history, /recovery, /exit");

  while (true) {
    const input = String(await question(`chat(${mode})> `) || "").trim();
    if (!input) continue;

    if (input.startsWith("/")) {
      const commandResult = await handleChatCommand({ input, mode, history, kernel, write });
      mode = commandResult.mode;
      history = commandResult.history;
      if (commandResult.exit) {
        return { status: "complete", content: "chat exited" };
      }
      continue;
    }

    const result = await withTurnInterrupt({
      kernel,
      write,
      onSigint,
      run: () => kernel.agent.send(input, {
        ...sendOptions,
        autonomy: mode,
        history
      })
    });
    const resolved = await resolveApprovals({
      kernel,
      result,
      write,
      promptApproval,
      // v1.13.1:交互式会话才追问放行范围;非交互(stdin 非 TTY)时留空 → 仅本次
      promptApprovalScope: promptApprovalScope ?? (process.stdin?.isTTY ? promptApprovalScopeInteractive : null),
      onSigint
    });
    if (resolved.status === "complete") {
      history = appendHistory(history, input, resolved.content || "");
    }
  }
}

async function handleChatCommand({ input, mode, history, kernel, write }) {
  const trimmed = input.slice(1).trim();
  const firstSpace = trimmed.indexOf(" ");
  const command = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rawArg = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  if (command === "exit" || command === "quit") {
    return { mode, history, exit: true };
  }
  if (command === "mode") {
    const requested = rawArg ? String(rawArg).trim() : "";
    const nextMode = requested || nextChatMode(mode);
    if (!["read-only", "gated", "auto"].includes(nextMode)) {
      write("mode must be read-only, gated, or auto");
      return { mode, history, exit: false };
    }
    write(`mode: ${nextMode}`);
    return { mode: nextMode, history, exit: false };
  }
  if (command === "clear") {
    write("history cleared");
    return { mode, history: [], exit: false };
  }
  if (command === "history") {
    const timeline = await kernel.session.getTimeline?.({ count: 10000 }).catch?.(() => null);
    const eventCount = Array.isArray(timeline) ? timeline.length : (Array.isArray(timeline?.events) ? timeline.events.length : null);
    const turnCount = Math.floor(history.length / 2);
    write(eventCount == null ? `history turns: ${turnCount}` : `history turns: ${turnCount}, events: ${eventCount}`);
    return { mode, history, exit: false };
  }
  if (command === "recovery") {
    return handleRecoveryCommand({ rawArg, kernel, write, mode, history });
  }
  write(`unknown command: /${command}`);
  return { mode, history, exit: false };
}

async function handleRecoveryCommand({ rawArg, kernel, write, mode, history }) {
  const args = rawArg ? String(rawArg).trim().split(/\s+/) : [];
  const [action, id] = args;

  if (!action) {
    // No args: show report and list items
    const report = await kernel.recovery?.report?.() || { found: [], done: [], blocked: [], next: [] };
    const items = await kernel.recovery?.list?.() || [];

    write("Recovery Center:");
    write(`  Found: ${report.found.length}, Done: ${report.done.length}, Blocked: ${report.blocked.length}`);

    if (items.length === 0) {
      write("  No recovery items.");
    } else {
      write(`  Items (${items.length}):`);
      for (const item of items) {
        const actions = item.allowed_actions ? `[${item.allowed_actions.join(", ")}]` : "[]";
        write(`    - ${item.id} (${item.type}, ${item.status}) ${actions}`);
        write(`      ${item.summary || "no summary"}`);
      }
    }

    if (report.next && report.next.length > 0) {
      write("  Next actions:");
      for (const next of report.next) {
        write(`    ${next}`);
      }
    }

    return { mode, history, exit: false };
  }

  if (action === "resume") {
    if (!id) {
      write("usage: /recovery resume <id>");
      return { mode, history, exit: false };
    }
    try {
      const result = await kernel.recovery.resume(id, {});
      write(`Recovery resumed: ${id} (${result.status})`);
    } catch (error) {
      write(`Failed to resume ${id}: ${error.message}`);
    }
    return { mode, history, exit: false };
  }

  if (action === "cancel") {
    if (!id) {
      write("usage: /recovery cancel <id>");
      return { mode, history, exit: false };
    }
    try {
      const result = await kernel.recovery.cancel(id);
      write(`Recovery cancelled: ${id} (${result.status})`);
    } catch (error) {
      write(`Failed to cancel ${id}: ${error.message}`);
    }
    return { mode, history, exit: false };
  }

  if (action === "clear") {
    if (!id) {
      write("usage: /recovery clear <id>");
      return { mode, history, exit: false };
    }
    try {
      const result = await kernel.recovery.clear(id);
      write(`Recovery cleared: ${id} (${result.status})`);
    } catch (error) {
      write(`Failed to clear ${id}: ${error.message}`);
    }
    return { mode, history, exit: false };
  }

  write("usage: /recovery [resume|cancel|clear] <id>");
  return { mode, history, exit: false };
}

async function withTurnInterrupt({ kernel, write, onSigint, run }) {
  let requested = false;
  const unsubscribe = onSigint(() => {
    if (requested) return;
    requested = true;
    kernel.agent.interrupt?.();
    write("Interrupt requested for the current turn...");
  });
  try {
    return await run();
  } catch (error) {
    if (requested && isInterruptError(error)) {
      return { status: "interrupted", content: "Turn interrupted" };
    }
    throw error;
  } finally {
    unsubscribe?.();
  }
}

function isInterruptError(error) {
  return error?.code === "INTERRUPTED" || error?.name === "InterruptedError" || error?.name === "AbortError";
}

function defaultOnSigint(handler) {
  process.on("SIGINT", handler);
  return () => process.removeListener("SIGINT", handler);
}

function nextChatMode(mode) {
  if (mode === "read-only") return "gated";
  if (mode === "gated") return "auto";
  return "read-only";
}

function appendHistory(history, user, assistant) {
  return [
    ...history,
    { role: "user", content: user },
    { role: "assistant", content: assistant }
  ].slice(-20);
}

async function createKernelForRunner({ root, createKernelImpl = createKernel, createKernelOptions = {}, loadConfigImpl = null, write = console.log, askSensitive = defaultAskSensitive } = {}) {
  const kernelOptions = createKernelImpl === createKernel
    ? await buildKernelOptions(root, createKernelOptions, loadConfigImpl || undefined)
    : createKernelOptions;
  // #9.3:注入敏感文件提醒。策略(一律问、不缓存、不按档位放行)在共享契约里,
  // 这里只提供 CLI 的「怎么问」。已显式传入者优先(测试可注入)。
  const withNotice = kernelOptions?.onSensitiveNotice
    ? kernelOptions
    : { ...kernelOptions, onSensitiveNotice: createSensitiveNoticeHandler((descriptor) => askSensitive(descriptor, write)) };
  return createKernelImpl(root, withNotice);
}

async function defaultAskSensitive(descriptor, write = console.log) {
  for (const line of formatSensitiveNotice(descriptor)) write(line);
  const { createInterface } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return isApprovalYes(await rl.question("> "));
  } finally {
    rl.close();
  }
}

async function defaultQuestion(prompt) {
  const { createInterface } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function defaultPromptApproval(approval) {
  const { createInterface } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(`Approve ${approval.id}? y/N `);
  } finally {
    rl.close();
  }
}

function isApprovalYes(answer) {
  const value = String(answer || "").trim().toLowerCase();
  return value === "y" || value === "yes" || value === "approve" || value === "allow";
}

export async function runKernelTestCommand({
  root,
  argv = [],
  write = console.log,
  createKernelImpl = createKernel,
  createKernelOptions = {},
  loadConfigImpl = null
} = {}) {
  const kernelOptions = createKernelImpl === createKernel
    ? await buildKernelOptions(root, createKernelOptions, loadConfigImpl || undefined)
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
