# DeepSeek Code v2 Clean Runtime Design

> Status: design approved for spec draft  
> Date: 2026-05-30  
> Scope: full project architecture, file layout, module boundaries, DeepSeek-native agent runtime

## 1. Purpose

DeepSeek Code v2 is a clean-room redesign of the current project into a DeepSeek-native local coding agent, comparable in product intent to Claude Code and Codex while staying optimized for DeepSeek's API behavior, long context, prefix cache, thinking mode, tool calls, and FIM.

The current project has valuable assets but an inconsistent execution path:

- The legacy CLI path can really edit files through unified diff, preview, snapshot, apply, and rollback.
- The v1 kernel has tested modules for events, sessions, permissions, context, tools, model routing, and GUI integration.
- The v1 kernel runtime is not yet a real agent loop: tool execution, permission checks, diff application, verification, and repair are not wired into `task-orchestrator`.
- CLI, TUI, and GUI do not share one execution backbone.

v2 fixes this by creating one runtime spine and making every interface a client of that runtime.

## 2. Design Goals

1. Make DeepSeek Code a real local coding agent: read, search, edit, test, verify, repair, and explain.
2. Use DeepSeek as a first-class target rather than a generic OpenAI-compatible wrapper.
3. Replace parallel v0/v1 flows with one kernel runtime used by CLI, TUI, and GUI.
4. Preserve proven local assets, especially unified diff parsing/application and rollback.
5. Make the project layout obvious, maintainable, and compliant with long-term product engineering norms.
6. Keep security boundaries explicit: workspace isolation, approvals, permissions, secret redaction, safe shell, SSRF protection, and auditable logs.
7. Build tests around real end-to-end behavior, not only isolated module expectations.

## 3. Non-Goals

- Do not keep two active agent implementations.
- Do not make Electron, TUI, or CLI own agent business logic.
- Do not expose DeepSeek reasoning content to normal user-facing logs.
- Do not introduce a complex package monorepo unless the project later needs independent package publishing.
- Do not discard mature diff and rollback logic merely because this is a clean-room runtime.

## 4. External Reference Principles

The design borrows architectural ideas from CodeWhale, DeepSeek-Reasonix, Claude Code, and Codex-style agents, but adapts them to this project:

- Streaming turn loop with durable state.
- Tool registry, approval gate, sandbox, and auditable tool results.
- Verifier gate after edits.
- Repair loop after failed tests or malformed model output.
- Stable prompt prefix and cache-aware context assembly for DeepSeek.
- Flash-first execution with Pro escalation.
- Structured tool-call repair for model instability.
- CLI/TUI/GUI as clients of one runtime.

DeepSeek-specific API references:

- Chat Completion and model parameters: https://api-docs.deepseek.com/api/create-chat-completion
- Tool Calls: https://api-docs.deepseek.com/guides/tool_calls
- JSON Output: https://api-docs.deepseek.com/zh-cn/guides/json_mode/
- Context Caching: https://api-docs.deepseek.com/guides/kv_cache
- FIM Completion: https://api-docs.deepseek.com/guides/fim_completion

## 5. Top-Level Project Layout

The project becomes a modular single repository. It is not a multi-package monorepo in v2, but the layout separates apps, core runtime, domain services, tests, scripts, and docs.

```text
deepseek-code/
+-- bin/
|   `-- deepseek-code.js
+-- apps/
|   +-- cli/
|   +-- tui/
|   `-- gui/
+-- src/
|   +-- core/
|   +-- deepseek/
|   +-- context/
|   +-- workspace/
|   +-- tools/
|   +-- edits/
|   +-- sessions/
|   +-- config/
|   +-- security/
|   +-- observability/
|   +-- shared/
|   `-- index.js
+-- tests/
|   +-- unit/
|   +-- integration/
|   +-- e2e/
|   `-- fixtures/
+-- docs/
|   +-- architecture/
|   +-- specs/ · plans/
|   `-- user-guide/
+-- scripts/
+-- package.json
`-- README.md
```

### Layout Rules

- `apps/*` contains interface code only.
- `src/core` owns the agent lifecycle and turn loop.
- `src/deepseek` owns all DeepSeek API adaptation.
- `src/tools` owns tool schemas, registration, permission checks, and execution.
- `src/edits` owns diff preview, apply, snapshots, and rollback.
- `src/sessions` owns durable events, artifacts, timeline, and resume.
- `src/workspace` owns filesystem safety, project detection, ignore rules, and git metadata.
- `src/shared` contains generic helpers with no project-specific side effects.
- `src/index.js` is the public kernel entrypoint used by CLI, TUI, and GUI.

## 6. Dependency Direction

All dependencies must point inward toward reusable runtime modules.

```text
apps/cli, apps/tui, apps/gui
  -> src/index.js
  -> src/core
  -> src/deepseek, src/context, src/tools, src/edits, src/sessions, src/config
  -> src/workspace, src/security, src/observability
  -> src/shared
```

Forbidden dependencies:

- `src/core` must not import from `apps/*`.
- `src/deepseek` must not import GUI, CLI, TUI, Electron, readline, or terminal renderers.
- `src/tools` must not import UI code.
- `src/context` must not execute shell commands.
- `apps/gui/renderer` must not import Node runtime modules directly.
- Tool implementations must not bypass `ToolExecutor`, `PermissionEngine`, or `ApprovalGate`.

## 7. Runtime Architecture

```text
User Interface
  -> Kernel API
  -> Agent Runtime
  -> DeepSeek Gateway
  -> Tool Execution Plane
  -> Edit Service / Workspace / Session / Verification
```

The runtime is turn-based. A turn is one user request plus all model calls, tool calls, approvals, file edits, verification steps, repair loops, artifacts, and final response.

```text
user input
 -> classify
 -> build cache-aware context
 -> plan
 -> approval gate
 -> act with tool calls
 -> execute tools
 -> feed tool results back to model
 -> apply edits
 -> verify
 -> repair if needed
 -> final response
 -> persist events and artifacts
```

The loop must be able to stop at approval points and resume without losing the turn state.

## 8. `src/core`

```text
src/core/
+-- runtime/
|   +-- agent-runtime.js
|   +-- turn-loop.js
|   +-- approval-flow.js
|   +-- repair-loop.js
|   `-- lifecycle.js
+-- protocol/
|   +-- agent-turn.js
|   +-- agent-step.js
|   +-- tool-call.js
|   +-- tool-result.js
|   +-- approval-request.js
|   `-- artifact.js
+-- planning/
|   +-- classifier.js
|   `-- planner.js
+-- execution/
|   +-- executor-loop.js
|   `-- tool-result-router.js
+-- verification/
|   +-- verifier.js
|   `-- repair-decision.js
`-- errors/
    +-- runtime-error.js
    `-- user-facing-error.js
```

`core` coordinates modules but does not own low-level implementation details. It asks `deepseek` for model calls, `tools` for execution, `context` for prompt input, `sessions` for logging, and `edits` for code changes.

### Core Protocol

```js
AgentTurn {
  id,
  session_id,
  user_message,
  status,
  autonomy,
  created_at,
  updated_at,
  steps,
  artifacts,
  usage
}

AgentStep {
  id,
  turn_id,
  type,
  channel,
  status,
  input_ref,
  output_ref,
  started_at,
  ended_at
}

ToolCall {
  id,
  name,
  params,
  source,
  requested_by_step_id
}

ToolResult {
  id,
  call_id,
  status,
  content,
  metadata,
  duration_ms
}

ApprovalRequest {
  id,
  turn_id,
  kind,
  risk,
  summary,
  details_ref,
  decisions
}

Artifact {
  id,
  kind,
  path,
  hash,
  size,
  ttl,
  metadata
}
```

## 9. `src/deepseek`

```text
src/deepseek/
+-- model-gateway.js
+-- model-router.js
+-- prompt-assembler.js
+-- json-mode.js
+-- tool-call-repair.js
+-- fim-client.js
+-- streaming.js
+-- usage-tracker.js
`-- api-errors.js
```

### DeepSeek Routing

- Fast path: `deepseek-v4-flash`, thinking disabled, low temperature.
- Planning path: `deepseek-v4-pro`, thinking enabled, high reasoning effort.
- Review and repair path: `deepseek-v4-pro` when complexity, failed tests, or conflicting tool results justify escalation.
- FIM path: beta completion endpoint for small localized insertions.
- JSON mode: enabled only for explicit structured outputs, never as a default for plain conversation.

### Prompt Assembly

Prompt assembly must maximize prefix cache:

```text
stable prefix:
  system prompt
  tool protocol
  project rules
  compact project index
  persistent memory summary

volatile suffix:
  current user request
  selected file snippets
  tool results
  verification output
```

DeepSeek cache telemetry is captured for every request:

- prompt tokens
- completion tokens
- reasoning tokens
- prompt cache hit tokens
- prompt cache miss tokens
- latency
- model
- channel

### Reasoning Content Policy

`reasoning_content` is internal protocol state:

- It is not shown in normal UI.
- It is not stored in readable timeline events.
- It may be stored as encrypted or redacted internal artifact if required for resume.
- It must be preserved across tool-call rounds when DeepSeek protocol requires it.

## 10. `src/tools`

```text
src/tools/
+-- registry.js
+-- executor.js
+-- schema.js
+-- builtin/
|   +-- read.js
|   +-- grep.js
|   +-- glob.js
|   +-- ls.js
|   +-- edit.js
|   +-- shell.js
|   +-- test.js
|   +-- git.js
|   +-- web-fetch.js
|   +-- memory.js
|   `-- task.js
`-- permissions/
    +-- permission-engine.js
    +-- policy-loader.js
    `-- approval-cache.js
```

The execution path is fixed:

```text
ToolCall
 -> schema validation
 -> parameter normalization
 -> permission decision
 -> approval if required
 -> execution
 -> result redaction
 -> ToolResult event
 -> model feedback
```

### Built-In Tools

- `read`: read text files within workspace.
- `grep`: search file contents.
- `glob`: find paths by pattern.
- `ls`: list directories.
- `edit`: apply unified diff through `EditService`.
- `diff_preview`: parse and summarize diff without writing.
- `diff_apply`: apply an approved diff.
- `diff_rollback`: rollback a change id.
- `shell`: execute structured argv with `shell:false`.
- `test`: detect and run project tests.
- `git`: read status, diff, log; write operations require approval.
- `web_fetch`: safe fetch with SSRF protections.
- `memory`: project-scoped memory read/write/list/delete.
- `task`: delegated subtask with constrained tools and budget.
- `ask_user`: explicit user clarification.

### Permission Invariants

- Tool category comes from registered tool definition, not model-provided input.
- Destructive operations cannot be auto-approved by trust rules.
- Secrets always require approval and redaction.
- Shell accepts structured argv only.
- Network tools validate protocol, hostname, DNS result, redirect chain, and output size.
- Filesystem tools resolve symlinks and enforce workspace boundaries.

## 11. `src/edits`

```text
src/edits/
+-- edit-service.js
+-- diff-parser.js
+-- diff-preview.js
+-- diff-apply.js
+-- rollback-service.js
`-- change-store.js
```

The mature legacy pipeline is reused here:

- `extractUnifiedDiff`
- `parseUnifiedDiff`
- `summarizeDiff`
- `applyUnifiedDiff`
- `captureChangePlan`
- `finalizeChange`
- `rollbackChange`

The public service contract becomes:

```js
EditService.preview(diff) -> DiffPreview
EditService.apply({ diff, prompt, approval_id }) -> ChangeRecord
EditService.rollback(change_id) -> RollbackRecord
EditService.describe(change_id) -> ChangeRecord
EditService.list({ limit }) -> ChangeRecord[]
```

All file edits must produce:

- diff artifact
- preview summary
- change id
- before snapshot
- after snapshot
- session events
- rollback path

## 12. `src/context`

```text
src/context/
+-- workspace-indexer.js
+-- context-selector.js
+-- context-snapshot.js
+-- cache-policy.js
+-- memory-selector.js
`-- token-budget.js
```

Context is responsible for what the model sees. It does not modify files.

Context layers:

- Stable project index: cache-friendly, compact, repeated across turns.
- Hot files: recently edited, pinned, or directly referenced.
- Warm files: likely relevant based on search, imports, diagnostics, or git diff.
- Cold files: indexed metadata only unless selected.
- Memory: project preference and facts, summarized for stable prefix.

## 13. `src/workspace`

```text
src/workspace/
+-- path-safety.js
+-- file-system.js
+-- git-info.js
+-- ignore-rules.js
`-- project-detector.js
```

Workspace owns all local project safety rules:

- realpath-based workspace boundary checks
- symlink escape prevention
- binary and large file detection
- ignore rules
- project root detection
- safe relative path normalization
- git repository metadata

## 14. `src/sessions`

```text
src/sessions/
+-- event-log.js
+-- session-manager.js
+-- timeline.js
+-- resume.js
`-- artifact-store.js
```

There is only one session system in v2. CLI, TUI, and GUI consume the same event stream.

Events include:

- `session:start`
- `session:resume`
- `user:message`
- `agent:turn_started`
- `agent:step`
- `model:request`
- `model:response`
- `tool:call`
- `tool:result`
- `permission:decision`
- `approval:requested`
- `approval:resolved`
- `file:diff_preview`
- `file:diff_applied`
- `verification:result`
- `agent:final`
- `agent:error`

Large outputs are stored as artifacts and referenced from events.

## 15. `src/config`

```text
src/config/
+-- config-loader.js
+-- config-schema.js
+-- model-profiles.js
+-- env.js
`-- redaction.js
```

Config order:

```text
environment variables
  > project .deepseek-code/config.json
  > user ~/.deepseek-code/config.json
  > defaults
```

API keys are never written to logs or GUI IPC responses.

## 16. `src/security`

```text
src/security/
+-- secret-detector.js
+-- redactor.js
+-- ssrf.js
+-- shell-policy.js
`-- audit.js
```

Security is cross-cutting but must have reusable helpers rather than ad hoc checks scattered across modules.

## 17. `src/observability`

```text
src/observability/
+-- trace.js
+-- metrics.js
+-- token-accounting.js
`-- diagnostics.js
```

The UI status bar and logs should be driven by metrics rather than direct module internals:

- current model
- current channel
- autonomy level
- token usage
- cache hit rate
- active tool
- verification state
- cost estimate when available

## 18. Application Layer

### CLI

```text
apps/cli/
+-- main.js
+-- commands/
|   +-- ask.js
|   +-- edit.js
|   +-- chat.js
|   +-- test.js
|   +-- config.js
|   `-- rollback.js
`-- renderers/
    +-- text.js
    +-- diff.js
    `-- approval.js
```

The CLI calls `createKernel()` and renders events. It does not contain agent logic.

### TUI

```text
apps/tui/
+-- main.js
+-- screens/
+-- components/
`-- keymap.js
```

The TUI remains incremental at first. It subscribes to session events and renders status, timeline, input, approvals, and diff previews.

### GUI

```text
apps/gui/
+-- package.json
+-- main/
|   +-- main.js
|   +-- ipc.js
|   `-- kernel-host.js
+-- preload/
|   `-- preload.js
`-- renderer/
    +-- index.html
    +-- app.js
    `-- styles/
```

Electron security requirements:

- `nodeIntegration:false`
- `contextIsolation:true`
- `sandbox:true`
- strict CSP
- IPC whitelist
- renderer uses DOM-safe text rendering
- approval decisions pass through validated IPC schema

## 19. Public Kernel API

`src/index.js` exports the stable API:

```js
createKernel(root, options) -> Kernel

Kernel {
  agent: {
    send(message, options),
    approve(approval_id, decision),
    interrupt(turn_id)
  },
  session: {
    subscribe(handler),
    getTimeline(options),
    resume(session_id)
  },
  context: {
    snapshot(options),
    pin(path),
    unpin(path)
  },
  config: {
    getPublicConfig(),
    updateProjectConfig(patch)
  }
}
```

All interfaces use this API.

## 20. Migration Strategy

The migration should be staged so the project remains testable at every step.

### Phase V2-0: Skeleton and Protocol

- Create the new directory structure.
- Add protocol objects and runtime event schemas.
- Add tests for turn lifecycle using a mock DeepSeek gateway.

### Phase V2-1: DeepSeek Gateway

- Replace default JSON mode with explicit JSON mode.
- Add model router, usage tracker, streaming parser, FIM client, and API error handling.
- Add tests for request bodies, JSON mode guard, SSE parsing, tool-call payload handling, and cache usage extraction.

### Phase V2-2: Tool Plane

- Move permission engine into `src/tools/permissions`.
- Rebuild tool registry and executor around schema validation and approval.
- Implement real built-in tools.
- Verify `tool:call` and `tool:result` events feed back into the agent loop.

### Phase V2-3: Edit Service

- Move or wrap existing diff and change modules into `src/edits`.
- Implement `diff_preview`, `diff_apply`, and `diff_rollback`.
- Connect edits to tool execution, artifacts, and session events.

### Phase V2-4: Runtime Loop

- Implement planning, execution, review, verification, and repair loop.
- Add model-output repair for malformed JSON or invalid tool calls.
- Add verifier gates for tests, syntax checks, and git diff review.

### Phase V2-5: Interface Migration

- Migrate CLI commands to the v2 kernel.
- Migrate TUI to event stream rendering.
- Move GUI from `gui/` to `apps/gui/` and connect it to the v2 kernel host.
- Keep compatibility commands temporarily, but remove old agent ownership.

### Phase V2-6: Cleanup

- Move old implementation into `src/legacy` only while needed.
- Delete unused v0/v1 paths after parity tests pass.
- Rewrite README and user docs for v2.
- Add end-to-end tests for CLI edit, rollback, GUI basic send, and approval flow.

## 21. Testing Strategy

```text
tests/unit/
+-- core/
+-- deepseek/
+-- tools/
+-- edits/
+-- context/
+-- workspace/
`-- sessions/

tests/integration/
+-- agent-loop.test.js
+-- tool-execution.test.js
+-- edit-rollback.test.js
+-- permission-approval.test.js
+-- model-tool-feedback.test.js
`-- session-resume.test.js

tests/e2e/
+-- cli-edit.test.js
+-- cli-ask.test.js
+-- gui-agent.test.js
`-- tui-basic.test.js
```

Tests must prove:

- A model tool call reaches the executor.
- Permission decisions affect execution.
- Tool results are fed back into the next model step.
- A diff can be previewed, applied, verified, and rolled back.
- Plain chat does not enable JSON mode by default.
- JSON mode is used only for structured prompts that explicitly request json.
- GUI and CLI share session events.
- Workspace escape attempts fail.
- SSRF attempts fail.

## 22. Acceptance Criteria

v2 is accepted only when these are true:

1. `deepseek-code ask "hello"` returns a normal answer without JSON mode errors.
2. `deepseek-code edit ...` uses the same runtime as GUI and TUI.
3. GUI can send a prompt, show streamed progress, request approval, preview diff, apply change, and show result.
4. Tool calls are real: read, grep, edit, shell, test, git, web_fetch, and memory produce actual results or safe denials.
5. Every write operation has a change id and rollback path.
6. Test failure triggers repair loop or a clear terminal failure.
7. Session timeline shows user message, model steps, tool calls, approvals, diffs, verification, and final answer.
8. API usage shows model, tokens, cache hit rate, and latency.
9. No interface imports legacy agent logic.
10. Full test and syntax check pass.

## 23. Compatibility Policy

During migration:

- Existing commands remain available.
- Old files may be wrapped, moved, or temporarily mirrored.
- The project should not delete user data under `.deepseek-code`.
- Existing change records remain readable.

After migration:

- `src/agent.js`, old `src/kernel/task-orchestrator.js`, and stub tool implementations are removed or converted into compatibility shims.
- `gui/` is replaced by `apps/gui/`.
- `test/kernel` is migrated into `tests/unit` and `tests/integration`.

## 24. Risk Register

| Risk | Mitigation |
|------|------------|
| Clean-room rewrite takes longer than patching v1 | Split into small phases with working tests after each phase |
| New runtime loses mature diff behavior | Wrap existing diff and rollback code first, then refactor internally |
| DeepSeek tool-call edge cases cause loops | Add tool-call repair, max loop count, and terminal failure states |
| JSON mode breaks normal chat | Make JSON mode opt-in per structured call |
| GUI falls behind runtime | Treat GUI as event-stream client, not owner of business logic |
| Permissions become inconsistent | Enforce one ToolExecutor path for every tool |
| Long context becomes expensive | Use cache-aware stable prefix and Flash-first routing |

## 25. Final Architecture Summary

DeepSeek Code v2 becomes:

```text
Apps
  CLI / TUI / GUI

Public Kernel API
  createKernel()

Core Runtime
  turn loop / planning / execution / review / verification / repair

DeepSeek Adapter
  Flash / Pro / thinking / JSON / tool calls / FIM / cache / usage

Tool Plane
  registry / schema / permissions / approval / executor

Domain Services
  context / workspace / edits / sessions / config / security / observability
```

The most important architectural invariant is simple:

> There is one agent runtime, one tool execution path, one session system, and one edit pipeline. Every interface is only a client.
