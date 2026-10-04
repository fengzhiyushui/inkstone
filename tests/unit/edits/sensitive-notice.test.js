import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSensitiveNotice, sensitiveReasonFor } from "../../../src/edits/sensitive-notice.js";
import { createEditService } from "../../../src/edits/edit-service.js";
import { mkdtemp } from "../../helpers/tmp.js";

const ENV_DIFF = "--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-OLD=1\n+NEW=2";
const SAFE_DIFF = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";

// ── 纯判定层 ──

test("sensitiveReasonFor flags secret and credential files", () => {
  assert.equal(sensitiveReasonFor(".env"), "secret-file");
  assert.equal(sensitiveReasonFor(".env.production"), "secret-file");
  assert.equal(sensitiveReasonFor("certs/server.pem"), "secret-file");
  assert.equal(sensitiveReasonFor("id_rsa.key"), "secret-file");
  assert.equal(sensitiveReasonFor(".npmrc"), "credential-file");
  assert.equal(sensitiveReasonFor("config/credentials.json"), "credential-file");
});

// 这条是本模块存在的理由:contextSkipReason 对 node_modules/dist/.vscode 也返回
// 非 null(ignored-directory / hidden-tool-dir),但那些不是密钥文件。整个复用
// 会让红色提醒在改 dist/ 时也弹,沦为噪音 —— 提醒一旦成噪音就等于没有。
test("sensitiveReasonFor does NOT flag merely-ignored paths (would make the warning noise)", () => {
  assert.equal(sensitiveReasonFor("node_modules/lib/index.js"), null);
  assert.equal(sensitiveReasonFor("dist/bundle.js"), null);
  assert.equal(sensitiveReasonFor("build/out.js"), null);
  assert.equal(sensitiveReasonFor(".vscode/settings.json"), null);
  assert.equal(sensitiveReasonFor(".claude/config.json"), null);
  assert.equal(sensitiveReasonFor("src/app.js"), null);
});

test("buildSensitiveNotice returns only the sensitive subset, null when none", () => {
  const notice = buildSensitiveNotice([".env", "src/a.js", "certs/k.pem"]);
  assert.deepEqual(notice.paths, [
    { path: ".env", reason: "secret-file" },
    { path: "certs/k.pem", reason: "secret-file" }
  ]);
  assert.equal(buildSensitiveNotice(["src/a.js", "README.md"]), null);
  assert.equal(buildSensitiveNotice([]), null);
});

// ── editService 接入 ──

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-sensitive-"));
  await writeFile(path.join(root, ".env"), "OLD=1\n");
  await writeFile(path.join(root, "a.txt"), "old\n");
  return root;
}

async function changeRecordCount(root) {
  try {
    const entries = await readdir(path.join(root, ".deepseek-code", "changes"));
    return entries.filter((n) => n.endsWith(".json")).length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

test("editService refuses the edit when the notice callback declines", async () => {
  const root = await fixture();
  const seen = [];
  const svc = createEditService({
    projectRoot: root,
    onSensitiveNotice: async (notice) => { seen.push(notice); return false; }
  });

  await assert.rejects(
    () => svc.apply({ diff: ENV_DIFF, prompt: "touch env" }),
    (e) => e.code === "SENSITIVE_EDIT_DECLINED"
  );
  // 回调确实收到了载荷
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].paths, [{ path: ".env", reason: "secret-file" }]);
  // 文件未被改动,且没有任何变更记录落盘
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), "OLD=1\n");
  assert.equal(await changeRecordCount(root), 0);
});

test("editService applies normally when the notice callback allows", async () => {
  const root = await fixture();
  const svc = createEditService({
    projectRoot: root,
    onSensitiveNotice: async () => true
  });

  const result = await svc.apply({ diff: ENV_DIFF, prompt: "touch env" });
  assert.equal(result.status, "success");
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), "NEW=2\n");
  assert.equal(await changeRecordCount(root), 1);
});

test("editService never prompts for non-sensitive paths", async () => {
  const root = await fixture();
  let called = 0;
  const svc = createEditService({
    projectRoot: root,
    onSensitiveNotice: async () => { called += 1; return true; }
  });

  const result = await svc.apply({ diff: SAFE_DIFF, prompt: "touch a" });
  assert.equal(result.status, "success");
  assert.equal(called, 0, "普通文件不得触发提醒");
});

test("editService without a notice callback behaves exactly as before", async () => {
  const root = await fixture();
  const svc = createEditService({ projectRoot: root });

  const result = await svc.apply({ diff: ENV_DIFF, prompt: "touch env" });
  assert.equal(result.status, "success");
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), "NEW=2\n");
  assert.equal(await changeRecordCount(root), 1);
});

// 安全默认:回调返回任何非 true 的值(undefined/null/抛错以外)都按拒绝处理,
// 避免实现方漏写返回值就等于放行。
test("editService treats a non-true callback result as decline", async () => {
  const root = await fixture();
  const svc = createEditService({
    projectRoot: root,
    onSensitiveNotice: async () => undefined
  });

  await assert.rejects(
    () => svc.apply({ diff: ENV_DIFF, prompt: "touch env" }),
    (e) => e.code === "SENSITIVE_EDIT_DECLINED"
  );
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), "OLD=1\n");
});
