// tests/unit/apps/project-and-session-index.test.js — 项目注册表与会话索引领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/apps/project-registry.test.js
// ---------------------------------------------------------------------------
describe("unit/apps/project-registry", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { writeFile, readFile, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createProjectRegistry, projectIdFromRoot } = await import("../../../src/apps/project-registry.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  async function withRegistry(fn) {
    const base = await mkdtemp(path.join(tmpdir(), "inkstone-registry-"));
    const dir = path.join(base, ".deepseek-code");
    await mkdir(dir, { recursive: true });
    const reg = createProjectRegistry({ dir });
    await fn({ reg, dir, base });
  }

  test("touch 登记项目并置顶;重复 touch 去重", async () => {
    await withRegistry(async ({ reg, base }) => {
      const a = path.join(base, "a");
      const b = path.join(base, "b");
      await mkdir(a);
      await mkdir(b);

      await reg.touch(a);
      await reg.touch(b);
      await reg.touch(a); // 再次打开 a → 去重并置顶

      const list = await reg.list();
      assert.equal(list.length, 2, `期望 2 项,实得 ${list.length}`);
      assert.equal(list[0].root, a, "最近打开的 a 应置顶");
      assert.equal(list[0].id, projectIdFromRoot(a));
      assert.equal(list[1].root, b);
      assert.ok(list.every((p) => p.name && p.lastOpened > 0));
    });
  });

  test("root 不存在时 touch 拒绝", async () => {
    await withRegistry(async ({ reg, base }) => {
      await assert.rejects(() => reg.touch(path.join(base, "missing")), /does not exist/);
    });
  });

  test("损坏文件容错:读回默认空表", async () => {
    await withRegistry(async ({ reg, dir, base }) => {
      await writeFile(path.join(dir, "projects.json"), "{ broken json", "utf8");
      assert.deepEqual(await reg.list(), []);
      // 写后仍可正常使用
      await mkdir(path.join(base, "ok"));
      await reg.touch(path.join(base, "ok"));
      assert.equal((await reg.list()).length, 1);
    });
  });

  test("remove 按 root 或 id 移除", async () => {
    await withRegistry(async ({ reg, base }) => {
      const a = path.join(base, "a");
      await mkdir(a);
      await reg.touch(a);
      await reg.remove(a);
      assert.deepEqual(await reg.list(), []);
    });
  });

  test("持久化到磁盘可跨实例读取", async () => {
    await withRegistry(async ({ reg, dir, base }) => {
      const a = path.join(base, "a");
      await mkdir(a);
      await reg.touch(a);
      const raw = JSON.parse(await readFile(path.join(dir, "projects.json"), "utf8"));
      assert.equal(raw.projects.length, 1);
      assert.equal(raw.projects[0].root, a);
    });
  });

  // ── 登记表是 MRU 历史:目录消失后不能静默给出死条目 ──────────────────────────
  test("list 标记目录已缺失的项目,但保留条目", async () => {
    await withRegistry(async ({ reg, base }) => {
      const alive = path.join(base, "alive");
      const gone = path.join(base, "gone");
      await mkdir(alive);
      await mkdir(gone);
      await reg.touch(gone);
      await reg.touch(alive);

      // 模拟目录被移动/删除(临时目录、外接盘、手工清理)
      await rm(gone, { recursive: true, force: true });

      const list = await reg.list();
      assert.equal(list.length, 2, "缺失目录不应被静默丢弃");
      const goneEntry = list.find((p) => p.root === gone);
      const aliveEntry = list.find((p) => p.root === alive);
      assert.equal(goneEntry.missing, true, "缺失目录应被标记");
      assert.equal(aliveEntry.missing, false, "存在的目录不应被标记");
      assert.ok(goneEntry.name, "缺失条目的名称仍可显示,便于用户辨认");
    });
  });

  test("missing 是派生状态:目录恢复后自动消解", async () => {
    await withRegistry(async ({ reg, base }) => {
      const p = path.join(base, "flaky");
      await mkdir(p);
      await reg.touch(p);
      assert.equal((await reg.list())[0].missing, false);

      await rm(p, { recursive: true, force: true });
      assert.equal((await reg.list())[0].missing, true);

      await mkdir(p);
      assert.equal((await reg.list())[0].missing, false, "目录回来后不应残留标记");
    });
  });

  test("list 对路径为空的脏条目容错", async () => {
    await withRegistry(async ({ reg, dir }) => {
      await writeFile(
        path.join(dir, "projects.json"),
        JSON.stringify({ projects: [{ id: "proj_x", root: "", name: "", lastOpened: 1 }] }),
        "utf8"
      );
      const list = await reg.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].missing, true);
      assert.equal(typeof list[0].name, "string");
    });
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/apps/session-index.test.js
// ---------------------------------------------------------------------------
describe("unit/apps/session-index", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createSessionIndex, parseSessionEvents, summarizeUserMessage } = await import("../../../src/apps/session-index.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  function line(obj) { return `${JSON.stringify(obj)}\n`; }

  test("parseSessionEvents:提取事件数 + 首条用户消息摘要", () => {
    const src = [
      line({ type: "session:start", root: "/x" }),
      line({ type: "user:message", content: "  帮我  解释这个项目 的架构  " }),
      line({ type: "agent:final", content: "ok" })
    ].join("");
    const { events, summary } = parseSessionEvents(src.split(/\r?\n/));
    assert.equal(events, 3);
    assert.equal(summary, "帮我 解释这个项目 的架构");
  });

  test("parseSessionEvents:摘要超长截断到 80 字符", () => {
    const long = "很".repeat(200);
    const { summary } = parseSessionEvents([line({ type: "user:message", content: long })]);
    assert.equal(summary.length, 81); // 80 + "…"
    assert.ok(summary.endsWith("…"));
  });

  test("parseSessionEvents:损坏行跳过不中断", () => {
    const src = [line({ type: "session:start" }), "{ broken json\n", line({ type: "user:message", content: "hi" })].join("");
    const { events, summary } = parseSessionEvents(src.split(/\r?\n/));
    assert.equal(events, 2, "坏行不计入事件数");
    assert.equal(summary, "hi");
  });

  test("summarizeUserMessage 空值回退", () => {
    assert.equal(summarizeUserMessage({ type: "agent:final" }), "");
    assert.equal(summarizeUserMessage(null), "");
  });

  test("listByProject:空目录返回空", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "inkstone-sess-"));
    const index = createSessionIndex({ sessionRoot: path.join(root, "v2", "sessions") });
    assert.deepEqual(await index.listByProject(), []);
  });

  test("listByProject:按项目分组、按 mtime 降序、忽略 .branches.json", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "inkstone-sess-"));
    const sessions = path.join(base, ".deepseek-code", "v2", "sessions");
    const projA = path.join(sessions, "proj_aaa");
    const projB = path.join(sessions, "proj_bbb");
    await mkdir(projA, { recursive: true });
    await mkdir(projB, { recursive: true });

    const sess1 = path.join(projA, "sess_old.jsonl");
    const sess2 = path.join(projA, "sess_new.jsonl");
    await writeFile(sess1, line({ type: "session:start" }) + line({ type: "user:message", content: "旧会话" }));
    await writeFile(sess2, line({ type: "user:message", content: "新会话" }));
    await writeFile(path.join(projA, "sess_old.branches.json"), "{}"); // 应被忽略
    await writeFile(path.join(projB, "sess_b.jsonl"), line({ type: "user:message", content: "B 项目" }));

    // 让 sess2 更新 → 置顶
    const future = new Date(Date.now() + 10_000);
    await Promise.all([
      import("node:fs/promises").then(({ utimes }) => utimes(sess2, future, future)),
      import("node:fs/promises").then(({ utimes }) => utimes(sess1, new Date(Date.now() + 1_000), new Date(Date.now() + 1_000)))
    ]);

    const index = createSessionIndex({ sessionRoot: sessions });
    const byProject = await index.listByProject();
    assert.equal(byProject.length, 2);

    const [pa, pb] = byProject;
    assert.equal(pa.projectDir, "proj_aaa");
    assert.equal(pa.sessions.length, 2, ".branches.json 不应计入");
    assert.equal(pa.sessions[0].id, "new");
    assert.equal(pa.sessions[1].id, "old");
    assert.ok(pa.sessions[0].mtime > pa.sessions[1].mtime);
    assert.equal(pa.sessions[0].summary, "新会话");
    assert.equal(pb.projectDir, "proj_bbb");
    assert.equal(pb.sessions[0].summary, "B 项目");
  });

  test("deleteSession:删除指定会话文件(.jsonl 与 .branches.json)", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "inkstone-sess-del-"));
    const sessions = path.join(base, ".deepseek-code", "v2", "sessions");
    const projA = path.join(sessions, "proj_aaa");
    await mkdir(projA, { recursive: true });

    const sess1 = path.join(projA, "sess_target.jsonl");
    const branch1 = path.join(projA, "sess_target.branches.json");
    await writeFile(sess1, line({ type: "session:start" }));
    await writeFile(branch1, "{}");

    const index = createSessionIndex({ sessionRoot: sessions });
    const res = await index.deleteSession("target", "proj_aaa");
    assert.equal(res.ok, true);
    assert.equal(res.deleted, true);

    const list = await index.listByProject();
    assert.equal(list.length, 0);
  });
});
