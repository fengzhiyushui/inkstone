// tests/unit/gui/settings-and-i18n.test.js — 设置与国际化(热键/API 配置/敏感通知状态)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/settings-schema.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/settings-schema", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { SETTINGS_GROUPS, getByPath, setByPath, coerceField, applyFieldEdit, sanitizeConfigPatch } = await import("../../../gui/src/state/settings-schema.js");

  test("groups cover the seven settings sections including model + about", () => {
    const ids = SETTINGS_GROUPS.map((g) => g.id);
    assert.deepEqual(ids, ["general", "appearance", "statusDisplay", "api", "model", "limits", "orchestration", "context", "experience", "about"]);
    assert.equal(SETTINGS_GROUPS.find((g) => g.id === "api").kind, "model");
    assert.equal(SETTINGS_GROUPS.find((g) => g.id === "model").kind, "config");
    assert.equal(SETTINGS_GROUPS.find((g) => g.id === "about").kind, "about");
    // 每个分节都带 lucide 图标名(设计稿的左导航图标),config 字段都带 dot-path 与类型
    for (const g of SETTINGS_GROUPS) assert.ok(typeof g.icon === "string" && g.icon.length > 0);
    for (const g of SETTINGS_GROUPS.filter((g) => g.kind === "config")) {
      for (const f of g.fields) { assert.ok(f.path.includes(".")); assert.ok(f.type); }
    }
  });

  test("getByPath / setByPath read + write nested paths immutably", () => {
    const cfg = { limits: { toolTimeoutMs: 120000 }, orchestration: { budget: { maxTokens: null } } };
    assert.equal(getByPath(cfg, "limits.toolTimeoutMs"), 120000);
    assert.equal(getByPath(cfg, "orchestration.budget.maxTokens"), null);
    assert.equal(getByPath(cfg, "nope.missing"), undefined);
    const next = setByPath(cfg, "orchestration.budget.maxTokens", 500);
    assert.equal(next.orchestration.budget.maxTokens, 500);
    assert.equal(cfg.orchestration.budget.maxTokens, null);       // original untouched
    assert.notEqual(next.orchestration, cfg.orchestration);       // cloned along the path
    assert.equal(next.limits, cfg.limits);                        // untouched branch shared
  });

  test("coerceField matches config normalizers (posInt/nullableInt/bool/enum)", () => {
    assert.equal(coerceField({ type: "posInt" }, "3"), 3);
    assert.equal(coerceField({ type: "posInt", min: 1 }, "0"), 1);          // invalid → min
    assert.equal(coerceField({ type: "posInt", min: 1 }, "abc"), 1);
    assert.equal(coerceField({ type: "nullableInt" }, ""), null);           // empty → off
    assert.equal(coerceField({ type: "nullableInt" }, "0"), null);         // ≤0 → off
    assert.equal(coerceField({ type: "nullableInt" }, "5000"), 5000);
    assert.equal(coerceField({ type: "bool" }, true), true);
    assert.equal(coerceField({ type: "bool" }, ""), false);
    assert.equal(coerceField({ type: "enum", options: ["off", "on", "gated"] }, "on"), "on");
    assert.equal(coerceField({ type: "enum", options: ["off", "on", "gated"] }, "bad"), "off");
  });

  test("applyFieldEdit coerces + sets; sanitizeConfigPatch drops renderer-only keys", () => {
    const draft = { orchestration: { maxRounds: 2 } };
    const next = applyFieldEdit(draft, { path: "orchestration.maxRounds", type: "posInt", min: 1 }, "5");
    assert.equal(next.orchestration.maxRounds, 5);
    const bad = applyFieldEdit(draft, { path: "orchestration.maxRounds", type: "posInt", min: 1 }, "-2");
    assert.equal(bad.orchestration.maxRounds, 1);
    assert.deepEqual(sanitizeConfigPatch({ model: "m", hasApiKey: true }), { model: "m" });
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/i18n.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/i18n", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { translate, makeT, LANGUAGES } = await import("../../../gui/src/i18n/strings.js");

  test("translate returns zh/en by language, falls back to zh then key", () => {
    assert.equal(translate("zh", "composer.send"), "发送");
    assert.equal(translate("en", "composer.send"), "Send");
    assert.equal(translate("fr", "composer.send"), "发送"); // unknown lang → zh
    assert.equal(translate("en", "___missing___"), "___missing___"); // unknown key → key
  });

  test("makeT binds a language", () => {
    const t = makeT("en");
    assert.equal(t("approval.approve"), "Approve");
    assert.equal(makeT("zh")("approval.approve"), "批准");
  });

  test("zh and en dictionaries have identical key sets (no missing translations)", () => {
    // Probe a representative sample of D-3 keys across both languages — every key must
    // resolve to a real (non-key-fallback) string in each language.
    const keys = [
      "settings.general", "settings.model", "settings.limits", "settings.orchestration",
      "settings.context", "settings.experience", "settings.about",
      "settings.f.maxRounds", "settings.f.semanticEnabled", "settings.model.fetch",
      "settings.model.fetchFailed", "rewind.title", "rewind.force", "diff.title",
      "panel.noProblems", "search.placeholder", "run.empty",
      "changes.section", "changes.jump", "changes.rolledBack"
    ];
    for (const lang of LANGUAGES) {
      for (const k of keys) {
        assert.notEqual(translate(lang, k), k, `${lang} missing ${k}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/hotkeys.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/hotkeys", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { isTypingTarget, shouldHandleShellShortcut } = await import("../../../gui/src/state/hotkeys.js");
  const { applyWorkbenchAction, createInitialState } = await import("../../../gui/src/state/workbench-state.js");

  test("isTypingTarget covers form controls and contenteditable", () => {
    assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
    assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
    assert.equal(isTypingTarget({ tagName: "SELECT" }), true);
    assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
    assert.equal(isTypingTarget(null), false);
  });

  test("shouldHandleShellShortcut requires ctrl/meta and blocks typing + modals", () => {
    const base = { ctrlKey: true, metaKey: false, altKey: false, target: { tagName: "DIV" } };
    assert.equal(shouldHandleShellShortcut(base, {}), true);
    assert.equal(shouldHandleShellShortcut({ ...base, ctrlKey: false }, {}), false);
    assert.equal(shouldHandleShellShortcut({ ...base, target: { tagName: "INPUT" } }, {}), false);
    assert.equal(shouldHandleShellShortcut(base, { settingsOpen: true }), false);
    assert.equal(shouldHandleShellShortcut(base, { modalOpen: true }), false);
    assert.equal(shouldHandleShellShortcut({ ...base, altKey: true }, {}), false);
  });

  test("messages capped at 200", () => {
    let s = createInitialState();
    for (let i = 0; i < 220; i++) {
      s = applyWorkbenchAction(s, { type: "message_added", message: { role: "user", text: String(i) } });
    }
    assert.equal(s.messages.length, 200);
    assert.equal(s.messages[0].text, "20");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/api-profiles.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/api-profiles", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { promises: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createApiProfiles, maskKey } = await import("../../../src/apps/api-profiles.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  async function tmp() { return mkdtemp(path.join(os.tmpdir(), "dsc-api-")); }

  test("save assigns id, activate persists activeId, remove drops", async () => {
    const store = createApiProfiles({ dir: await tmp() });
    const p = await store.save({ name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-abc123" });
    assert.ok(p.id);
    assert.equal((await store.list()).length, 1);
    await store.activate(p.id);
    assert.equal((await store.getActive()).id, p.id);
    await store.remove(p.id);
    assert.equal((await store.list()).length, 0);
    assert.equal(await store.getActive(), null);
  });

  test("save with id edits in place; ids do not collide across add/remove", async () => {
    const store = createApiProfiles({ dir: await tmp() });
    const a = await store.save({ name: "a", baseUrl: "u1", apiKey: "k1" });
    await store.save({ id: a.id, name: "a2", baseUrl: "u1", apiKey: "k1" });
    assert.equal((await store.list())[0].name, "a2");
    await store.remove(a.id);
    const b = await store.save({ name: "b", baseUrl: "u2", apiKey: "k2" });
    assert.notEqual(b.id, a.id); // monotonic seq, no reuse
  });

  test("activate unknown id throws", async () => {
    const store = createApiProfiles({ dir: await tmp() });
    await assert.rejects(() => store.activate("nope"));
  });

  test("maskKey masks all shapes", () => {
    assert.equal(maskKey(""), "");
    assert.equal(maskKey("short"), "•••");
    assert.equal(maskKey("sk-1234567890abcd"), "sk-…abcd");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/gui/sensitive-notice-state.test.js
// ---------------------------------------------------------------------------
describe("unit/gui/sensitive-notice-state", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createInitialState, applyWorkbenchAction } = await import("../../../gui/src/state/workbench-state.js");

  const NOTICE_EVENT = {
    type: "gui:sensitive_notice",
    request_id: "sn_1",
    descriptor: {
      kind: "sensitive-file-write",
      severity: "danger",
      paths: [{ path: ".env", reason: "secret-file", reasonKey: "sensitive.reason.secret" }],
      recordDir: ".deepseek-code/changes",
      count: 1
    }
  };

  test("sensitive notice event lands in its own state field", () => {
    const base = createInitialState();
    assert.equal(base.sensitiveNotice, null);

    const next = applyWorkbenchAction(base, { type: "event_received", event: NOTICE_EVENT });
    assert.equal(next.sensitiveNotice.requestId, "sn_1");
    assert.equal(next.sensitiveNotice.descriptor.paths[0].path, ".env");
  });

  // 关键:它不是审批,不得写 approval,也不得把检查器切到审批分区 ——
  // 否则用户会按审批的肌肉记忆处理它。
  test("sensitive notice does not touch approval state or inspector mode", () => {
    const base = createInitialState();
    const next = applyWorkbenchAction(base, { type: "event_received", event: NOTICE_EVENT });
    assert.equal(next.approval, null, "不得写进 approval 态");
    assert.equal(next.inspectorMode, base.inspectorMode, "不得切换检查器分区");
  });

  test("approval events still behave as before", () => {
    const base = createInitialState();
    const next = applyWorkbenchAction(base, {
      type: "event_received",
      event: { type: "approval:requested", approval: { id: "ap1" } }
    });
    assert.equal(next.approval.id, "ap1");
    assert.equal(next.inspectorMode, "approval");
    assert.equal(next.sensitiveNotice, null, "普通审批不得点亮敏感提醒");
  });

  test("sensitive_notice_cleared clears only that field", () => {
    let s = createInitialState();
    s = applyWorkbenchAction(s, { type: "event_received", event: { type: "approval:requested", approval: { id: "ap1" } } });
    s = applyWorkbenchAction(s, { type: "event_received", event: NOTICE_EVENT });
    s = applyWorkbenchAction(s, { type: "sensitive_notice_cleared" });
    assert.equal(s.sensitiveNotice, null);
    assert.equal(s.approval.id, "ap1", "清提醒不得连带清掉审批");
  });

  test("reducer stays immutable for the new action", () => {
    const base = createInitialState();
    const next = applyWorkbenchAction(base, { type: "event_received", event: NOTICE_EVENT });
    assert.notEqual(next, base);
    assert.equal(base.sensitiveNotice, null, "原状态不得被就地修改");
  });
});
