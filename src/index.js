import path from "node:path";
import { createEventBus } from "./shared/event-bus.js";
import { makeId } from "./shared/id.js";
import { createAgentRuntime } from "./core/runtime/agent-runtime.js";
import { SESSION_EVENT_TYPES } from "./sessions/event-types.js";
import { createSessionEventLog, projectIdFromRoot } from "./sessions/event-log.js";
import { createSessionManager } from "./sessions/session-manager.js";
import { createBranchStore } from "./sessions/branch-store.js";
import { createRewindService } from "./sessions/rewind-service.js";
import { buildCheckpointIndex } from "./sessions/checkpoint-index.js";
import { createDeepSeekGateway } from "./deepseek/model-gateway.js";
import { createEditService } from "./edits/edit-service.js";
import { createBuiltinTools } from "./tools/builtin/index.js";
import { createToolRegistry } from "./tools/registry.js";
import { createToolExecutor } from "./tools/executor.js";
import { createPermissionEngine } from "./tools/permissions/permission-engine.js";
import { createApprovalCache } from "./tools/permissions/approval-cache.js";
import { createPolicyContext } from "./tools/permissions/policy-loader.js";
import { createContextEngine } from "./context/index.js";
import { createPausedTurnPersistence } from "./core/recovery/paused-turn-persistence.js";
import { createPausedTurnStore } from "./core/approval/paused-turn-store.js";
import { createOrchestrationPersistence } from "./core/recovery/orchestration-persistence.js";
import { createRecoveryInbox } from "./core/recovery/recovery-inbox.js";
import { createRecoveryService } from "./core/recovery/recovery-service.js";
import { acquireProjectLock } from "./core/recovery/project-lock.js";
import { createTransactionJournal } from "./core/recovery/transaction-journal.js";
import { createTaskRouter } from "./core/orchestration/task-router.js";
import { createOrchestrator } from "./core/orchestration/orchestrator.js";
import { createPlanner } from "./core/orchestration/planner.js";
import { createSynthesizer } from "./core/orchestration/synthesizer.js";
import { createWorkerFactory } from "./core/orchestration/worker-factory.js";
import { createReviewer } from "./core/orchestration/reviewer.js";
import { createExperienceStore } from "./core/memory/experience-store.js";
import { createConsolidator } from "./core/memory/experience-consolidator.js";
import { query as experienceQuery } from "./core/memory/experience-retrieval.js";
import { createCostBudget } from "./core/runtime/cost-budget.js";
import { normalizeOrchestration } from "./config.js";
import { toBatches } from "./core/orchestration/batch-planner.js";
import { createIsoWorkerRunner } from "./core/orchestration/iso-worker-runner.js";
import { mergeSubtask } from "./core/orchestration/merge-back.js";
import { removeIso, sweepOrphans } from "./core/orchestration/iso-workspace.js";
import { filterToolSchemas } from "./core/orchestration/tool-profiles.js";

export async function createKernel(root, options = {}) {
  const eventBus = options.eventBus || createEventBus();
  const sessionId = options.sessionId || makeId("sess");
  const projectId = options.projectId || projectIdFromRoot(root);
  const sessionRoot = options.sessionRoot || path.join(root, ".deepseek-code", "v2", "sessions");
  // Recovery is opt-in (default off), consistent with the V2-20 guardrail
  // pattern: the kernel primitive stays a mechanism; the config layer decides
  // policy. Enable durable recovery via createKernel(root, { recovery: { enabled: true } }).
  const recoveryEnabled = options.recovery?.enabled === true;

  // Acquire project lock if recovery enabled
  const projectLock = recoveryEnabled && options.recovery?.lock !== false
    ? await acquireProjectLock({
        root,
        surface: options.recovery?.surface || "cli",
        sessionId,
        interactive: options.recovery?.interactive !== false,
        takeover: options.recovery?.takeover || null,
        faults: options.recovery?.faults || options.recoveryFaults
      }).catch((error) => {
        // In test environments with temporary directories, allow lock bypass on conflict
        if (error?.code === "RECOVERY_LOCK_HELD" && options.recovery?.lockFailureMode === "warn") {
          return { assertOwner: async () => {}, epoch: 1, release: async () => {} };
        }
        throw error;
      })
    : null;

  const pausedTurnPersistence = recoveryEnabled
    ? createPausedTurnPersistence({ root, projectId, faults: options.recovery?.faults || options.recoveryFaults })
    : null;
  // Durable orchestration recovery: main runtime + all workers + rebuilt workers
  // share ONE paused-turn store so a recovery-restored record is visible to the
  // rebuilt worker's approve(). Off => undefined => each runtime keeps its own
  // default store (byte-for-byte today's behavior). Never null (null bypasses the
  // createAgentRuntime default param and would crash on .size()).
  const sharedPausedTurnStore = recoveryEnabled ? createPausedTurnStore() : null;
  const orchPersistence = recoveryEnabled
    ? createOrchestrationPersistence({ root, projectId, faults: options.recovery?.faults || options.recoveryFaults })
    : null;
  let kernelDisposed = false;

  const recoveryInbox = recoveryEnabled
    ? createRecoveryInbox({ root })
    : null;
  const transactionJournal = recoveryEnabled
    ? createTransactionJournal({ root, projectId, faults: options.recovery?.faults || options.recoveryFaults })
    : null;
  const sessionLog = options.sessionLog === null
    ? null
    : options.sessionLog || (!options.sessionManager
        ? await createSessionEventLog({
            sessionRoot,
            projectId,
            sessionId,
            meta: { root, runtime: "v2" },
            // M1 A1a:config.events.strictSchema 默认关闭;开启时也只告警不阻断(见 event-log.js)。
            strictSchema: options.events?.strictSchema === true
          })
        : null);
  const branchStore = options.branchStore !== undefined
    ? options.branchStore
    : (sessionLog !== null ? await createBranchStore({
        sessionRoot,
        projectId,
        sessionId
      }) : null);
  let activeBranchId = branchStore ? await branchStore.getActiveBranchId() : "br_main";
  const sessionManager = options.sessionManager || createSessionManager({
    eventBus,
    eventLog: sessionLog,
    eventTypes: SESSION_EVENT_TYPES,
    getActiveBranchId: () => activeBranchId,
    getBranchAncestry: (branchId) => branchStore ? branchStore.getAncestry(branchId) : Promise.resolve([{ branch_id: branchId || "br_main", forked_from_seq: 0 }])
  });
  const modelGateway = resolveModelGateway(options);
  const approvalCache = options.approvalCache || createApprovalCache();
  const permissionEngine = options.permissionEngine || createPermissionEngine();
  const mainPlane = buildToolPlane(root, {
    eventBus,
    permissionEngine,
    recoveryJournal: transactionJournal,
    assertOwner: projectLock ? () => projectLock.assertOwner() : async () => {},
    webFetch: options.webFetch || {},
    defaultToolTimeoutMs: options.limits?.toolTimeoutMs ?? null,
    editService: options.editService,
    toolRegistry: options.toolRegistry,
    toolExecutor: options.toolExecutor,
    // #9.3 敏感文件提醒:只接主区平面。并行 iso worker 写的是临时拷贝,其改动
    // 最终经 mergeSubtask 走**主区** editService.apply 落记录,提醒在那里触发;
    // 给 iso 平面接反而会让无人值守的隔离 worker 卡在提问上。
    onSensitiveNotice: options.onSensitiveNotice || null,
    edits: options.edits
  });
  const editService = mainPlane.editService;
  const toolRegistry = mainPlane.toolRegistry;
  const toolExecutor = mainPlane.toolExecutor;
  const contextEngine = options.contextEngine || createContextEngine({
    root,
    eventBus,
    options: options.context || {}
  });
  if (!options.contextEngine) {
    await contextEngine.scan();
  }

  const runtimeConfig = {
    eventBus,
    sessionId,
    projectId,
    projectRoot: root,
    trustStore: options.trustStore || { rules: [] },
    projectRules: options.projectRules || [],
    memoryRoot: options.memoryRoot || null,
    recoverySurface: options.recovery?.surface || "cli",
    pausedTurnPersistence,
    pausedTurnStore: sharedPausedTurnStore || undefined,
    flushEvents: () => sessionManager.flush(),
    modelGateway,
    toolSchemas: () => toolRegistry.toDeepSeekTools(),
    executeTool: (toolCall, policyContext) => toolExecutor.execute(toolCall, policyContext),
    createPolicyContext: (executionOptions = {}) => {
      const context = createPolicyContext({
        autonomy: executionOptions.autonomy || "gated",
        projectId: executionOptions.projectId || projectId,
        projectRoot: executionOptions.projectRoot || root,
        trustStore: executionOptions.trustStore || options.trustStore || { rules: [] },
        projectRules: executionOptions.projectRules || options.projectRules || [],
        approvalCache,
        memoryRoot: "memoryRoot" in executionOptions ? executionOptions.memoryRoot : (options.memoryRoot || null)
      });
      context.turnId = executionOptions.turnId;
      context.toolCall = executionOptions.toolCall;
      context.phase = executionOptions.phase;
      return context;
    },
    verifyMode: options.verifyMode || "auto",
    testArgv: options.testArgv || null,
    maxRepairAttempts: options.maxRepairAttempts ?? 2,
    createContextSnapshot: (input) => contextEngine.snapshot(input),
    maxTurnTokens: options.limits?.maxTurnTokens ?? null,
    maxModelCalls: options.limits?.maxModelCalls ?? null,
    modelTimeoutMs: options.limits?.modelTimeoutMs ?? null,
    maxToolCallRepairs: options.limits?.maxToolCallRepairs ?? 0,
    grantApprovalForToolCall: async (toolCall, approvalContext = {}) => {
      const securedCall = toolRegistry.secureToolCall(toolCall);
      const permissionContext = approvalContext.permission_context || approvalContext.options?.permission_context || null;
      const policyContext = createPolicyContext({
        autonomy: permissionContext?.autonomy || approvalContext.options?.autonomy || "supervised",
        projectId: permissionContext?.project_id || approvalContext.options?.projectId || projectId,
        projectRoot: permissionContext?.project_root || root,
        trustStore: permissionContext ? { rules: permissionContext.trust_store_rules || [] } : (options.trustStore || { rules: [] }),
        projectRules: permissionContext?.project_rules || options.projectRules || [],
        approvalCache,
        memoryRoot: permissionContext?.memory_root ?? options.memoryRoot ?? null
      });
      policyContext.turnId = approvalContext.turnId;
      const fp = permissionEngine.fingerprint(securedCall, policyContext);
      approvalCache.grant(fp, { decision: "allow" });
    }
  };

  const runtime = createAgentRuntime(runtimeConfig);
  // Worker/Reviewer sub-agents reuse the same runtime config with a filtered tool
  // set + scoped context — agent-runtime itself is unchanged.
  const createRuntime = (overrides = {}) => createAgentRuntime({ ...runtimeConfig, ...overrides });

  const orch = normalizeOrchestration(options.orchestration);
  // C-Router: model-assisted tier for the ambiguous band (purpose = configured channel, short timeout).
  const routerCallModel = async (prompt, { timeoutMs } = {}) => {
    if (!modelGateway?.invoke) return "";
    const res = await modelGateway.invoke([{ role: "user", content: prompt }], { purpose: orch.router.model.channel, timeoutMs });
    return res?.content || "";
  };
  const taskRouter = createTaskRouter({ ...orch.router, model: { ...orch.router.model, callModel: routerCallModel } });
  // C3: sweep orphaned isolation dirs from prior crashed runs (owner/TTL guarded).
  await sweepOrphans({ root, ttlMs: orch.parallel.sweepTtlMs, pid: process.pid }).catch(() => {});
  const isoPlaneDeps = {
    eventBus,
    permissionEngine,
    recoveryJournal: null,
    assertOwner: async () => {},
    webFetch: options.webFetch || {},
    defaultToolTimeoutMs: options.limits?.toolTimeoutMs ?? null
  };
  const callModel = async (prompt) => {
    if (!modelGateway?.invoke) return "";
    const res = await modelGateway.invoke([{ role: "user", content: prompt }], { purpose: "plan" });
    return res?.content || "";
  };
  // C4 cross-task experience memory (opt-in; "off" => fully inert: no dir, no retrieval,
  // no consolidation, no new events, decide() unchanged).
  const experienceNow = () => Date.now();
  let experienceStore = null;
  let experienceRetrieval = null;
  let experienceConsolidator = null;
  if (orch.crossTaskLearning !== "off") {
    experienceStore = createExperienceStore({ dir: path.join(root, ".deepseek-code", "v2", "experience"), now: experienceNow });
    experienceConsolidator = createConsolidator({
      callModel, store: experienceStore, now: experienceNow, cfg: orch.experience,
      mode: orch.crossTaskLearning,
      onPending: (info) => eventBus.publish("experience:pending_approval", info)
    });
    experienceRetrieval = { query: (input) => experienceQuery(experienceStore, input, { retrieveK: orch.experience.retrieveK }) };
  }
  const orchestrator = createOrchestrator({
    planner: createPlanner({ callModel }),
    makeWorkerFactory: () => createWorkerFactory({
      createRuntime,
      baseToolSchemas: () => toolRegistry.toDeepSeekTools(),
      makeContextSnapshot: (input) => contextEngine.snapshot(input)
    }),
    makeReviewerFor: (workerFactory) => createReviewer({ runtime: workerFactory.reviewerRuntime() }),
    synthesizer: createSynthesizer({ callModel }),
    makeBudget: () => createCostBudget({ maxTokens: orch.budget.maxTokens, maxModelCalls: orch.budget.maxModelCalls }),
    maxSubtasks: orch.maxSubtasks,
    maxWorkerAttempts: orch.maxWorkerAttempts,
    eventBus,
    makeContext: (input) => contextEngine.snapshot({ ...input, phase: "plan" }),
    // C3 parallel isolation:
    maxParallelWorkers: orch.parallel.maxParallelWorkers,
    toBatches,
    runIsolatedWorker: createIsoWorkerRunner({
      root,
      buildToolPlane,
      createRuntime,
      makeContextSnapshot: (input) => contextEngine.snapshot(input),
      makeReviewer: (isoRoot) => {
        const plane = buildToolPlane(isoRoot, isoPlaneDeps);
        return createReviewer({ runtime: createRuntime({
          projectRoot: isoRoot,
          executeTool: plane.execute,
          toolSchemas: () => filterToolSchemas(plane.toolRegistry.toDeepSeekTools(), "readonly")
        }) });
      },
      maxCopyFiles: orch.parallel.maxCopyFiles,
      planeDeps: isoPlaneDeps
    }),
    mergeSubtask: (r) => mergeSubtask({ editService, mainRoot: root, isoRoot: r.isoRoot, baseManifest: r.baseManifest, actual: r.actual }),
    removeIso: (dir) => removeIso(dir),
    maxRounds: orch.maxRounds,
    crossTaskLearning: orch.crossTaskLearning,
    experienceRetrieval,
    experienceConsolidator,
    now: experienceNow,
    orchPersistence,
    makeResumedBudget: (s) => createCostBudget({ maxTokens: s.maxTokens, maxModelCalls: s.maxModelCalls, initialTokens: s.initialTokens, initialModelCalls: s.initialModelCalls }),
    env: { root, orchestrationConfig: orch },
    pausedTurnStore: sharedPausedTurnStore || undefined,
    pausedTurnPersistence
  });
  // Unified entry: the router decides single (today's path, zero new events) vs orchestrate.
  async function routedSend(message, sendOptions = {}) {
    const decision = await taskRouter.route(message, sendOptions);
    if (decision.tier === "model" || decision.tier === "fallback") {
      eventBus.publish("orchestration:route_resolved", {
        band: decision.band, score: decision.score, features: decision.features,
        finalLane: decision.lane, tier: decision.tier, reason: decision.reason
      });
    }
    if (decision.lane === "single") return runtime.send(message, sendOptions);
    eventBus.publish("orchestration:routed", { lane: decision.lane, reason: decision.reason, signals: decision.signals });
    return orchestrator.run({ message, options: sendOptions, routing: decision });
  }

  const branches = branchStore ? {
    list: () => branchStore.listBranches(),
    async getActive() {
      return branchStore.getBranch(activeBranchId);
    },
    async create(input = {}) {
      return branchStore.createBranch(input);
    },
    async activate(branch_id) {
      const branch = await branchStore.activateBranch(branch_id);
      activeBranchId = branch.branch_id;
      eventBus.publish("session:branch_activated", {
        branch_id: branch.branch_id,
        parent_branch_id: branch.parent_branch_id
      });
      await sessionManager.flush();
      return branch;
    }
  } : {
    list: async () => [],
    getActive: async () => ({ branch_id: "br_main", parent_branch_id: null, forked_from_event_id: null, forked_from_seq: 0, forked_from_turn_id: null, created_at: new Date().toISOString(), label: "main" }),
    create: async () => { throw new Error("branch store unavailable"); },
    activate: async () => { throw new Error("branch store unavailable"); }
  };

  const rewind = branchStore ? createRewindService({
    eventBus,
    projectRoot: root,
    getTimeline: (input) => sessionManager.getTimeline(input),
    getActiveBranchId: async () => activeBranchId,
    createBranch: (input) => branches.create(input),
    activateBranch: (branchId) => branches.activate(branchId),
    rollback: (input) => editService.rollback(input),
    recoveryJournal: transactionJournal,
    assertOwner: projectLock ? () => projectLock.assertOwner() : async () => {}
  }) : {
    preview: async () => { throw new Error("rewind unavailable: no branch store"); },
    apply: async () => { throw new Error("rewind unavailable: no branch store"); }
  };

  const checkpoints = {
    async list({ branch_id = activeBranchId } = {}) {
      const timeline = await sessionManager.getTimeline({ count: 10000, branch_id });
      return buildCheckpointIndex(timeline, { branch_id }).checkpoints;
    }
  };

  const session = {
    subscribe: sessionManager.subscribe,
    getTimeline: sessionManager.getTimeline,
    flush: sessionManager.flush,
    async resume(id = sessionId) {
      eventBus.publish("session:resume", { session_id: id, root });
      await sessionManager.flush();
    },
    dispose: sessionManager.dispose,
    branches,
    rewind,
    checkpoints
  };

  const context = {
    snapshot: (input = {}) => contextEngine.snapshot(input),
    pin: (p) => contextEngine.pin(p),
    unpin: (p) => contextEngine.unpin(p),
    warm: (p, reason) => contextEngine.warm(p, reason),
    getStats: () => contextEngine.getStats()
  };

  const config = {
    getPublicConfig() {
      return { runtime: "v2", root, has_api_key: Boolean(options.deepseek?.apiKey || process.env.DEEPSEEK_API_KEY) };
    },
    updateProjectConfig() { throw new Error("project config updates are not available in V2-2"); }
  };

  const tools = {
    list(filter = {}) {
      return toolRegistry.listTools(filter);
    },
    schemas(filter = {}) {
      return toolRegistry.toDeepSeekTools(filter);
    },
    async execute(toolCall, executionOptions = {}) {
      const policyContext = createPolicyContext({
        autonomy: executionOptions.autonomy || "gated",
        projectId: executionOptions.projectId || sessionId,
        projectRoot: root,
        trustStore: options.trustStore || { rules: [] },
        projectRules: options.projectRules || [],
        approvalCache,
        memoryRoot: options.memoryRoot || null,
        turnId: executionOptions.turnId
      });
      policyContext.turnId = executionOptions.turnId;
      return toolExecutor.execute(toolCall, policyContext);
    }
  };

  const recovery = recoveryEnabled && !options.recovery?.skipStartupRecovery
    ? await createRecoveryServiceFacade({
        projectId,
        projectLock,
        pausedTurnPersistence,
        recoveryInbox,
        runtime,
        sessionManager,
        eventBus,
        options,
        transactionJournal,
        orchPersistence,
        resumeOrchestration: (approvalId, decision) => orchestrator.resumeDurable(approvalId, decision)
      })
    : disabledRecoveryFacade();

  return {
    root,
    eventBus,
    runtime,
    agent: {
      send: routedSend,
      approve: async (id, decision) => {
        if (orchestrator.hasPaused(id)) return orchestrator.resume(id, decision);
        if (recoveryEnabled && await orchestrator.hasDurablePaused(id)) return orchestrator.resumeDurable(id, decision);
        return runtime.approve(id, decision);
      },
      interrupt: runtime.interrupt,
      listPaused: runtime.listPaused,
      cancelPaused: runtime.cancelPaused
    },
    recovery,
    session,
    sessionManager,
    context,
    config,
    tools,
    experience: {
      listPending: async () => {
        if (!experienceStore) return [];
        await experienceStore.prunePending?.(orch.experience.pendingTtlMs);
        return experienceStore.listPending();
      },
      resolvePending: async (id, decision) => {
        const r = await experienceStore?.resolvePending?.(id, decision);
        eventBus.publish("experience:pending_resolved", { pendingId: id, decision });
        return r;
      },
      flush: () => orchestrator.flushExperience()
    },
    async dispose() {
      if (kernelDisposed) return;
      kernelDisposed = true;
      try { await orchestrator.flushExperience?.(); } catch { /* best-effort */ }
      try { await experienceStore?.flush?.(); } catch { /* best-effort */ }
      try { sessionManager.dispose?.(); } catch { /* best-effort */ }
      try { await projectLock?.release?.(); } catch { /* best-effort */ }
    },
    metrics: {
      getUsage() {
        return modelGateway?.getUsageStats?.() || zeroUsage();
      },
      getContext() {
        return contextEngine.getStats();
      },
      getSnapshot: async (input = {}) => {
        const snap = await contextEngine.snapshot(input);
        return redactSnapshot(snap);
      }
    },
    // v1.9.0 M3 A3:FIM 门面(组合根附加,八目录零改动)。转调 modelGateway.fimComplete
    //(src/deepseek/model-gateway.js:113——已处理 models.fim 解析、timeoutMs→signal、
    //recordUsage 遥测)。端点与参数约束(/beta、4K cap、betaBase 可配)在 src/deepseek 客户端侧。
    fim: {
      async complete(prefix, suffix = "", options = {}) {
        if (!modelGateway || typeof modelGateway.fimComplete !== "function") {
          throw new Error("FIM unavailable: model gateway is not configured");
        }
        return modelGateway.fimComplete(prefix, suffix, options);
      }
    }
  };
}

export function buildToolPlane(root, {
  eventBus = null,
  permissionEngine = null,
  recoveryJournal = null,
  assertOwner = async () => {},
  webFetch = {},
  defaultToolTimeoutMs = null,
  editService = null,
  toolRegistry = null,
  toolExecutor = null,
  onSensitiveNotice = null,
  edits = {}
} = {}) {
  const svc = editService || createEditService({ projectRoot: root, eventBus, recoveryJournal, assertOwner, onSensitiveNotice, edits });
  const registry = toolRegistry || createToolRegistry({ tools: createBuiltinTools({ editService: svc, webFetch }) });
  const executor = toolExecutor || createToolExecutor({
    registry,
    permissionEngine: permissionEngine || createPermissionEngine(),
    eventBus,
    defaultToolTimeoutMs
  });
  return { editService: svc, toolRegistry: registry, toolExecutor: executor, execute: (toolCall, ctx) => executor.execute(toolCall, ctx) };
}

async function createRecoveryServiceFacade({
  projectId,
  projectLock,
  pausedTurnPersistence,
  recoveryInbox,
  runtime,
  sessionManager,
  eventBus,
  options,
  transactionJournal,
  orchPersistence = null,
  resumeOrchestration = null
}) {
  const recoveryService = createRecoveryService({
    projectId,
    lock: projectLock || { assertOwner: async () => {}, epoch: 0 },
    paused: pausedTurnPersistence,
    pausedTurnStore: {
      restore: runtime.restorePaused,
      list: runtime.listPaused
    },
    inbox: recoveryInbox,
    appendMarker: async (type, data) => {
      eventBus.publish(type, data);
      await sessionManager.flush();
    },
    resumePaused: async (approvalId, decision) => runtime.approve(approvalId, decision),
    cancelPaused: async (approvalId) => runtime.cancelPaused(approvalId),
    transactionJournal,
    orchPersistence,
    resumeOrchestration
  });

  if (!options.recovery?.skipStartupRecovery) {
    await recoveryService.recoverOnStartup();
  }

  return {
    list: (opts) => recoveryService.list(opts),
    resume: (id, opts) => recoveryService.resume(id, opts),
    cancel: (id) => recoveryService.cancel(id),
    clear: (id) => recoveryService.clear(id),
    abortJournal: (id) => recoveryService.abortJournal(id),
    commitJournal: (id) => recoveryService.commitJournal(id),
    report: () => recoveryService.report()
  };
}

function disabledRecoveryFacade() {
  return {
    list: async () => [],
    resume: async () => { throw Object.assign(new Error("recovery is disabled"), { code: "RECOVERY_DISABLED" }); },
    cancel: async () => { throw Object.assign(new Error("recovery is disabled"), { code: "RECOVERY_DISABLED" }); },
    clear: async () => { throw Object.assign(new Error("recovery is disabled"), { code: "RECOVERY_DISABLED" }); },
    report: () => ({ found: [], done: [], blocked: [], next: [] })
  };
}

function redactSnapshot(snap) {
  const { summary, ...rest } = snap;
  const cleanUnits = (snap.units || []).map((unit) => {
    const { snippet, ...restUnit } = unit;
    return restUnit;
  });
  return { ...rest, summary: undefined, units: cleanUnits };
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

function resolveModelGateway(options) {
  if (options.modelGateway) return options.modelGateway;
  if (options.deepseek || process.env.DEEPSEEK_API_KEY) return createDeepSeekGateway(options.deepseek || {});
  return null;
}
