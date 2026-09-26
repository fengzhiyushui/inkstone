import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionIndex, parseSessionEvents, summarizeUserMessage } from "../../../src/apps/session-index.js";

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
