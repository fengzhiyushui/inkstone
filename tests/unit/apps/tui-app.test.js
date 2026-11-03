// tests/unit/apps/tui-app.test.js — TUI 应用主循环(斜杠命令/配置/M3 处理器/会话动作/恢复清理)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/tui-app.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/tui-app", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createTuiApp } = await import("../../../src/apps/tui/tui-app.js");
  const { loadTuiPrefs, saveTuiPrefs } = await import("../../../src/apps/tui/prefs.js");
  const { makeIO, makeFakeKernel, until, tmpRoot } = await import("./helpers.js");

  test("prefs roundtrip", async () => {
    const root = await tmpRoot();
    assert.deepEqual(await loadTuiPrefs(root), {});
    await saveTuiPrefs(root, { lang: "en" });
    assert.deepEqual(await loadTuiPrefs(root), { lang: "en" });
  });

  test("full streaming round: echo, deltas, final, history", async () => {
    const io = makeIO();
    const sends = [];
    const kernel = makeFakeKernel({
      onSend: async ({ text, options }) => {
        sends.push({ text, options });
        options.onDelta("你好");
        options.onDelta("世界");
        return { status: "complete", content: "你好世界" };
      }
    });
    const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    io.input.write("hi\r");
    await until(() => io.text().includes("你好世界"));
    assert.match(io.text(), /❯ hi/);
    assert.equal(sends[0].options.autonomy, "gated");
    assert.equal(sends[0].options.stream, true);
    io.input.write("again\r");
    await until(() => sends.length === 2);
    assert.equal(sends[1].options.history.length, 2); // 上一轮 user+assistant
    assert.equal(sends[1].options.history[0].content, "hi");
    io.input.write("\x03");
    io.input.write("\x03");
    await done;
    assert.ok(io.text().includes("\x1b[?2004l")); // pasteOff
    assert.ok(io.text().includes("\x1b[?25h"));   // showCursor
    assert.equal(kernel.disposed, false);          // 注入的 kernel 不由 app dispose
  });

  test("busy Esc interrupts current turn and input becomes usable again", async () => {
    const io = makeIO();
    let rejectPending = null;
    let interrupts = 0;
    const sends = [];
    const kernel = makeFakeKernel({
      onSend: ({ text }) => {
        sends.push(text);
        if (sends.length > 1) return Promise.resolve({ status: "complete", content: "next done" });
        return new Promise((resolve, reject) => { rejectPending = reject; });
      },
      onInterrupt: () => {
        interrupts += 1;
        const error = new Error("turn was interrupted");
        error.code = "INTERRUPTED";
        rejectPending?.(error);
      }
    });
    const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    io.input.write("long task\r");
    await until(() => sends.length === 1);
    io.input.write("\x1b");
    await until(() => interrupts === 1);
    await until(() => io.text().includes("已中断当前回合"));
    io.input.write("next\r");
    await until(() => sends.length === 2);
    await until(() => io.text().includes("next done"));
    io.input.write("\x03"); io.input.write("\x03");
    await done;
  });

  test("approval flow: y approves, esc denies", async () => {
    const io = makeIO();
    const approvals = [];
    let phase = 0;
    const kernel = makeFakeKernel({
      onSend: async ({ emit }) => {
        phase += 1;
        emit({ type: "approval:requested", approval: { id: `ap_${phase}`, summary: `write file ${phase}` } });
        return { status: "awaiting_approval", approval: { id: `ap_${phase}`, summary: `write file ${phase}` } };
      },
      onApprove: async ({ id, decision }) => {
        approvals.push({ id, decision });
        return { status: "complete", content: "done" };
      }
    });
    const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    io.input.write("do it\r");
    await until(() => io.text().includes("审批"));
    io.input.write("y");
    await until(() => approvals.length === 1);
    assert.deepEqual(approvals[0], { id: "ap_1", decision: "approve" });
    io.input.write("redo\r");
    await until(() => io.text().includes("write file 2")); // 第二轮审批卡片可见(按轮次区分,避免重绘计数竞态)
    io.input.write("\x1b"); // Esc → deny
    await until(() => approvals.length === 2);
    assert.equal(approvals[1].decision, "deny");
    io.input.write("\x03");
    io.input.write("\x03");
    await done;
  });

  test("v1.13.1:审批按键同时决定放行范围(p=本项目 / a=永久 / y=仅本次)", async () => {
    const io = makeIO();
    const approvals = [];
    let phase = 0;
    const kernel = makeFakeKernel({
      onSend: async ({ emit }) => {
        phase += 1;
        const approval = { id: `ap_${phase}`, summary: `write file ${phase}`, category: "mutate" };
        emit({ type: "approval:requested", approval });
        return { status: "awaiting_approval", approval };
      },
      onApprove: async ({ id, decision, scope }) => {
        approvals.push({ id, decision, scope });
        return { status: "complete", content: "done" };
      }
    });
    const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
    const done = app.run();
    await until(() => io.text().includes("❯"));

    // 第一轮:输入命令进入审批,按 p → 本项目
    io.input.write("do it\r");
    await until(() => io.text().includes("write file 1"));
    io.input.write("p");
    await until(() => approvals.length === 1);
    assert.deepEqual(approvals[0], { id: "ap_1", decision: "approve", scope: "project" });

    // 第二轮:按 a → 永久
    io.input.write("again\r");
    await until(() => io.text().includes("write file 2"));
    io.input.write("a");
    await until(() => approvals.length === 2);
    assert.deepEqual(approvals[1], { id: "ap_2", decision: "approve", scope: "always" });

    // 与既有审批用例相同的方式收尾:两次 ctrl_c 让 app 退出,避免 stdin 监听泄漏到
    // 后续用例造成互相抢按键。
    io.input.write("\x03");
    io.input.write("\x03");
    await done;
  });

  test("v1.13.1:destructive 工具按 a 也退化为仅本次", async () => {
    const io = makeIO();
    const approvals = [];
    const kernel = makeFakeKernel({
      onSend: async ({ emit }) => {
        const approval = { id: "ap_d", summary: "wipe db", category: "destructive" };
        emit({ type: "approval:requested", approval });
        return { status: "awaiting_approval", approval };
      },
      onApprove: async ({ id, decision, scope }) => {
        approvals.push({ id, decision, scope });
        return { status: "complete", content: "done" };
      }
    });
    const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
    const done = app.run();
    await until(() => io.text().includes("❯"));

    io.input.write("wipe\r");
    await until(() => io.text().includes("审批"));
    io.input.write("a"); // 用户请求永久,但 destructive 必须退化
    await until(() => approvals.length === 1);
    assert.equal(approvals[0].decision, "approve");
    assert.equal(approvals[0].scope, "session", "destructive 不可持久放行");
    io.input.write("\x03");
    io.input.write("\x03");
    await done;
  });

  test("kernel events render as cards; ctrl_c single press hints", async () => {
    const io = makeIO();
    const kernel = makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) });
    const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    kernel.emit({ type: "tool:call", call: { name: "read", args: { path: "a.js" } } });
    await until(() => io.text().includes("tool ▸ read"));
    io.input.write("\x03");
    await until(() => io.text().includes("再按一次"));
    await new Promise((r) => setTimeout(r, 20));
    io.input.write("\x03"); // 20ms 内第二次 → 退出
    await done;
  });

  test("offline kernel: banner + offline notice on submit", async () => {
    const io = makeIO();
    const app = createTuiApp({
      root: await tmpRoot(),
      input: io.input,
      output: io.output,
      createKernelImpl: async () => { throw new Error("no key"); },
      buildKernelOptionsImpl: async () => ({})
    });
    const done = app.run();
    await until(() => io.text().includes("内核不可用"));
    io.input.write("hello\r");
    await until(() => io.text().split("内核不可用").length > 2);
    io.input.write("\x03");
    io.input.write("\x03");
    await done;
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/tui-app-slash.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/tui-app-slash", async () => {
  // tests/unit/tui/tui-app-slash.test.js — slash 命令接线全链路(注入 IO + mock kernel)。


  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createTuiApp } = await import("../../../src/apps/tui/tui-app.js");
  const { loadTuiPrefs } = await import("../../../src/apps/tui/prefs.js");
  const { makeIO, makeFakeKernel, until, tmpRoot } = await import("./helpers.js");

  test("/help lists registered commands", async () => {
    const io = makeIO();
    const kernel = makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) });
    const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    io.input.write("/help\r");
    await until(() => io.text().includes("/quit"));
    assert.match(io.text(), /\/mode/);
    io.input.write("\x03"); io.input.write("\x03");
    await done;
  });

  test("typing / opens filtered menu; tab completes; enter runs selection", async () => {
    const io = makeIO();
    const kernel = makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) });
    const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    io.input.write("/cl");
    await until(() => io.text().includes("/clear"));
    io.input.write("\t"); // Tab 补全
    io.input.write("\r");
    await until(() => io.text().includes("已清空会话上下文"));
    io.input.write("\x03"); io.input.write("\x03");
    await done;
  });

  test("/mode auto changes autonomy for next send; bad arg rejected", async () => {
    const io = makeIO();
    const sends = [];
    const kernel = makeFakeKernel({ onSend: async ({ text, options }) => { sends.push(options); return { status: "complete", content: "" }; } });
    const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    io.input.write("/mode auto\r");
    await until(() => io.text().includes("模式:auto"));
    io.input.write("go\r");
    await until(() => sends.length === 1);
    assert.equal(sends[0].autonomy, "auto");
    io.input.write("/mode bogus\r");
    await until(() => io.text().includes("模式必须是"));
    io.input.write("\x03"); io.input.write("\x03");
    await done;
  });

  test("/clear wipes conversation history", async () => {
    const io = makeIO();
    const sends = [];
    const kernel = makeFakeKernel({ onSend: async ({ options }) => { sends.push(options); return { status: "complete", content: "r" }; } });
    const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    io.input.write("one\r");
    await until(() => sends.length === 1);
    io.input.write("/clear\r");
    await until(() => io.text().includes("已清空"));
    io.input.write("two\r");
    await until(() => sends.length === 2);
    assert.equal(sends[1].history.length, 0);
    io.input.write("\x03"); io.input.write("\x03");
    await done;
  });

  test("/lang en switches ui language and persists", async () => {
    const io = makeIO();
    const root = await tmpRoot();
    const kernel = makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) });
    const app = createTuiApp({ root, kernel, input: io.input, output: io.output });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    io.input.write("/lang en\r");
    await until(() => io.text().includes("Language: English"));
    assert.equal((await loadTuiPrefs(root)).lang, "en");
    io.input.write("\x03"); io.input.write("\x03");
    await done;
  });

  test("/diff renders injected diff; /quit exits", async () => {
    const io = makeIO();
    const kernel = makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) });
    const app = createTuiApp({
      root: await tmpRoot(), kernel, input: io.input, output: io.output,
      showDiffImpl: async () => "+added line\n-removed line"
    });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    io.input.write("/diff\r");
    await until(() => io.text().includes("+added line"));
    io.input.write("/quit\r");
    await done;
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/tui-app-config.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/tui-app-config", async () => {
  // tests/unit/tui/tui-app-config.test.js — /config 全链路(共享存储/激活重建/掩码不上屏)。


  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createTuiApp } = await import("../../../src/apps/tui/tui-app.js");
  const { createApiProfiles } = await import("../../../src/apps/api-profiles.js");
  const { makeIO, makeFakeKernel, until, tmpRoot } = await import("./helpers.js");
  const { default: path } = await import("node:path");

  function fakeKernelFactory(log) {
    return async () => {
      log.created += 1;
      return makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) });
    };
  }

  test("/config add-new flow saves profile to shared store; key never echoed", async () => {
    const io = makeIO();
    const root = await tmpRoot();
    const log = { created: 0 };
    const app = createTuiApp({
      root, input: io.input, output: io.output,
      createKernelImpl: fakeKernelFactory(log), buildKernelOptionsImpl: async () => ({})
    });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    io.input.write("/config\r");
    await until(() => io.text().includes("+ 新增配置"));
    io.input.write("\r");                    // 选「新增」(空列表 index=0)
    await until(() => io.text().includes("名称"));
    io.input.write("p1\r");                  // name → 下一项
    io.input.write("\r");                    // baseUrl 保默认 → 下一项
    io.input.write("sk-1234567890abcd\r");   // apiKey → 下一项
    io.input.write("deepseek-chat\r");       // model,最后一项 Enter = 保存
    await until(() => io.text().includes("配置已保存"));
    assert.doesNotMatch(io.text(), /sk-1234567890abcd/); // 明文永不上屏
    const store = createApiProfiles({ dir: path.join(root, ".deepseek-code") });
    const profiles = await store.list();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].apiKey, "sk-1234567890abcd"); // 明文只在盘上
    io.input.write("\x1b");                  // Esc 回列表
    io.input.write("\x1b");                  // Esc 关闭 config
    io.input.write("\x03"); io.input.write("\x03");
    await done;
  });

  test("activate writes config and rebuilds kernel keeping history", async () => {
    const io = makeIO();
    const root = await tmpRoot();
    const store = createApiProfiles({ dir: path.join(root, ".deepseek-code") });
    const saved = await store.save({ name: "main", baseUrl: "https://x", apiKey: "sk-aaaaaaaaaa", model: "m9" });
    const log = { created: 0 };
    const patches = [];
    const app = createTuiApp({
      root, input: io.input, output: io.output,
      createKernelImpl: fakeKernelFactory(log), buildKernelOptionsImpl: async () => ({}),
      configureProjectImpl: async (r, patch) => { patches.push(patch); return { target: "x", config: patch }; }
    });
    const done = app.run();
    await until(() => log.created === 1);
    io.input.write("/config\r");
    await until(() => io.text().includes("main"));
    io.input.write("\r");                    // 选中 profile → actions
    await until(() => io.text().includes("激活"));
    io.input.write("\r");                    // 激活(actionIndex=0)
    await until(() => io.text().includes("已激活:main"));
    assert.equal(patches[0].apiKey, "sk-aaaaaaaaaa");
    assert.equal(patches[0].model, "m9");
    assert.equal(log.created, 2);            // kernel 重建
    assert.equal((await store.getActive()).id, saved.id);
    io.input.write("\x03"); io.input.write("\x03");
    await done;
  });

  test("models fetch failure shows red error, no default injected", async () => {
    const io = makeIO();
    const root = await tmpRoot();
    const store = createApiProfiles({ dir: path.join(root, ".deepseek-code") });
    await store.save({ name: "main", baseUrl: "https://x", apiKey: "sk-bbbbbbbbbb", model: "" });
    const log = { created: 0 };
    const app = createTuiApp({
      root, input: io.input, output: io.output,
      createKernelImpl: fakeKernelFactory(log), buildKernelOptionsImpl: async () => ({}),
      fetchModelIdsImpl: async () => { throw new Error("401 denied"); }
    });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    io.input.write("/config\r");
    await until(() => io.text().includes("main"));
    io.input.write("\r");
    await until(() => io.text().includes("拉取模型列表"));
    io.input.write("\x1b[B\x1b[B");          // ↓↓ 到「拉取模型列表」
    io.input.write("\r");
    await until(() => io.text().includes("模型拉取失败"));
    assert.match(io.text(), /401 denied/);
    io.input.write("\x03"); io.input.write("\x03");
    await done;
  });

  test("connection test success shows notice", async () => {
    const io = makeIO();
    const root = await tmpRoot();
    const store = createApiProfiles({ dir: path.join(root, ".deepseek-code") });
    await store.save({ name: "main", baseUrl: "https://x", apiKey: "sk-cccccccccc", model: "m" });
    const app = createTuiApp({
      root, input: io.input, output: io.output,
      createKernelImpl: fakeKernelFactory({ created: 0 }), buildKernelOptionsImpl: async () => ({}),
      testConnectionImpl: async () => true
    });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    io.input.write("/config\r");
    await until(() => io.text().includes("main"));
    io.input.write("\r");
    io.input.write("\x1b[B\x1b[B\x1b[B");    // ↓↓↓ 到「连接测试」
    io.input.write("\r");
    await until(() => io.text().includes("连接测试通过"));
    io.input.write("\x03"); io.input.write("\x03");
    await done;
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/tui-m3-handlers.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/tui-m3-handlers", async () => {
  // tests/unit/tui/tui-m3-handlers.test.js — v1.9.0 M3 A6/A3:/branch /rewind /fim 执行器全链路
  // (注入 IO + mock kernel;解析/格式化由 session-actions.js 纯逻辑承担,这里只验证接线)。

  // 在基础 fake kernel 上按需挂 branches / checkpoints / rewind / fim 面。

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createTuiApp } = await import("../../../src/apps/tui/tui-app.js");
  const { STRINGS } = await import("../../../src/apps/tui/tui-i18n.js");
  const { makeIO, makeFakeKernel, until, tmpRoot } = await import("./helpers.js");

  function kernelWith({ branches, checkpoints, rewind, fim } = {}) {
    const kernel = makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) });
    if (branches) kernel.session.branches = branches;
    if (checkpoints) kernel.session.checkpoints = checkpoints;
    if (rewind) kernel.session.rewind = rewind;
    if (fim) kernel.fim = fim;
    return kernel;
  }

  async function boot(kernel) {
    const io = makeIO();
    const app = createTuiApp({ root: await tmpRoot(), kernel, input: io.input, output: io.output });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    return { io, done };
  }

  async function quit(io, done) {
    io.input.write("\x03");
    io.input.write("\x03");
    await done;
  }

  const BRANCHES = {
    calls: [],
    list: async () => [
      { branch_id: "br_main", label: "main", parent_branch_id: null, created_at: "2026-09-24T00:00:00Z" },
      { branch_id: "br_side", label: "side quest", parent_branch_id: "br_main", created_at: "2026-09-24T01:00:00Z" }
    ],
    getActive: async () => ({ branch_id: "br_main", label: "main", parent_branch_id: null }),
    create: async (input) => { BRANCHES.calls.push(["create", input]); return { branch_id: "br_fresh", label: input?.label || "", parent_branch_id: "br_main" }; },
    activate: async (id) => { BRANCHES.calls.push(["activate", id]); return { branch_id: id, label: "switched side", parent_branch_id: "br_main" }; }
  };

  const CHECKPOINTS = {
    list: async () => [
      { checkpoint_id: "cp_late", branch_id: "br_main", seq: 2, turn_id: "turn_2", timestamp: "T2" },
      { checkpoint_id: "cp_early", branch_id: "br_main", seq: 1, type: "event", label: "after turn_1", ts: "T1" }
    ]
  };

  const REWIND = {
    calls: [],
    preview: async (input) => {
      REWIND.calls.push(["preview", input]);
      return {
        status: "success", target: { turn_id: "turn_1", seq: 5, event_id: "ev_1" },
        current_branch_id: "br_main", planned_branch_id: "br_plan",
        rollback_change_ids: ["chg_1", "chg_2"], rollback_count: 2, files: ["a.txt", "b.txt"]
      };
    },
    apply: async (input) => {
      REWIND.calls.push(["apply", input]);
      return { status: "success", previous_branch_id: "br_main", branch_id: "br_plan", applied_rollbacks: ["chg_1", "chg_2"], files: ["a.txt"], forced: false };
    }
  };

  const FIM = {
    calls: [],
    complete: async (prefix) => { FIM.calls.push(prefix); return { content: "hello();\nworld();", model: "deepseek-flash", usage: { total_tokens: 7 } }; }
  };

  test("session-actions contract keys exist in both dictionaries", () => {
    for (const key of ["msg.branchEmpty", "msg.checkpointEmpty", "msg.fimUsage"]) {
      assert.ok(STRINGS.zh[key], `zh missing ${key}`);
      assert.ok(STRINGS.en[key], `en missing ${key}`);
    }
  });

  test("/branch lists formatted branches with current marker", async () => {
    const { io, done } = await boot(kernelWith({ branches: BRANCHES }));
    io.input.write("/branch\r");
    await until(() => io.text().includes("side quest"));
    assert.match(io.text(), /br_main {2}main {2}●/); // 当前分支带 ● 标记(formatter 排序:br_main < br_side)
    assert.match(io.text(), /br_side {2}side quest {2}$/m); // 非当前分支标记段为空
    await quit(io, done);
  });

  test("/branch switch activates branch and prints success line", async () => {
    BRANCHES.calls.length = 0;
    const { io, done } = await boot(kernelWith({ branches: BRANCHES }));
    io.input.write("/branch switch br_side\r");
    await until(() => io.text().includes("已切换分支"));
    assert.deepEqual(BRANCHES.calls, [["activate", "br_side"]]);
    assert.match(io.text(), /已切换分支:br_side\(switched side\)/);
    await quit(io, done);
  });

  test("/branch new creates branch with multi-word label", async () => {
    BRANCHES.calls.length = 0;
    const { io, done } = await boot(kernelWith({ branches: BRANCHES }));
    io.input.write("/branch new hotfix pass\r");
    await until(() => io.text().includes("已创建分支"));
    assert.deepEqual(BRANCHES.calls, [["create", { label: "hotfix pass" }]]);
    assert.match(io.text(), /已创建分支:br_fresh\(hotfix pass\)/);
    await quit(io, done);
  });

  test("/branch with bad verb prints usage line", async () => {
    const { io, done } = await boot(kernelWith({ branches: BRANCHES }));
    io.input.write("/branch bogus\r");
    await until(() => io.text().includes("用法:/branch"));
    await quit(io, done);
  });

  test("/branch degrades to offline banner without kernel.session.branches", async () => {
    const { io, done } = await boot(makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) }));
    io.input.write("/branch\r");
    await until(() => io.text().includes("内核不可用"));
    assert.doesNotMatch(io.text(), /用法:\/branch/);
    await quit(io, done);
  });

  test("/rewind list prints formatted checkpoint lines", async () => {
    const { io, done } = await boot(kernelWith({ checkpoints: CHECKPOINTS, rewind: REWIND }));
    io.input.write("/rewind\r");
    await until(() => io.text().includes("cp_late"));
    assert.match(io.text(), /cp_early {2}seq 1 {2}T1/); // 按 seq 升序;无 turn_id → seq 摘要
    assert.match(io.text(), /cp_late {2}turn turn_2 {2}T2/);
    await quit(io, done);
  });

  test("/rewind preview resolves checkpoint id to kernel target and prints plan summary", async () => {
    REWIND.calls.length = 0;
    const kernel = kernelWith({
      branches: BRANCHES,
      checkpoints: { list: async () => [{ checkpoint_id: "cp_1", branch_id: "br_main", event_id: "ev_1", turn_id: "turn_1", seq: 5 }] },
      rewind: REWIND
    });
    const { io, done } = await boot(kernel);
    io.input.write("/rewind preview cp_1\r");
    await until(() => io.text().includes("回退预览"));
    assert.deepEqual(REWIND.calls, [["preview", { target: { event_id: "ev_1", turn_id: "turn_1", seq: 5 } }]]);
    assert.match(io.text(), /回退预览:回退 2 项变更 · 涉及 2 个文件 · 目标分支 br_plan/);
    await quit(io, done);
  });

  test("/rewind apply prints result summary", async () => {
    REWIND.calls.length = 0;
    const kernel = kernelWith({
      checkpoints: { list: async () => [{ checkpoint_id: "cp_1", branch_id: "br_main", event_id: "ev_1", turn_id: "turn_1", seq: 5 }] },
      rewind: REWIND
    });
    const { io, done } = await boot(kernel);
    io.input.write("/rewind apply cp_1\r");
    await until(() => io.text().includes("回退完成"));
    assert.equal(REWIND.calls.length, 1);
    assert.equal(REWIND.calls[0][0], "apply");
    assert.match(io.text(), /回退完成:success · 已回退 2 项变更 · 当前分支 br_plan/);
    await quit(io, done);
  });

  test("/rewind unknown checkpoint id is rejected without kernel mutation", async () => {
    REWIND.calls.length = 0;
    const { io, done } = await boot(kernelWith({ checkpoints: CHECKPOINTS, rewind: REWIND }));
    io.input.write("/rewind preview cp_nope\r");
    await until(() => io.text().includes("未找到检查点:cp_nope"));
    assert.equal(REWIND.calls.length, 0);
    await quit(io, done);
  });

  test("/rewind with bad verb prints usage line", async () => {
    const { io, done } = await boot(kernelWith({ checkpoints: CHECKPOINTS, rewind: REWIND }));
    io.input.write("/rewind bogus\r");
    await until(() => io.text().includes("用法:/rewind"));
    await quit(io, done);
  });

  test("/rewind degrades to offline banner without kernel.session.rewind", async () => {
    const { io, done } = await boot(kernelWith({ checkpoints: CHECKPOINTS }));
    io.input.write("/rewind\r");
    await until(() => io.text().includes("内核不可用"));
    assert.doesNotMatch(io.text(), /用法:\/rewind/);
    await quit(io, done);
  });

  test("/fim prints quiet card: dim meta + completion body", async () => {
    FIM.calls.length = 0;
    const { io, done } = await boot(kernelWith({ fim: FIM }));
    io.input.write("/fim const x =\r");
    await until(() => io.text().includes("hello();"));
    assert.deepEqual(FIM.calls, ["const x ="]);
    assert.match(io.text(), /· fim deepseek-flash · tokens 7/);
    assert.match(io.text(), /^ world\(\);$/m); // 正文逐行入滚动区
    await quit(io, done);
  });

  test("/fim with empty prefix prints usage line and never calls kernel", async () => {
    FIM.calls.length = 0;
    const { io, done } = await boot(kernelWith({ fim: FIM }));
    io.input.write("/fim\r");
    await until(() => io.text().includes("用法:/fim"));
    assert.equal(FIM.calls.length, 0);
    await quit(io, done);
  });

  test("/fim empty completion prints dim notice", async () => {
    const { io, done } = await boot(kernelWith({ fim: { complete: async () => ({ content: "" }) } }));
    io.input.write("/fim const x =\r");
    await until(() => io.text().includes("FIM 未返回补全内容"));
    await quit(io, done);
  });

  test("/fim failure stays silent on one dim line and never blocks input", async () => {
    const { io, done } = await boot(kernelWith({ fim: { complete: async () => { throw new Error("boom"); } } }));
    io.input.write("/fim const x =\r");
    await until(() => io.text().includes("FIM 补全失败:boom"));
    io.input.write("/clear\r"); // 失败后输入流仍可用(不抛、不卡)
    await until(() => io.text().includes("已清空会话上下文"));
    await quit(io, done);
  });

  test("/fim degrades to offline banner without kernel.fim", async () => {
    const { io, done } = await boot(makeFakeKernel({ onSend: async () => ({ status: "complete", content: "" }) }));
    io.input.write("/fim const x =\r");
    await until(() => io.text().includes("内核不可用"));
    assert.doesNotMatch(io.text(), /用法:\/fim/);
    await quit(io, done);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/session-actions.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/session-actions", async () => {
  // tests/unit/tui/session-actions.test.js — /branch /rewind /fim 纯逻辑单测(零内核、零 IO)。

  // 文案桩:键名与 tui-i18n.js 执行器接线轨共用;返回可断言的显著文本。

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { parseBranchArgs, formatBranchLines, parseRewindArgs, formatCheckpointLines, parseFimArgs } = await import("../../../src/apps/tui/session-actions.js");

  const T = (key) => ({
    "msg.branchEmpty": "(no branches)",
    "msg.checkpointEmpty": "(no checkpoints)"
  }[key] ?? key);

  test("parseBranchArgs: empty arg lists branches", () => {
    const list = { action: "list", id: null, label: null };
    assert.deepEqual(parseBranchArgs(""), list);
    assert.deepEqual(parseBranchArgs("   "), list);
    assert.deepEqual(parseBranchArgs(null), list);
    assert.deepEqual(parseBranchArgs(undefined), list);
  });

  test("parseBranchArgs: switch takes the branch id", () => {
    assert.deepEqual(parseBranchArgs("switch br_9k2m"), { action: "switch", id: "br_9k2m", label: null });
    assert.deepEqual(parseBranchArgs("  switch   br_main  "), { action: "switch", id: "br_main", label: null });
    // 后续多余词元忽略(取首个为 id)
    assert.deepEqual(parseBranchArgs("switch br_a extra words"), { action: "switch", id: "br_a", label: null });
  });

  test("parseBranchArgs: new keeps multi-word label trimmed and space-collapsed", () => {
    assert.deepEqual(parseBranchArgs("new fix fim parser"), { action: "new", id: null, label: "fix fim parser" });
    assert.deepEqual(parseBranchArgs("new    多词   标签  "), { action: "new", id: null, label: "多词 标签" });
    assert.deepEqual(parseBranchArgs("new one"), { action: "new", id: null, label: "one" });
  });

  test("parseBranchArgs: invalid shapes carry an error code", () => {
    assert.deepEqual(parseBranchArgs("switch"), { action: "invalid", id: null, label: null, error: "missing_id" });
    assert.deepEqual(parseBranchArgs("new"), { action: "invalid", id: null, label: null, error: "missing_label" });
    assert.deepEqual(parseBranchArgs("new    "), { action: "invalid", id: null, label: null, error: "missing_label" });
    assert.deepEqual(parseBranchArgs("delete br_1"), { action: "invalid", id: null, label: null, error: "unknown_action" });
    assert.deepEqual(parseBranchArgs("Switch br_1"), { action: "invalid", id: null, label: null, error: "unknown_action" });
    assert.deepEqual(parseBranchArgs("list"), { action: "invalid", id: null, label: null, error: "unknown_action" });
  });

  test("parseRewindArgs: action and checkpoint id", () => {
    assert.deepEqual(parseRewindArgs(""), { action: "list", checkpointId: null });
    assert.deepEqual(parseRewindArgs("  "), { action: "list", checkpointId: null });
    assert.deepEqual(parseRewindArgs(null), { action: "list", checkpointId: null });
    assert.deepEqual(parseRewindArgs("preview cp_1"), { action: "preview", checkpointId: "cp_1" });
    assert.deepEqual(parseRewindArgs("  apply   cp_2  "), { action: "apply", checkpointId: "cp_2" });
    assert.deepEqual(parseRewindArgs("apply cp_3 extra"), { action: "apply", checkpointId: "cp_3" });
  });

  test("parseRewindArgs: invalid shapes carry an error code", () => {
    assert.deepEqual(parseRewindArgs("preview"), { action: "invalid", checkpointId: null, error: "missing_id" });
    assert.deepEqual(parseRewindArgs("apply"), { action: "invalid", checkpointId: null, error: "missing_id" });
    assert.deepEqual(parseRewindArgs("bogus cp_1"), { action: "invalid", checkpointId: null, error: "unknown_action" });
    assert.deepEqual(parseRewindArgs("PREVIEW cp_1"), { action: "invalid", checkpointId: null, error: "unknown_action" });
  });

  test("parseFimArgs: whole arg is prefix; suffix is always empty", () => {
    assert.deepEqual(parseFimArgs("def foo(a, b)"), { prefix: "def foo(a, b)", suffix: "" });
    assert.deepEqual(parseFimArgs("  pad me  "), { prefix: "pad me", suffix: "" });
    assert.deepEqual(parseFimArgs(""), { prefix: "", suffix: "" });
    assert.deepEqual(parseFimArgs(null), { prefix: "", suffix: "" });
    // 无光标内联:含分隔符的整段也是 prefix,suffix 恒 ""
    assert.deepEqual(parseFimArgs("a<|b|>c"), { prefix: "a<|b|>c", suffix: "" });
  });

  test("formatBranchLines: empty list renders the injected dim line", () => {
    assert.deepEqual(formatBranchLines([], "br_main", T), ["  (no branches)"]);
    assert.deepEqual(formatBranchLines(null, "br_main", T), ["  (no branches)"]);
    assert.deepEqual(formatBranchLines(undefined, null, T), ["  (no branches)"]);
  });

  test("formatBranchLines: marks the active branch with the ● glyph", () => {
    const branches = [
      { branch_id: "br_main", label: "main" },
      { branch_id: "br_side", label: "feature x" }
    ];
    assert.deepEqual(formatBranchLines(branches, "br_side", T), [
      "  br_main  main  ",
      "  br_side  feature x  ●"
    ]);
    // activeId 不在列表中 → 无任何标记
    assert.deepEqual(formatBranchLines(branches, "br_gone", T), [
      "  br_main  main  ",
      "  br_side  feature x  "
    ]);
    // 空 label 段不省略
    assert.deepEqual(formatBranchLines([{ branch_id: "br_x", label: "" }], "br_x", T), ["  br_x    ●"]);
    // t 桩可换 → 空列表文案随注入变化
    assert.deepEqual(formatBranchLines([], "br_main", (k) => `[${k}]`), ["  [msg.branchEmpty]"]);
  });

  test("formatBranchLines: sorted by branch_id, input untouched, repeatable", () => {
    const branches = [
      { branch_id: "br_c", label: "c" },
      { branch_id: "br_a", label: "a" },
      { branch_id: "br_b", label: "b" }
    ];
    const snapshot = JSON.parse(JSON.stringify(branches));
    const lines = formatBranchLines(branches, "br_b", T);
    assert.deepEqual(lines, [
      "  br_a  a  ",
      "  br_b  b  ●",
      "  br_c  c  "
    ]);
    assert.deepEqual(branches, snapshot, "must not mutate the input array");
    assert.deepEqual(formatBranchLines(branches, "br_b", T), lines, "same input → same output");
    // 同 id 时保留输入顺序(稳定排序)
    const dup = [
      { branch_id: "br_dup", label: "first" },
      { branch_id: "br_dup", label: "second" }
    ];
    assert.deepEqual(formatBranchLines(dup, null, T), ["  br_dup  first  ", "  br_dup  second  "]);
  });

  test("formatCheckpointLines: empty list renders the injected dim line", () => {
    assert.deepEqual(formatCheckpointLines([], T), ["  (no checkpoints)"]);
    assert.deepEqual(formatCheckpointLines(null, T), ["  (no checkpoints)"]);
  });

  test("formatCheckpointLines: id, turn/seq summary, and time", () => {
    const checkpoints = [
      { checkpoint_id: "cp_2", branch_id: "br_main", seq: 7, turn_id: "turn_2", type: "turn", label: "after turn_2", timestamp: "2026-01-02T03:04:05.000Z" },
      { checkpoint_id: "cp_1", branch_id: "br_main", seq: 3, turn_id: null, type: "event", label: "user:message", created_at: "2026-01-01T00:00:00.000Z" }
    ];
    assert.deepEqual(formatCheckpointLines(checkpoints, T), [
      "  cp_1  seq 3  2026-01-01T00:00:00.000Z",
      "  cp_2  turn turn_2  2026-01-02T03:04:05.000Z"
    ]);
    // 时间字段回退:timestamp 优先,然后 created_at,然后 ts;全缺省时段落省略
    assert.deepEqual(formatCheckpointLines(
      [{ checkpoint_id: "cp_0", seq: 1, turn_id: "turn_0", timestamp: "T1", created_at: "T2", ts: "T3" }], T),
      ["  cp_0  turn turn_0  T1"]);
    assert.deepEqual(formatCheckpointLines(
      [{ checkpoint_id: "cp_0", seq: 1, created_at: "T2", ts: "T3" }], T),
      ["  cp_0  seq 1  T2"]);
    assert.deepEqual(formatCheckpointLines([{ checkpoint_id: "cp_0", seq: 1, ts: "T3" }], T), ["  cp_0  seq 1  T3"]);
    assert.deepEqual(formatCheckpointLines([{ checkpoint_id: "cp_0", seq: 1 }], T), ["  cp_0  seq 1"]);
  });

  test("formatCheckpointLines: seq ascending, ties by checkpoint_id, input untouched", () => {
    const checkpoints = [
      { checkpoint_id: "cp_b", seq: 5 },
      { checkpoint_id: "cp_a", seq: 5 },
      { checkpoint_id: "cp_c", seq: 2 }
    ];
    const snapshot = JSON.parse(JSON.stringify(checkpoints));
    const lines = formatCheckpointLines(checkpoints, T);
    assert.deepEqual(lines, ["  cp_c  seq 2", "  cp_a  seq 5", "  cp_b  seq 5"]);
    assert.deepEqual(checkpoints, snapshot, "must not mutate the input array");
    assert.deepEqual(formatCheckpointLines(checkpoints, T), lines, "same input → same output");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/recovery-clear.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/recovery-clear", async () => {
  // tests/unit/tui/recovery-clear.test.js — /recovery clear 与 CLI 对齐(facade/校验/成功/失败)。


  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createTuiApp } = await import("../../../src/apps/tui/tui-app.js");
  const { makeIO, until, tmpRoot } = await import("./helpers.js");

  function kernelWithRecovery(recovery) {
    const subs = new Set();
    return {
      session: { subscribe(fn) { subs.add(fn); return { unsubscribe: () => subs.delete(fn) }; } },
      runtime: { getState: () => ({ current: "idle", channel: null }) },
      metrics: { getUsage: () => ({ total_tokens: 0, cache_hit_rate: 0 }) },
      agent: { send: async () => ({ status: "complete", content: "" }), approve: async () => ({}) },
      recovery,
      async dispose() {}
    };
  }

  async function boot(recovery) {
    const io = makeIO();
    const root = await tmpRoot();
    const app = createTuiApp({
      root, input: io.input, output: io.output,
      createKernelImpl: async () => kernelWithRecovery(recovery),
      buildKernelOptionsImpl: async () => ({})
    });
    const done = app.run();
    await until(() => io.text().includes("❯"));
    const quit = async () => { io.input.write("\x03"); io.input.write("\x03"); await done; };
    return { io, quit };
  }

  test("/recovery clear <id> calls facade and renders status", async () => {
    const calls = [];
    const { io, quit } = await boot({
      report: async () => ({ found: [], done: [], blocked: [] }),
      list: async () => [],
      clear: async (id) => { calls.push(id); return { status: "cleared" }; }
    });
    io.input.write("/recovery clear rec_1\r");
    await until(() => io.text().includes("rec_1"));
    assert.deepEqual(calls, ["rec_1"]);
    assert.match(io.text(), /rec_1.*cleared/);
    await quit();
  });

  test("/recovery clear without id prints usage, no facade call", async () => {
    let called = false;
    const { io, quit } = await boot({
      report: async () => ({ found: [], done: [], blocked: [] }),
      list: async () => [],
      clear: async () => { called = true; return {}; }
    });
    io.input.write("/recovery clear\r");
    await until(() => io.text().includes("resume|cancel|clear"));
    assert.equal(called, false);
    await quit();
  });

  test("/recovery clear failure renders error, no crash", async () => {
    const { io, quit } = await boot({
      report: async () => ({ found: [], done: [], blocked: [] }),
      list: async () => [],
      clear: async () => { throw new Error("cannot clear blocked recovery item"); }
    });
    io.input.write("/recovery clear rec_2\r");
    await until(() => io.text().includes("cannot clear blocked"));
    assert.match(io.text(), /cannot clear blocked/);
    await quit();
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/tui/config-flow.test.js
// ---------------------------------------------------------------------------
describe("unit/tui/config-flow", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { CONFIG_ACTIONS, CONFIG_FIELDS, initialConfigState, reduceConfig, renderConfigLines } = await import("../../../src/apps/tui/config-flow.js");
  const { maskKey } = await import("../../../src/apps/api-profiles.js");
  const { makeT } = await import("../../../src/apps/tui/tui-i18n.js");

  const t = makeT("zh");
  const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const P = [{ id: "p_1", name: "main", baseUrl: "https://api.deepseek.com", apiKey: "sk-1234567890abcd", model: "deepseek-chat" }];

  test("list view: rows + add-new entry, wrap navigation over profiles+1", () => {
    let cfg = initialConfigState({ profiles: P, activeId: "p_1" });
    assert.equal(cfg.view, "list");
    cfg = reduceConfig(cfg, { type: "cfg_move", delta: 1 }); // → 新增项
    assert.equal(cfg.index, 1);
    cfg = reduceConfig(cfg, { type: "cfg_move", delta: 1 }); // 回绕
    assert.equal(cfg.index, 0);
    const out = renderConfigLines(cfg, t, maskKey, 100);
    const text = out.lines.map(strip).join("\n");
    assert.match(text, /main/);
    assert.match(text, /●已激活/);
    assert.match(text, /sk-…abcd/);
    assert.match(text, /\+ 新增配置/);
    assert.doesNotMatch(text, /sk-1234567890abcd/);
    assert.equal(out.cursorRow, null);
  });

  test("draft edit: field input masked in render, field_next walks fields", () => {
    let cfg = initialConfigState({ profiles: [], activeId: null });
    cfg = reduceConfig(cfg, { type: "cfg_draft_new" });
    assert.equal(cfg.view, "edit");
    assert.deepEqual(CONFIG_FIELDS, ["name", "baseUrl", "apiKey", "model"]);
    cfg = reduceConfig(cfg, { type: "cfg_field_input", text: "p1" });
    cfg = reduceConfig(cfg, { type: "cfg_field_next" });
    cfg = reduceConfig(cfg, { type: "cfg_field_next" }); // 到 apiKey
    cfg = reduceConfig(cfg, { type: "cfg_field_input", text: "sk-secret" });
    cfg = reduceConfig(cfg, { type: "cfg_field_backspace" });
    assert.equal(cfg.draft.apiKey, "sk-secre");
    const out = renderConfigLines(cfg, t, maskKey, 100);
    const text = out.lines.map(strip).join("\n");
    assert.doesNotMatch(text, /sk-secre/);
    assert.match(text, /••••••••/); // 8 个掩码点
    assert.equal(typeof out.cursorRow, "number");
  });

  test("models view: pick writes draft.model and returns to edit", () => {
    let cfg = initialConfigState({ profiles: P, activeId: null });
    cfg = reduceConfig(cfg, { type: "cfg_draft_edit", profile: P[0] });
    cfg = reduceConfig(cfg, { type: "cfg_models", models: ["m1", "m2"] });
    assert.equal(cfg.view, "models");
    cfg = reduceConfig(cfg, { type: "cfg_move", delta: 1 });
    cfg = reduceConfig(cfg, { type: "cfg_model_pick" });
    assert.equal(cfg.view, "edit");
    assert.equal(cfg.draft.model, "m2");
  });

  test("actions view renders CONFIG_ACTIONS; error renders red line", () => {
    let cfg = initialConfigState({ profiles: P, activeId: null });
    cfg = reduceConfig(cfg, { type: "cfg_view", view: "actions" });
    let out = renderConfigLines(cfg, t, maskKey, 100).lines.map(strip).join("\n");
    for (const key of ["激活", "编辑", "拉取模型列表", "连接测试", "删除"]) assert.match(out, new RegExp(key));
    cfg = reduceConfig(cfg, { type: "cfg_error", error: "boom" });
    out = renderConfigLines(cfg, t, maskKey, 100).lines.map(strip).join("\n");
    assert.match(out, /boom/);
    assert.equal(CONFIG_ACTIONS.length, 5);
  });
});
