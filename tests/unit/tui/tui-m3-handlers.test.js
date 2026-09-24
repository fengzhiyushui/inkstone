// tests/unit/tui/tui-m3-handlers.test.js — v1.9.0 M3 A6/A3:/branch /rewind /fim 执行器全链路
// (注入 IO + mock kernel;解析/格式化由 session-actions.js 纯逻辑承担,这里只验证接线)。
import test from "node:test";
import assert from "node:assert/strict";
import { createTuiApp } from "../../../src/apps/tui/tui-app.js";
import { STRINGS } from "../../../src/apps/tui/tui-i18n.js";
import { makeIO, makeFakeKernel, until, tmpRoot } from "./helpers.js";

// 在基础 fake kernel 上按需挂 branches / checkpoints / rewind / fim 面。
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
