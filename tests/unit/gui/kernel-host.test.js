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
  // V2 runtime publishes agent:final natively; host must not duplicate agent:result
  assert.equal(pushed.some((event) => event.type === "agent:result"), false);
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

test("kernel host exposes recovery delegates", async () => {
  const calls = [];
  const host = createKernelHost({
    projectRoot: "/repo",
    kernelFactory: async () => ({
      session: { subscribe: () => ({ unsubscribe() {} }), getTimeline: async () => [] },
      agent: { send: async () => ({ status: "complete" }), approve: () => {}, interrupt: () => {} },
      recovery: {
        list: async () => [{ id: "rec_tx_1" }],
        report: async () => ({ found: ["a"], done: [], blocked: [], next: [] }),
        resume: async (id) => { calls.push(["resume", id]); return { status: "resumed" }; },
        cancel: async (id) => { calls.push(["cancel", id]); return { status: "cancelled" }; },
        clear: async (id) => { calls.push(["clear", id]); return { status: "cleared" }; }
      },
      context: { snapshot: async () => ({ units: [] }) },
      config: { getPublicConfig: () => ({ runtime: "v2" }) },
      runtime: { getState: () => ({ current: "idle", channel: null }) }
    })
  });

  await host.init();
  assert.deepEqual(await host.getRecoveryList(), [{ id: "rec_tx_1" }]);
  assert.deepEqual(await host.getRecoveryReport(), { found: ["a"], done: [], blocked: [], next: [] });
  assert.deepEqual(await host.recoveryResume("rec_pause_1"), { status: "resumed" });
  assert.deepEqual(await host.recoveryCancel("rec_pause_1"), { status: "cancelled" });
  assert.deepEqual(await host.recoveryClear("rec_tx_1"), { status: "cleared" });
  assert.deepEqual(calls, [["resume", "rec_pause_1"], ["cancel", "rec_pause_1"], ["clear", "rec_tx_1"]]);
});

test("kernel host recovery list/report degrade when kernel not ready", async () => {
  const host = createKernelHost({
    projectRoot: "/repo",
    kernelFactory: async () => null
  });
  // init fails / no kernel → ready() false
  try { await host.init(); } catch { /* factory may fail */ }
  assert.deepEqual(await host.getRecoveryList(), []);
  assert.deepEqual(await host.getRecoveryReport(), { found: [], done: [], blocked: [], next: [] });
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

test("buildKernelOptions passes orchestration and context config through shared implementation", async () => {
  const options = await buildKernelOptions("/repo", {}, async () => ({
    apiKey: "sk-gui",
    baseUrl: "https://example.invalid",
    limits: { maxModelCalls: 3 },
    orchestration: { maxRounds: 4, router: { model: { enabled: false } } },
    context: { semantic: { enabled: true, hops: 3 } }
  }));

  assert.deepEqual(options, {
    deepseek: { apiKey: "sk-gui", baseUrl: "https://example.invalid" },
    limits: { maxModelCalls: 3 },
    orchestration: { maxRounds: 4, router: { model: { enabled: false } } },
    context: { semantic: { enabled: true, hops: 3 } }
  });
});

test("buildKernelOptions preserves GUI semantic override over project config", async () => {
  const options = await buildKernelOptions("/repo", {
    context: { semantic: { enabled: false, includeMethodHints: true } }
  }, async () => ({
    apiKey: "sk-gui",
    baseUrl: "https://example.invalid",
    context: { semantic: { enabled: true, hops: 2 } }
  }));

  assert.deepEqual(options.context.semantic, {
    enabled: false,
    hops: 2,
    includeMethodHints: true
  });
});

test("kernel host delegates timeline to V2 session facade", async () => {
  const host = createKernelHost({
    projectRoot: "/repo",
    kernelFactory: async () => ({
      session: {
        subscribe: () => ({ unsubscribe() {} }),
        getTimeline: async (count) => [{ type: "agent:final", count }]
      },
      agent: { send: async () => ({ status: "complete" }), approve: () => {}, interrupt: () => {} },
      context: { snapshot: async () => ({ units: [] }) },
      config: { getPublicConfig: () => ({ runtime: "v2" }) },
      runtime: { getState: () => ({ current: "idle", channel: null }) }
    })
  });

  await host.init();
  assert.deepEqual(await host.getTimeline(3), [{ type: "agent:final", count: 3 }]);
});

test("kernel host approve awaits V2 runtime approval result", async () => {
  const calls = [];
  const host = createKernelHost({
    projectRoot: "/repo",
    kernelFactory: async () => ({
      session: { subscribe: () => ({ unsubscribe() {} }), getTimeline: async () => [] },
      agent: {
        send: async () => ({ status: "awaiting_approval" }),
        approve: async (id, decision) => {
          calls.push([id, decision]);
          return { status: "complete", content: "resumed" };
        },
        interrupt: () => {}
      },
      context: { snapshot: async () => ({ units: [] }) },
      config: { getPublicConfig: () => ({ runtime: "v2" }) },
      runtime: { getState: () => ({ current: "idle", channel: null }) }
    })
  });

  await host.init();
  const result = await host.approve("approval_1", "approve");

  assert.deepEqual(calls, [["approval_1", "approve"]]);
  assert.deepEqual(result, { ok: true, result: { status: "complete", content: "resumed" } });
});

test("kernel host getUsage prefers kernel metrics facade", async () => {
  const usage = {
    requests: 1,
    total_prompt_tokens: 10,
    total_completion_tokens: 2,
    total_reasoning_tokens: 0,
    total_tokens: 12,
    cache_hit_tokens: 7,
    cache_miss_tokens: 3,
    cache_hit_rate: 0.7,
    avg_latency_ms: 5,
    by_channel: {},
    by_model: {}
  };
  const host = createKernelHost({
    projectRoot: "/repo",
    kernelFactory: async () => ({
      session: { subscribe: () => ({ unsubscribe() {} }), getTimeline: async () => [] },
      agent: { send: async () => ({ status: "complete" }), approve: () => {}, interrupt: () => {} },
      context: { snapshot: async () => ({ units: [] }) },
      metrics: { getUsage: () => usage },
      config: { getPublicConfig: () => ({ runtime: "v2" }) },
      runtime: { getState: () => ({ current: "idle", channel: null }) }
    })
  });

  await host.init();

  assert.deepEqual(host.getUsage(), usage);
});

test("kernel host getUsage prefers metrics over modelGateway when both exist", async () => {
  const metricsUsage = { total_tokens: 999, requests: 1 };
  const gatewayUsage = { total_tokens: 111, requests: 1 };
  const host = createKernelHost({
    projectRoot: "/repo",
    kernelFactory: async () => ({
      session: { subscribe: () => ({ unsubscribe() {} }), getTimeline: async () => [] },
      agent: { send: async () => ({ status: "complete" }), approve: () => {}, interrupt: () => {} },
      context: { snapshot: async () => ({ units: [] }) },
      metrics: { getUsage: () => metricsUsage },
      config: { getPublicConfig: () => ({ runtime: "v2" }) },
      runtime: { getState: () => ({ current: "idle", channel: null }) },
      modelGateway: { getUsageStats: () => gatewayUsage }
    })
  });

  await host.init();

  assert.deepEqual(host.getUsage(), metricsUsage);
});

test("kernel host exposes branch and rewind delegates", async () => {
  const host = createKernelHost({
    projectRoot: "/repo",
    kernelFactory: async () => ({
      session: {
        subscribe: () => ({ unsubscribe() {} }),
        getTimeline: async () => [],
        branches: {
          list: async () => [{ branch_id: "br_main" }],
          getActive: async () => ({ branch_id: "br_main" })
        },
        checkpoints: { list: async () => [{ checkpoint_id: "cp_1" }] },
        rewind: {
          preview: async () => ({ status: "success" }),
          apply: async () => ({ status: "success" })
        }
      },
      agent: { send: async () => ({ status: "complete" }), approve: () => {}, interrupt: () => {} },
      context: { snapshot: async () => ({ units: [] }) },
      metrics: { getUsage: () => zeroUsage() },
      config: { getPublicConfig: () => ({}) },
      runtime: { getState: () => ({ current: "idle" }) }
    }),
    configLoader: async () => ({})
  });
  await host.init();

  assert.deepEqual(await host.listBranches(), [{ branch_id: "br_main" }]);
  assert.deepEqual(await host.listCheckpoints(), [{ checkpoint_id: "cp_1" }]);
  assert.equal((await host.rewindPreview({ target: { seq: 1 } })).status, "success");
  assert.equal((await host.rewindApply({ target: { seq: 1 } })).status, "success");
});

test("kernel host exposes active branch delegate", async () => {
  const host = createKernelHost({
    projectRoot: "/repo",
    kernelFactory: async () => ({
      session: {
        subscribe: () => ({ unsubscribe() {} }),
        getTimeline: async () => [],
        branches: {
          list: async () => [{ branch_id: "br_main" }, { branch_id: "br_child" }],
          getActive: async () => ({ branch_id: "br_child" })
        }
      },
      agent: { send: async () => ({ status: "complete" }), approve: () => {}, interrupt: () => {} },
      context: { snapshot: async () => ({ units: [] }) },
      metrics: { getUsage: () => zeroUsage() },
      config: { getPublicConfig: () => ({}) },
      runtime: { getState: () => ({ current: "idle" }) }
    }),
    configLoader: async () => ({})
  });
  await host.init();

  assert.deepEqual(await host.getActiveBranch(), { branch_id: "br_child" });
});

test("gui preferences normalize invalid values to safe defaults", () => {
  const { normalizeGuiPreferences } = require("../../../gui/kernel-host.js");

  // 输入刻意保留退役键 railMode / contextCollapsed(模拟旧偏好文件残留),期望被丢弃。
  assert.deepEqual(normalizeGuiPreferences({
    schema: 99,
    theme: "neon",
    railMode: "unknown",
    contextCollapsed: "yes",
    railCollapsed: "yes",
    transcript: "must not persist"
  }), {
    schema: 1,
    theme: "sumi",
    lastDark: "sumi",
    lastLight: "latte",
    glass: true,
    language: "zh",
    railCollapsed: false,
    statusDisplay: null,
    sidebarWidth: 280,
    rightbarWidth: 0,
    rightbarOpen: false,
    dockTab: "files"
  });
});

test("gui preferences load missing corrupt and save sanitized values", async () => {
  const { loadGuiPreferences, saveGuiPreferences } = require("../../../gui/kernel-host.js");
  const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");

  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-pref-"));
  assert.equal((await loadGuiPreferences(root)).theme, "sumi");

  // 存档时带上退役键:写盘后必须被归一丢弃。
  await saveGuiPreferences(root, { theme: "day", railMode: "branches", contextCollapsed: true, railCollapsed: true, secret: "x" });
  assert.deepEqual(await loadGuiPreferences(root), {
    schema: 1,
    theme: "latte",
    lastDark: "sumi",
    lastLight: "latte",
    glass: true,
    language: "zh",
    railCollapsed: true,
    statusDisplay: null,
    sidebarWidth: 280,
    rightbarWidth: 0,
    rightbarOpen: false,
    dockTab: "files"
  });

  const raw = await readFile(path.join(root, ".deepseek-code", "gui-preferences.json"), "utf8");
  assert.equal(raw.includes("secret"), false);

  await writeFile(path.join(root, ".deepseek-code", "gui-preferences.json"), "{not json");
  assert.equal((await loadGuiPreferences(root)).theme, "sumi");
});

test("kernel host exposes gui preference delegates", async () => {
  const { createKernelHost } = require("../../../gui/kernel-host.js");
  const { mkdtemp } = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");

  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-host-pref-"));
  const host = createKernelHost({
    projectRoot: root,
    kernelFactory: async () => ({
      session: { subscribe: () => ({ unsubscribe() {} }) },
      context: { snapshot: () => ({ units: [] }) },
      config: { getPublicConfig: () => ({}) },
      runtime: { getState: () => ({ current: "idle" }) }
    })
  });
  await host.init();

  await host.setPreferences({ theme: "day", railMode: "timeline" });
  const prefs = await host.getPreferences();
  assert.equal(prefs.theme, "latte");
  assert.equal("railMode" in prefs, false); // v1.8.3:退役键不得落盘
});

test("kernel host exposes project registry + session index delegates", async () => {
  const { createKernelHost } = require("../../../gui/kernel-host.js");
  const { mkdtemp } = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");

  const home = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-host-reg-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-gui-host-proj-"));
  const disposed = [];
  const host = createKernelHost({
    projectRoot: root,
    projectRegistryDir: path.join(home, ".deepseek-code"),
    kernelFactory: async () => ({
      session: { subscribe: () => ({ unsubscribe() {} }) },
      context: { snapshot: () => ({ units: [] }) },
      config: { getPublicConfig: () => ({}) },
      runtime: { getState: () => ({ current: "idle" }) },
      dispose: () => disposed.push(true)
    })
  });
  await host.init();

  assert.deepEqual(await host.listProjects(), []);
  await host.addProject(root);
  const projects = await host.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].root, root);

  await host.switchProject(root);
  assert.equal(disposed.length, 1, "switchProject 应重建 kernel(dispose 一次)");
  assert.equal((await host.listSessions()).length, 0);

  const delRes = await host.deleteSession("dummy-sess-id");
  assert.equal(delRes.ok, true);
  assert.equal(delRes.deleted, false);

  const remRes = await host.removeProject(root);
  assert.equal(remRes.ok, true);
  assert.deepEqual(await host.listProjects(), []);
});
