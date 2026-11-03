// tests/unit/gui/kernel-host.test.js — 宿主桥接(内核宿主/文件/设置/敏感通知/偏好/DOM 契约)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/kernel-host.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/kernel-host", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createRequire } = await import("node:module");
  const { mkdtemp } = await import("../../helpers/tmp.js");

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
      deepseek: { apiKey: "sk-gui", baseUrl: "https://example.invalid" },
      // v1.11.2:GUI 入口默认开启多作用域 MCP 配置(.mcp.json / VS Code servers)
      loadMcpConfigScopes: true
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
      context: { semantic: { enabled: true, hops: 3 } },
      loadMcpConfigScopes: true
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

  // ── v1.11.2:MCP 密钥引用必须能从 GUI host 读写 ──────────────────────────────
  test("kernel host exposes MCP input delegates and degrades before init", async () => {
    const calls = [];
    const host = createKernelHost({
      projectRoot: "/repo",
      kernelFactory: async () => ({
        session: { subscribe: () => ({ unsubscribe() {} }), getTimeline: async () => [] },
        agent: { send: async () => ({ status: "complete" }), approve: () => {}, interrupt: () => {} },
        context: { snapshot: async () => ({ units: [] }) },
        metrics: { getUsage: () => zeroUsage() },
        config: { getPublicConfig: () => ({}) },
        runtime: { getState: () => ({ current: "idle" }) },
        mcp: {
          listServers: () => [],
          listInputs: () => [{ name: "tok", password: true, hasValue: false }],
          setInputValue: (name, value) => {
            calls.push([name, value]);
            return { name, hasValue: true };
          }
        }
      }),
      configLoader: async () => ({})
    });

    // 未 init 前安全降级,不抛错
    assert.deepEqual(host.listMcpInputs(), []);
    assert.equal(host.setMcpInput("tok", "v"), null);

    await host.init();
    assert.deepEqual(host.listMcpInputs(), [{ name: "tok", password: true, hasValue: false }]);
    assert.deepEqual(host.setMcpInput("tok", "secret-v"), { name: "tok", hasValue: true });
    assert.deepEqual(calls, [["tok", "secret-v"]]);
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
    const { readFile, writeFile } = require("node:fs/promises");
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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/kernel-host-changes.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/kernel-host-changes", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { promises: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createRequire } = await import("node:module");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  const require = createRequire(import.meta.url);
  const { createKernelHost } = require("../../../gui/kernel-host.js");

  const DIFF_A = [
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1,2 +1,3 @@",
    " line1",
    "-old",
    "+new",
    "+added",
    ""
  ].join("\n");

  async function tmpProject() {
    const root = await mkdtemp(path.join(os.tmpdir(), "dsc-chg-"));
    await fs.mkdir(path.join(root, ".deepseek-code", "changes"), { recursive: true });
    return root;
  }

  async function seedChange(root, record) {
    const target = path.join(root, ".deepseek-code", "changes", `${record.id}.json`);
    await fs.writeFile(target, JSON.stringify(record, null, 2), "utf8");
  }

  function makeRecord(overrides = {}) {
    return {
      id: "20260702090000-aaaaaa",
      time: "2026-07-02T09:00:00.000Z",
      prompt: "agent edits a",
      diff: DIFF_A,
      summary: [{ path: "src/a.js", status: "modify" }],
      files: [{
        path: "src/a.js", oldPath: "src/a.js", newPath: "src/a.js", status: "modify",
        before: "SECRET_BEFORE_TEXT", after: "SECRET_AFTER_TEXT"
      }],
      ...overrides
    };
  }

  test("listChanges slims records, enriches counts/hunkStarts, marks rollbacks", async () => {
    const root = await tmpProject();
    await seedChange(root, makeRecord());
    await seedChange(root, makeRecord({
      id: "20260702100000-bbbbbb", time: "2026-07-02T10:00:00.000Z", prompt: "GUI edit src/a.js"
    }));
    await fs.writeFile(path.join(root, ".deepseek-code", "rollbacks.jsonl"),
      `${JSON.stringify({ time: "2026-07-02T11:00:00.000Z", id: "20260702090000-aaaaaa", forced: false })}\n`, "utf8");

    const host = createKernelHost({ projectRoot: root });
    const list = await host.listChanges();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "20260702100000-bbbbbb"); // time desc
    const f = list[1].files[0];
    assert.equal(f.added, 2);
    assert.equal(f.removed, 1);
    assert.deepEqual(f.hunkStarts, [1]);
    assert.equal(list[1].rolledBack, true);
    assert.equal(list[0].rolledBack, false);
    const text = JSON.stringify(list);
    assert.ok(!text.includes("SECRET_BEFORE_TEXT"), "list must not carry before text");
    assert.ok(!text.includes("SECRET_AFTER_TEXT"), "list must not carry after text");
    assert.ok(!text.includes("@@ -1,2 +1,3 @@"), "list must not carry raw diff");
  });

  test("describeChange returns single-file slice with before/after + language", async () => {
    const root = await tmpProject();
    await seedChange(root, makeRecord());
    const host = createKernelHost({ projectRoot: root });
    const d = await host.describeChange("20260702090000-aaaaaa", "src/a.js");
    assert.equal(d.id, "20260702090000-aaaaaa");
    assert.equal(d.file.path, "src/a.js");
    assert.equal(d.file.before, "SECRET_BEFORE_TEXT");
    assert.equal(d.file.after, "SECRET_AFTER_TEXT");
    assert.equal(d.file.language, "javascript");
    assert.deepEqual(d.file.hunkStarts, [1]);
    // relPath 缺省 → 首文件;changeId 缺省 → latest
    assert.equal((await host.describeChange("20260702090000-aaaaaa")).file.path, "src/a.js");
    assert.equal((await host.describeChange(null)).id, "20260702090000-aaaaaa");
    await assert.rejects(() => host.describeChange("20260702090000-aaaaaa", "src/missing.js"));
    await assert.rejects(() => host.describeChange("no-such-id"));
  });

  test("graceful: no changes dir → [], unparseable diff → null counts", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "dsc-chg-"));
    const host0 = createKernelHost({ projectRoot: empty });
    assert.deepEqual(await host0.listChanges(), []);

    const root = await tmpProject();
    await seedChange(root, makeRecord({ diff: "not a diff at all" }));
    const host = createKernelHost({ projectRoot: root });
    const list = await host.listChanges();
    assert.equal(list.length, 1);
    assert.equal(list[0].files[0].added, null);
    assert.equal(list[0].files[0].hunkStarts, null);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/kernel-host-fs.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/kernel-host-fs", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { promises: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createRequire } = await import("node:module");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  const require = createRequire(import.meta.url);
  const { createKernelHost } = require("../../../gui/kernel-host.js");

  async function tmpProject() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsc-fs-"));
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "index.js"), "export const x = 1;\n");
    await fs.writeFile(path.join(dir, "README.md"), "# hi\n");
    await fs.mkdir(path.join(dir, "node_modules", "z"), { recursive: true });
    await fs.writeFile(path.join(dir, "node_modules", "z", "a.js"), "junk");
    return dir;
  }

  test("listTree returns project files, excludes node_modules/.git", async () => {
    const host = createKernelHost({ projectRoot: await tmpProject() });
    const files = await host.listTree();
    assert.ok(files.includes("src/index.js"));
    assert.ok(files.includes("README.md"));
    assert.ok(!files.some((f) => f.startsWith("node_modules/")));
  });

  test("readFile returns content + language, rejects escape", async () => {
    const host = createKernelHost({ projectRoot: await tmpProject() });
    const f = await host.readFile("src/index.js");
    assert.match(f.content, /export const x/);
    assert.equal(f.language, "javascript");
    await assert.rejects(() => host.readFile("../../../etc/passwd"));
  });

  test("readFile maps extensions to languages", async () => {
    const host = createKernelHost({ projectRoot: await tmpProject() });
    assert.equal((await host.readFile("README.md")).language, "markdown");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/kernel-host-settings.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/kernel-host-settings", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { promises: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createRequire } = await import("node:module");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  const require = createRequire(import.meta.url);
  const { createKernelHost } = require("../../../gui/kernel-host.js");

  async function tmp() { return mkdtemp(path.join(os.tmpdir(), "dsc-set-")); }

  test("listModels returns ids on ok, throws on error, no default", async () => {
    const host = createKernelHost({ projectRoot: await tmp() });
    const ok = async () => ({ ok: true, json: async () => ({ data: [{ id: "m1" }, { id: "m2" }] }) });
    assert.deepEqual(await host.listModels(null, { fetchImpl: ok, baseUrl: "https://x", apiKey: "k" }), ["m1", "m2"]);
    const bad = async () => ({ ok: false, status: 401, text: async () => "unauthorized" });
    await assert.rejects(() => host.listModels(null, { fetchImpl: bad, baseUrl: "https://x", apiKey: "k" }));
    await assert.rejects(() => host.listModels(null, { fetchImpl: ok, baseUrl: "https://x", apiKey: "" })); // no key → throw, no default
  });

  test("api profiles CRUD + activate writes config; getSettings masks keys", async () => {
    const root = await tmp();
    const host = createKernelHost({ projectRoot: root });
    const p = await host.saveApiProfile({ name: "d", baseUrl: "https://api.deepseek.com", apiKey: "sk-secret-123456", model: "m1" });
    await host.activateApiProfile(p.id);

    const s = await host.getSettings();
    const prof = s.apiProfiles[0];
    assert.equal(prof.hasKey, true);
    assert.equal(prof.name, "d");
    assert.equal(s.activeProfileId, p.id);
    assert.ok(!JSON.stringify(s).includes("sk-secret-123456")); // never plaintext to renderer

    // activate wrote credentials to config.json (so kernel reads them)
    const cfg = JSON.parse(await fs.readFile(path.join(root, ".deepseek-code", "config.json"), "utf8"));
    assert.equal(cfg.apiKey, "sk-secret-123456");

    await host.deleteApiProfile(p.id);
    assert.equal((await host.listApiProfiles()).length, 0);
    const cfgAfter = JSON.parse(await fs.readFile(path.join(root, ".deepseek-code", "config.json"), "utf8"));
    assert.equal(cfgAfter.apiKey, "");
    const sAfter = await host.getSettings();
    assert.equal(sAfter.config.hasApiKey, false);
    assert.equal(sAfter.activeProfileId, null);
  });

  test("writeFile builds a whole-file diff and applies it via the injected edit service", async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, "a.txt"), "one\ntwo\n", "utf8");
    const calls = [];
    const editService = { apply: async ({ diff, prompt }) => { calls.push({ diff, prompt }); return { status: "success" }; } };
    const host = createKernelHost({ projectRoot: root, editService });

    const r = await host.writeFile("a.txt", "one\nTWO\n");
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].diff, /--- a\/a\.txt/);
    assert.match(calls[0].diff, /\+\+\+ b\/a\.txt/);
    assert.match(calls[0].diff, /\+one/);           // new content present
    assert.match(calls[0].prompt, /a\.txt/);
  });

  test("writeFile is a no-op when content is unchanged (no apply)", async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, "b.txt"), "same\n", "utf8");
    let applied = 0;
    const editService = { apply: async () => { applied++; return {}; } };
    const host = createKernelHost({ projectRoot: root, editService });

    const r = await host.writeFile("b.txt", "same\n");
    assert.equal(r.unchanged, true);
    assert.equal(applied, 0);
  });

  test("writeFile refuses paths outside the workspace / missing files", async () => {
    const root = await tmp();
    const editService = { apply: async () => ({}) };
    const host = createKernelHost({ projectRoot: root, editService });

    const escape = await host.writeFile("../evil.txt", "x");
    assert.ok(escape.error);                          // boundary rejection
    const missing = await host.writeFile("nope.txt", "x");
    assert.ok(missing.error);                          // file must exist to diff against
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/kernel-host-sensitive-notice.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/kernel-host-sensitive-notice", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createRequire } = await import("node:module");

  const require = createRequire(import.meta.url);
  const { createKernelHost } = require("../../../gui/kernel-host.js");

  // 造一个假 kernel 工厂,把 createKernel 收到的 options 抓出来
  function hostWithCapturedOptions(pushed) {
    let captured = null;
    const host = createKernelHost({
      projectRoot: process.cwd(),
      kernelFactory: async (_root, options) => {
        captured = options;
        return { session: { subscribe: () => ({ unsubscribe() {} }) } };
      },
      configLoader: async () => ({}),
      pushEvent: (event) => pushed.push(event)
    });
    return { host, options: () => captured };
  }

  test("kernel host injects an onSensitiveNotice handler into the kernel", async () => {
    const pushed = [];
    const { host, options } = hostWithCapturedOptions(pushed);
    await host.init();
    assert.equal(typeof options().onSensitiveNotice, "function", "GUI 必须给内核接上提醒回调");
  });

  test("a sensitive notice is pushed to the renderer and resolves on response", async () => {
    const pushed = [];
    const { host, options } = hostWithCapturedOptions(pushed);
    await host.init();

    const pending = options().onSensitiveNotice({
      paths: [{ path: ".env", reason: "secret-file" }],
      recordDir: ".deepseek-code/changes"
    });

    const request = pushed.find((e) => e.type === "gui:sensitive_notice");
    assert.ok(request, "应向渲染层推送提醒请求");
    assert.ok(request.request_id, "请求必须带 id 以便作答");
    assert.equal(request.descriptor.paths[0].path, ".env");
    assert.equal(request.descriptor.severity, "danger");

    assert.equal(host.resolveSensitiveNotice(request.request_id, true), true);
    assert.equal(await pending, true);
  });

  test("responding false refuses the edit", async () => {
    const pushed = [];
    const { host, options } = hostWithCapturedOptions(pushed);
    await host.init();
    const pending = options().onSensitiveNotice({ paths: [{ path: ".env", reason: "secret-file" }] });
    const request = pushed.find((e) => e.type === "gui:sensitive_notice");
    host.resolveSensitiveNotice(request.request_id, false);
    assert.equal(await pending, false);
  });

  // 只有严格 true 才放行 —— 渲染层传来的任何其它值都按拒绝处理
  test("only a strict true from the renderer allows the write", async () => {
    const pushed = [];
    const { host, options } = hostWithCapturedOptions(pushed);
    await host.init();
    for (const answer of ["true", 1, {}, null, undefined]) {
      const pending = options().onSensitiveNotice({ paths: [{ path: ".env", reason: "secret-file" }] });
      const req = pushed[pushed.length - 1];
      host.resolveSensitiveNotice(req.request_id, answer);
      assert.equal(await pending, false, `${String(answer)} 不得被当作同意`);
    }
  });

  test("unknown request ids are ignored (no hang, no crash)", async () => {
    const pushed = [];
    const { host } = hostWithCapturedOptions(pushed);
    await host.init();
    assert.equal(host.resolveSensitiveNotice("sn_does_not_exist", true), false);
  });

  // dispose 必须把未决提问按拒绝收口,否则关窗后主进程会永远挂在 await 上
  test("dispose refuses any pending notice instead of hanging", async () => {
    const pushed = [];
    const { host, options } = hostWithCapturedOptions(pushed);
    await host.init();
    const pending = options().onSensitiveNotice({ paths: [{ path: ".env", reason: "secret-file" }] });
    host.dispose();
    assert.equal(await pending, false, "dispose 后未决提问必须按拒绝收口");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/kernel-loads.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/kernel-loads", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { buildInitialLoads, branchesAction, eventToAction, errorToAction, refreshLoadsFor } = await import("../../../gui/src/hooks/kernel-loads.js");

  test("buildInitialLoads maps single-call apis to reducer actions", () => {
    const byCall = Object.fromEntries(buildInitialLoads().map((c) => [c.call, c]));
    assert.ok(byCall.getPreferences && byCall.listCheckpoints && byCall.getUsage && byCall.getState);
    assert.equal(byCall.getPreferences.toAction({ theme: "day" }).type, "preferences_loaded");
    assert.equal(byCall.getPreferences.toAction({ theme: "day" }).preferences.theme, "day");
    assert.equal(byCall.listCheckpoints.toAction([{ seq: 1 }]).type, "checkpoints_loaded");
    assert.equal(byCall.getUsage.toAction({ requests: 3 }).type, "usage_loaded");
    assert.equal(byCall.getState.toAction({ current: "idle" }).type, "runtime_loaded");
    assert.equal(byCall.getSettings.toAction({ config: { model: "m1", hasApiKey: true } }).type, "settings_loaded");
    assert.equal(byCall.getSettings.toAction({ config: { model: "m1" } }).config.model, "m1");
  });

  test("branchesAction combines list + active branch", () => {
    const a = branchesAction([{ branch_id: "br_x" }], "br_x");
    assert.equal(a.type, "branches_loaded");
    assert.equal(a.activeBranchId, "br_x");
    assert.equal(a.branches.length, 1);
    assert.equal(branchesAction(null, null).activeBranchId, "br_main");
  });

  test("eventToAction wraps a kernel event", () => {
    assert.deepEqual(eventToAction({ type: "agent:step" }), { type: "event_received", event: { type: "agent:step" } });
    assert.deepEqual(eventToAction(null), { type: "event_received", event: {} });
  });

  test("errorToAction reports area with a short message", () => {
    const a = errorToAction("branches", new Error("boom"));
    assert.equal(a.type, "error_reported");
    assert.equal(a.area, "branches");
    assert.match(a.message, /boom/);
  });

  test("refreshLoadsFor re-pulls usage + checkpoints on turn end, nothing otherwise", () => {
    for (const type of ["agent:final", "agent:error", "turn:cancelled", "file:rollback_applied"]) {
      const calls = refreshLoadsFor(type).map((l) => l.call).sort();
      assert.deepEqual(calls, ["getUsage", "listCheckpoints"], type);
    }
    assert.deepEqual(refreshLoadsFor("model:request"), []);
    assert.deepEqual(refreshLoadsFor("agent:step"), []);
    assert.deepEqual(refreshLoadsFor(undefined), []);
    // toAction 与首屏加载同形状,reducer 无需新 action
    const usage = refreshLoadsFor("agent:final").find((l) => l.call === "getUsage");
    assert.equal(usage.toAction({ requests: 1 }).type, "usage_loaded");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/gui-preferences-language.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/gui-preferences-language", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createRequire } = await import("node:module");

  const require = createRequire(import.meta.url);
  const { normalizeGuiPreferences } = require("../../../gui/kernel-host.js");

  test("normalizeGuiPreferences persists language (default zh)", () => {
    assert.equal(normalizeGuiPreferences({}).language, "zh");
    assert.equal(normalizeGuiPreferences({ language: "en" }).language, "en");
    assert.equal(normalizeGuiPreferences({ language: "fr" }).language, "zh");
  });

  test("normalizeGuiPreferences keeps existing fields and drops retired keys (no regression)", () => {
    const p = normalizeGuiPreferences({ theme: "day", railMode: "branches", contextCollapsed: true });
    assert.equal(p.theme, "latte");
    assert.equal(p.language, "zh");
    // v1.8.3:railMode / contextCollapsed 随 v1.8.1 三列壳层退役 —— 旧偏好文件里的残留键必须被丢弃
    assert.equal("railMode" in p, false);
    assert.equal("contextCollapsed" in p, false);
  });

  test("normalizeGuiPreferences persists railCollapsed (default false)", () => {
    assert.equal(normalizeGuiPreferences({}).railCollapsed, false);
    assert.equal(normalizeGuiPreferences({ railCollapsed: true }).railCollapsed, true);
    assert.equal(normalizeGuiPreferences({ railCollapsed: "yes" }).railCollapsed, false);
  });

  test("normalizeGuiPreferences resets cross-group and non-boolean theme memory to defaults", () => {
    const p = normalizeGuiPreferences({ lastDark: "snow", lastLight: "sumi", glass: "yes" });
    assert.equal(p.lastDark, "sumi");
    assert.equal(p.lastLight, "latte");
    assert.equal(p.glass, true);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/dom-contract.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/dom-contract", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFileSync } = await import("node:fs");

  const read = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

  test("frozen DOM/CSS contracts survive (v1.8.1 B4 冻结清单)", () => {
    const app = read("gui/src/App.jsx"), rail = read("gui/src/components/v4/Rail.jsx");
    const metrics = read("gui/src/components/v4/MetricsLine.jsx"), sn = read("gui/src/components/v4/SensitiveNoticeModal.jsx");
    const themeCss = read("gui/src/styles/theme.css"), main = read("gui/main.js");
    const appFrame = read("gui/src/components/v4/AppFrame.jsx");
    assert.match(app, /setAttribute\("theme", state\.theme\)/);
    // v1.8.3(I2):`shell` / `rail-off` 是**无样式的结构钩子** —— 布局由 AppFrame.module.css 的
    // .frame + 内联 gridTemplateColumns 承担,这两个类名目前在 gui/src 的任何 CSS 里都没有规则。
    // 此处保留断言以冻结 DOM,但请勿据此认为它们有视觉作用;若将来要删除,需同步改本行。
    assert.match(app, /className=\{`shell\$\{state\.railCollapsed \? " rail-off" : ""\}`\}/);
    for (const cls of ["rail-fn", "rail-scroll", "rail-foot", "rail-new"]) assert.match(rail, new RegExp(`className=\\{?[\`"']${cls}`), cls);
    assert.match(metrics, /"cz-meta"/);
    assert.match(metrics, /data-mv=/);
    assert.match(sn, /className="sn-backdrop" role="dialog" aria-modal="true"/);
    assert.ok(sn.indexOf("sn-refuse") < sn.indexOf("sn-allow"), "拒绝键须在允许键之前");
    assert.match(sn, /sn-refuse" autoFocus/);
    assert.match(themeCss, /--titlebar:40px/);
    assert.match(appFrame, /data-windows-titlebar/);
    assert.match(appFrame, /data-rightbar-col/);
    for (const sel of [
      ".ide", "[data-windows-titlebar]", ".rail", ".pane",
      ".rail-fn", ".cz-input", "[data-rightbar-col]", ".rail-foot"
    ]) {
      assert.ok(main.includes(`querySelector(${JSON.stringify(sel)})`) || main.includes(`querySelector('${sel}')`),
        `smoke 门选择器 ${sel}`);
    }
    assert.ok(!/TitleBar|shell-settings|view === "settings"|view === "changes"|view === "recovery"|ChangesView|RecoveryView/.test(app),
      "B4 后 App 不得出现 TitleBar / shell-settings / 旧路由");
    assert.ok(!existsSync(new URL("../../../gui/src/components/TitleBar.jsx", import.meta.url)));
    assert.ok(!existsSync(new URL("../../../gui/src/styles/shell.css", import.meta.url)));
    assert.ok(!existsSync(new URL("../../../gui/src/components/Settings/ThemeHub.jsx", import.meta.url)));
  });

  test("v1.13.0:MCP 工具治理的 DOM 契约(风险徽章 / 信任开关 / 风险来源)", () => {
    const mcp = read("gui/src/components/v4/SecondaryViews.jsx");
    const themeCss = read("gui/src/styles/theme.css");

    // 风险徽章:destructive 必须用 danger 色(区别于 read / mutate)
    assert.match(mcp, /tDef\.badge\?\.level === "danger"/);
    assert.match(mcp, /tDef\.badge\?\.label \|\| tDef\.category/);

    // 信任开关:决定是否采纳 server 自报的 annotations
    assert.match(mcp, /mcp-trust-row/);
    assert.match(mcp, /trustServer \? \{ trust: true \} : \{\}/, "两处提交都要带 trust");
    assert.match(themeCss, /\.mcp-trust-row/);

    // 风险来源要可解释:不受信忽略 annotations / 受信采纳
    assert.match(mcp, /该 server 未受信,自报 annotations 已忽略/);
    assert.match(mcp, /风险判定来自受信 server 的 annotations/);

    // 持久放行徽章(project / always)
    assert.match(mcp, /永久放行/);
    assert.match(mcp, /本项目放行/);
  });

  function existsSync(url) {
    try { readFileSync(url); return true; } catch { return false; }
  }
});
