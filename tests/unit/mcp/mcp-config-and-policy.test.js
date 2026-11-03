// tests/unit/mcp/mcp-config-and-policy.test.js — MCP 配置与策略(loader/scope/注解/工具策略/安全)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-config-loader.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-config-loader", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadMcpConfig, extractServersFromDocument, resolveInputTemplates, resolveServerEnvAndHeaders, looksLikeSecret, auditConfigSecrets, normalizeServersMap, normalizeServerConfig, bindInputs } = await import("../../../src/tools/mcp/config-loader.js");
  const { mkdtempSync } = await import("../../helpers/tmp.js");
  const { normalizeMcpServers } = await import("../../../src/config.js");

  function tmpProject() {
    const root = mkdtempSync(join(tmpdir(), "inkstone-mcp-cfg-"));
    mkdirSync(join(root, ".deepseek-code"), { recursive: true });
    return root;
  }

  test("extractServersFromDocument accepts mcpServers and VS Code servers", () => {
    const a = extractServersFromDocument({ mcpServers: { x: { command: "node" } } });
    assert.ok(a.servers.x);
    const b = extractServersFromDocument({ servers: { y: { command: "node" } }, inputs: { t: {} } });
    assert.ok(b.servers.y);
    assert.ok(b.inputs.t);
  });

  test("scope merge: project overrides user, session overrides project", () => {
    const root = tmpProject();
    try {
      writeFileSync(
        join(root, ".deepseek-code", "config.json"),
        JSON.stringify({ mcpServers: { fs: { command: "user-cmd", args: ["u"] } } })
      );
      writeFileSync(
        join(root, ".mcp.json"),
        JSON.stringify({ mcpServers: { fs: { command: "mcp-json", args: [] }, extra: { command: "e" } } })
      );
      const warns = [];
      const loaded = loadMcpConfig({
        projectRoot: root,
        userConfigPath: join(root, ".deepseek-code", "config.json"),
        projectConfigPath: join(root, "no-project.json"),
        sessionServers: { fs: { command: "session-cmd" } },
        warn: (m) => warns.push(m)
      });
      // project config missing → .mcp.json base, then user, then session
      // user path here is the same as project's config file we wrote — treat as user scope
      assert.equal(loaded.servers.fs.command, "session-cmd");
      assert.ok(loaded.servers.extra);
      assert.equal(loaded.source.fs, "session");
      assert.equal(loaded.source.extra, "mcp.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(".mcp.json loses to project config on same server id and warns", () => {
    const root = tmpProject();
    try {
      writeFileSync(
        join(root, ".deepseek-code", "config.json"),
        JSON.stringify({ mcpServers: { fs: { command: "project-cmd" } } })
      );
      writeFileSync(
        join(root, ".mcp.json"),
        JSON.stringify({ mcpServers: { fs: { command: "dot-mcp" } } })
      );
      const warns = [];
      const loaded = loadMcpConfig({
        projectRoot: root,
        userConfigPath: join(root, "no-user.json"),
        warn: (m) => warns.push(m)
      });
      assert.equal(loaded.servers.fs.command, "project-cmd");
      assert.match(warns.join("\n"), /project config wins/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolveInputTemplates expands ${input:name} in nested structures", () => {
    const inputs = {
      tok: { type: "promptString", value: "secret-1", password: true },
      path: { type: "promptString", default: "/tmp/x" }
    };
    assert.equal(resolveInputTemplates("Bearer ${input:tok}", inputs), "Bearer secret-1");
    assert.equal(resolveInputTemplates("${input:path}", inputs), "/tmp/x");
    assert.deepEqual(
      resolveInputTemplates({ env: { A: "${input:tok}" }, args: ["${input:path}"] }, inputs),
      { env: { A: "secret-1" }, args: ["/tmp/x"] }
    );
    assert.throws(() => resolveInputTemplates("${input:missing}", inputs), /Missing MCP input/);
    assert.equal(
      resolveInputTemplates("${input:missing}", inputs, { onMissing: "keep" }),
      "${input:missing}"
    );
  });

  test("resolveServerEnvAndHeaders expands env/headers/url", () => {
    const inputs = { t: { value: "abc" } };
    const out = resolveServerEnvAndHeaders(
      {
        command: "npx",
        args: ["-y", "pkg"],
        env: { TOKEN: "${input:t}" },
        headers: { Authorization: "Bearer ${input:t}" },
        url: "https://x.example/${input:t}"
      },
      inputs
    );
    assert.equal(out.env.TOKEN, "abc");
    assert.equal(out.headers.Authorization, "Bearer abc");
    assert.equal(out.url, "https://x.example/abc");
  });

  test("looksLikeSecret and auditConfigSecrets warn on literal secrets in project scope", () => {
    assert.equal(looksLikeSecret("ghp_abcdefghijklmnop"), true);
    assert.equal(looksLikeSecret("hello"), false);
    const warns = [];
    auditConfigSecrets(
      {
        s: { env: { KEY: "ghp_abcdefghijklmnop" } }
      },
      { source: { s: "project" }, warn: (m) => warns.push(m) }
    );
    assert.match(warns.join("\n"), /literal secret/);
  });

  test("normalizeServersMap requires command or url and accepts type http alias", () => {
    const map = normalizeServersMap({
      a: { command: "node x.js" },
      b: { url: "https://mcp.example/mcp", type: "http" }
    });
    assert.equal(map.a.type, "stdio");
    assert.equal(map.b.type, "streamable-http");
    assert.throws(() => normalizeServersMap({ bad: {} }), /command' or 'url'/);
  });

  // ── v1.12.0:远程传输相关字段必须原样保留 ────────────────────────────────────
  test("normalizeServerConfig 保留 url/type/headers/allowlist(远程接入不丢字段)", () => {
    const cfg = normalizeServerConfig("remote", {
      url: "https://mcp.example/mcp",
      type: "streamable-http",
      headers: { Authorization: "Bearer ${input:tok}" },
      allowlist: ["127.0.0.1", "10.0.0.0/8"],
      retryOnStreamBreak: 2,
      maxRedirects: 3
    });
    assert.equal(cfg.type, "streamable-http");
    assert.equal(cfg.url, "https://mcp.example/mcp");
    assert.deepEqual(cfg.headers, { Authorization: "Bearer ${input:tok}" });
    assert.deepEqual(cfg.allowlist, ["127.0.0.1", "10.0.0.0/8"]);
    assert.equal(cfg.retryOnStreamBreak, 2);
    assert.equal(cfg.maxRedirects, 3);
  });

  test("normalizeServerConfig 推断类型并接受 sse(legacy)", () => {
    assert.equal(normalizeServerConfig("a", { url: "https://x/mcp" }).type, "streamable-http");
    assert.equal(normalizeServerConfig("b", { url: "https://x/mcp", type: "sse" }).type, "sse");
    assert.equal(normalizeServerConfig("c", { command: "node" }).type, "stdio");
    assert.throws(() => normalizeServerConfig("d", { url: "https://x", type: "nope" }), /unknown type/);
  });

  test("bindInputs prefers value then credentials-less default", () => {
    const bound = bindInputs({
      a: { type: "promptString", value: "v1" },
      b: { type: "promptString", default: "d1" }
    });
    assert.equal(bound.a.value, "v1");
    assert.equal(bound.b.value, "d1");
  });

  test("MCP interactive capabilities require explicit boolean opt-in and bounded form timeout", () => {
    const normalize = (settings) => normalizeServerConfig("forms", { command: "node", ...settings });
    const defaults = normalize({});
    assert.equal(Object.hasOwn(defaults, "elicitation"), false);
    assert.equal(Object.hasOwn(defaults, "subscriptions"), false);
    for (const name of ["elicitation", "subscriptions"]) {
      assert.deepEqual(normalize({ [name]: {} })[name], { enabled: false });
      assert.deepEqual(normalize({ [name]: { enabled: true, unexpected: "ignored" } })[name], { enabled: true });
      assert.deepEqual(normalize({ [name]: { enabled: false } })[name], { enabled: false });
      for (const settings of [null, true, [], "true", { enabled: "true" }, { enabled: 1 }]) {
        assert.throws(() => normalize({ [name]: settings }), /Invalid MCP/);
      }
    }
    for (const timeoutMs of [1000, 120000, 300000]) {
      assert.deepEqual(normalize({ elicitation: { enabled: true, timeoutMs } }).elicitation, { enabled: true, timeoutMs });
    }
    for (const timeoutMs of [999, 300001, 1000.5, "120000", Infinity, NaN]) {
      assert.throws(() => normalize({ elicitation: { enabled: true, timeoutMs } }), /Invalid MCP elicitation timeoutMs/);
    }
    const servers = normalizeMcpServers({
      forms: { command: "node", elicitation: { enabled: true, timeoutMs: 1000 }, subscriptions: { enabled: true } },
      malformed: { command: "node", elicitation: { enabled: "true" } },
      plain: { command: "node" }
    });
    assert.deepEqual(servers.forms.elicitation, { enabled: true, timeoutMs: 1000 });
    assert.deepEqual(servers.forms.subscriptions, { enabled: true });
    assert.equal(Object.hasOwn(servers, "malformed"), false);
    assert.equal(Object.hasOwn(servers.plain, "elicitation"), false);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-config-scope-e2e.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-config-scope-e2e", async () => {
  /**
   * v1.11.2 E2E: config-scope MCP loading must reach the kernel through the real
   * entry point (buildKernelOptions → createKernel → McpHub).
   *
   * Regression guard: before this, MCP config scopes were hub-only and
   * `buildKernelOptions` dropped `config.inputs` entirely, so `.mcp.json`
   * never reached the product.
   */


  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { rm, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { createKernel } = await import("../../../src/index.js");
  const { buildKernelOptions } = await import("../../../src/apps/kernel-options.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  async function tmpProject() {
    const root = await mkdtemp(path.join(tmpdir(), "inkstone-mcp-scope-e2e-"));
    await mkdir(path.join(root, ".deepseek-code"), { recursive: true });
    return root;
  }

  test("buildKernelOptions → createKernel loads .mcp.json servers and inputs", async () => {
    const root = await tmpProject();
    try {
      await writeFile(
        path.join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            dotfile: { command: process.execPath, args: ["-e", "0"], disabled: true }
          },
          inputs: { tok: { type: "promptString", password: true, default: "d" } }
        })
      );

      const options = await buildKernelOptions(root, {}, async () => ({
        apiKey: "test-dummy-key",
        baseUrl: "https://example.invalid",
        inputs: { cfg: { type: "promptString", default: "from-config" } }
      }));

      // inputs declared in the project config survive the options bridge
      assert.deepEqual(options.inputs, { cfg: { type: "promptString", default: "from-config" } });
      assert.equal(options.loadMcpConfigScopes, true);

      const kernel = await createKernel(root, options);
      try {
        const servers = kernel.mcp.listServers();
        const ids = servers.map((s) => s.serverId);
        assert.ok(ids.includes("dotfile"), `.mcp.json server missing from kernel.mcp (got: ${ids.join(",")})`);
      } finally {
        await kernel.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("kernel.mcp exposes listInputs/setInputValue wired to the hub", async () => {
    const root = await tmpProject();
    try {
      await writeFile(
        path.join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: {},
          inputs: { tok: { type: "promptString", password: true, default: "d1" } }
        })
      );

      const kernel = await createKernel(root, {
        deepseek: { apiKey: "test-dummy-key" },
        loadMcpConfigScopes: true
      });
      try {
        const inputs = kernel.mcp.listInputs();
        assert.ok(Array.isArray(inputs), "listInputs must return an array");
        const tok = inputs.find((i) => i.name === "tok");
        assert.ok(tok, "project .mcp.json input must be visible through kernel.mcp");
        assert.equal(tok.password, true);

        kernel.mcp.setInputValue("tok", "user-supplied");
        const after = kernel.mcp.listInputs().find((i) => i.name === "tok");
        assert.equal(after.hasValue, true);
      } finally {
        await kernel.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("loadMcpConfigScopes:false keeps .mcp.json out of the kernel (opt-out works)", async () => {
    const root = await tmpProject();
    try {
      await writeFile(
        path.join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: { dotfile: { command: process.execPath, args: ["-e", "0"], disabled: true } }
        })
      );

      const kernel = await createKernel(root, {
        deepseek: { apiKey: "test-dummy-key" },
        loadMcpConfigScopes: false
      });
      try {
        const ids = kernel.mcp.listServers().map((s) => s.serverId);
        assert.equal(ids.includes("dotfile"), false, ".mcp.json must be ignored when scopes are off");
      } finally {
        await kernel.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("untrusted workspace does not auto-initialize .mcp.json servers by default", async () => {
    const root = await tmpProject();
    try {
      await writeFile(
        path.join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            evil: { command: "non-existent-evil-binary-9999" }
          }
        })
      );

      const kernel = await createKernel(root, {
        deepseek: { apiKey: "test-dummy-key" },
        loadMcpConfigScopes: true
      });
      try {
        const server = kernel.mcp.listServers().find((s) => s.serverId === "evil");
        assert.ok(server, "server must be listed");
        assert.equal(server.status, "DISCONNECTED", "untrusted workspace server must not be auto-spawned");
      } finally {
        await kernel.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-annotations.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-annotations", async () => {

  // ── D1:annotations 解析 ────────────────────────────────────────────────────

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { parseAnnotations, annotationsFromTool, resolveToolRisk, riskBadge, ANNOTATION_KEYS, RISK_LADDER } = await import("../../../src/tools/mcp/annotations.js");

  test("parseAnnotations:只有显式 true 才命中,缺省与非布尔一律 false", () => {
    assert.deepEqual(
      parseAnnotations(null),
      { readOnly: false, destructive: false, openWorld: false, idempotent: false, present: false, title: null }
    );
    assert.deepEqual(
      parseAnnotations({ readOnlyHint: "true", destructiveHint: 1, openWorldHint: "yes" }),
      { readOnly: false, destructive: false, openWorld: false, idempotent: false, present: false, title: null }
    );
    const parsed = parseAnnotations({ readOnlyHint: true, openWorldHint: true, title: "My Tool" });
    assert.equal(parsed.readOnly, true);
    assert.equal(parsed.openWorld, true);
    assert.equal(parsed.present, true);
    assert.equal(parsed.title, "My Tool");
  });

  test("parseAnnotations:数组/标量输入安全降级", () => {
    assert.equal(parseAnnotations([]).present, false);
    assert.equal(parseAnnotations("readOnly").present, false);
    assert.equal(parseAnnotations(42).present, false);
    assert.equal(parseAnnotations(undefined).present, false);
  });

  test("parseAnnotations:destructiveHint 与 readOnlyHint 可同时上报,不互相抵消", () => {
    const parsed = parseAnnotations({ readOnlyHint: true, destructiveHint: true });
    assert.equal(parsed.readOnly, true);
    assert.equal(parsed.destructive, true, "解析层不得自行取舍,冲突留给 resolveToolRisk 按失败优先处理");
  });

  test("annotationsFromTool:兼容摊在 tool 顶层的字段", () => {
    assert.equal(annotationsFromTool({ annotations: { readOnlyHint: true } }).readOnly, true);
    assert.equal(annotationsFromTool({ readOnlyHint: true }).readOnly, true);
    assert.equal(annotationsFromTool({}).present, false);
    assert.equal(annotationsFromTool(null).present, false);
  });

  test("ANNOTATION_KEYS 与 RISK_LADDER 契约稳定", () => {
    assert.deepEqual([...ANNOTATION_KEYS], ["readOnlyHint", "destructiveHint", "openWorldHint", "idempotentHint"]);
    assert.deepEqual([...RISK_LADDER], ["read", "mutate", "destructive"]);
  });

  // ── D2:信任模型(annotations 不可信,除非 server 受信) ───────────────────────
  test("不受信 server:annotations 完全不参与判定", () => {
    // 一个叫 delete_file 的工具,server 谎称 readOnlyHint —— 不受信时不得降级
    const r = resolveToolRisk({
      name: "delete_file",
      description: "Deletes a file from disk",
      annotations: { readOnlyHint: true },
      trusted: false
    });
    assert.notEqual(r.category, "read");
    assert.equal(r.source, "keyword-untrusted");
    assert.equal(r.trusted, false);
  });

  test("不受信 server:连 destructiveHint 也不采用(避免被用来误报),纯靠关键词", () => {
    // destructiveHint 在不受信时只是提示,不作为升级依据 —— 但关键词兜底仍覆盖这类命名
    const r = resolveToolRisk({
      name: "purge_all",
      description: "removes everything",
      annotations: { readOnlyHint: true },
      trusted: false
    });
    assert.equal(r.category, "destructive", "关键词已足以判定破坏性,不受信也不得降级");
    assert.equal(r.source, "keyword-untrusted");
  });

  test("受信 server + readOnlyHint:降为 read(可配置自动放行)", () => {
    const r = resolveToolRisk({
      name: "read_doc",
      description: "Reads a document",
      annotations: { readOnlyHint: true },
      trusted: true
    });
    assert.equal(r.category, "read");
    assert.equal(r.source, "annotations");
    assert.deepEqual(r.escalatedBy, ["readOnlyHint"]);
  });

  test("受信 server:readOnlyHint 不得把已判定为写操作的工具降级(防误放行)", () => {
    // 关键词认为要写,server 却说是只读 —— 以关键词为准,不允许降级
    const r = resolveToolRisk({
      name: "delete_record",
      description: "Deletes a record",
      annotations: { readOnlyHint: true },
      trusted: true
    });
    assert.equal(r.category, "mutate");
    assert.deepEqual(r.escalatedBy, [], "不得因 readOnlyHint 记录降级");
  });

  test("受信 server + destructiveHint:一律 destructive(硬约束)", () => {
    const r = resolveToolRisk({
      name: "run_cleanup",
      description: "Cleanup task",
      annotations: { destructiveHint: true },
      trusted: true
    });
    assert.equal(r.category, "destructive", "destructive 永不自动放行");
    assert.deepEqual(r.escalatedBy, ["destructiveHint"]);
  });

  test("受信 server:destructiveHint 与 readOnlyHint 并存时 destructive 优先(失败优先)", () => {
    const r = resolveToolRisk({
      name: "some_tool",
      description: "",
      annotations: { readOnlyHint: true, destructiveHint: true },
      trusted: true
    });
    assert.equal(r.category, "destructive", "冲突信号按失败优先,不得降级为只读");
  });

  test("受信 server + openWorldHint:风险 +1", () => {
    const r = resolveToolRisk({
      name: "lookup",
      description: "looks things up",
      annotations: { openWorldHint: true },
      trusted: true
    });
    assert.equal(r.category, "mutate", "read 应升一级为 mutate");
    assert.deepEqual(r.escalatedBy, ["openWorldHint"]);
  });

  test("受信 server + openWorldHint:不会把 destructive 再往上推(已封顶)", () => {
    // 用无害命名,确保 destructiveHint 是真正执行升级的那个信号
    const r = resolveToolRisk({
      name: "cleanup_task",
      description: "routine task",
      annotations: { destructiveHint: true, openWorldHint: true },
      trusted: true
    });
    assert.equal(r.category, "destructive");
    assert.deepEqual(r.escalatedBy, ["destructiveHint"], "已封顶,不再叠加 openWorld");
  });

  test("无 annotations 时回到关键词兜底(feign keyword path)", () => {
    const r = resolveToolRisk({ name: "delete_file", description: "", trusted: true });
    assert.equal(r.category, "mutate");
    assert.equal(r.source, "keyword");
    assert.equal(r.trusted, true);
  });

  test("repairRisk:parseAnnotations 结果可直接复用(present 标记", () => {
    const parsed = parseAnnotations({ readOnlyHint: true });
    const r = resolveToolRisk({
      name: "read_doc",
      description: "",
      annotations: parsed,
      trusted: true
    });
    assert.equal(r.category, "read", "已解析对象不应被二次解析破坏");
    assert.equal(r.annotations.readOnly, true);
  });

  // ── 展示层 ─────────────────────────────────────────────────────────────────
  test("riskBadge 三档", () => {
    assert.deepEqual(riskBadge("destructive"), { level: "danger", label: "破坏性" });
    assert.deepEqual(riskBadge("mutate"), { level: "warn", label: "写操作" });
    assert.deepEqual(riskBadge("read"), { level: "ok", label: "只读" });
    assert.deepEqual(riskBadge("unknown"), { level: "ok", label: "只读" }, "未知档位按最保守展示");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-tool-policy.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-tool-policy", async () => {

  // ── D5:工具级开关 ──────────────────────────────────────────────────────────

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { rm } = await import("node:fs/promises");
  const { readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { mkdtemp } = await import("../../helpers/tmp.js");
  const { APPROVAL_SCOPES, normalizeToolPolicy, normalizeApprovalScope, normalizeRiskOverride, isToolEnabled, resolveConfiguredScope, validateApprovalScope, policyKey, policyGrantsAsRules, createPolicyStore } = await import("../../../src/tools/mcp/tool-policy.js");

  test("normalizeToolPolicy:默认全开,disabled 优先", () => {
    const empty = { enabled: ["*"], disabled: [], approval: {}, risk: {} };
    assert.deepEqual(normalizeToolPolicy(null), empty);
    assert.deepEqual(normalizeToolPolicy({ enabled: ["a", "b"] }), { ...empty, enabled: ["a", "b"] });
    assert.deepEqual(normalizeToolPolicy({ disabled: ["x"] }), { ...empty, disabled: ["x"] });
  });

  test("normalizeToolPolicy:用户风险覆盖只收合法值", () => {
    const p = normalizeToolPolicy({ risk: { a: "read", b: "READ", c: "nonsense", d: 42 } });
    assert.deepEqual(p.risk, { a: "read", b: "read" }, "大小写归一,非法/非字符串忽略");
    assert.equal(normalizeRiskOverride("destructive"), "destructive");
    assert.equal(normalizeRiskOverride(null), null);
    assert.equal(normalizeRiskOverride("bogus"), null);
  });

  test("isToolEnabled:白名单/黑名单/全开三种模式", () => {
    const allow = normalizeToolPolicy({ enabled: ["read_doc", "list"] });
    assert.equal(isToolEnabled(allow, "read_doc"), true);
    assert.equal(isToolEnabled(allow, "delete"), false);

    const deny = normalizeToolPolicy({ enabled: ["*"], disabled: ["delete"] });
    assert.equal(isToolEnabled(deny, "delete"), false, "disabled 优先于 *");
    assert.equal(isToolEnabled(deny, "anything"), true);
  });

  test("resolveConfiguredScope:只接受合法 scope", () => {
    const p = normalizeToolPolicy({ approval: { a: "always", b: "nonsense", c: "PROJECT" } });
    assert.equal(resolveConfiguredScope(p, "a"), "always");
    assert.equal(resolveConfiguredScope(p, "b"), null, "非法值按未配置处理");
    assert.equal(resolveConfiguredScope(p, "c"), "project", "大小写归一");
    assert.equal(resolveConfiguredScope(p, "zzz"), null);
  });

  test("isToolEnabled/resolveConfiguredScope 接受未归一化的原始 tools 字段", () => {
    // 回归:hub 早期直接透传 raw({ disabled:[...] }),enabled 为 undefined 会让
    // .includes 抛错,导致整台 server 的工具全部挂载失败。
    const raw = { disabled: ["quiet_tool"] };
    assert.equal(isToolEnabled(raw, "lookup_doc"), true, "仅 disabled 时应默认全开");
    assert.equal(isToolEnabled(raw, "quiet_tool"), false);

    const rawApproval = { approval: { lookup_doc: "always" } };
    assert.equal(resolveConfiguredScope(rawApproval, "lookup_doc"), "always");

    // 边界:null / 标量 / 数组都不应抛错
    assert.equal(isToolEnabled(null, "x"), true);
    assert.equal(isToolEnabled(undefined, "x"), true);
    assert.equal(isToolEnabled([], "x"), true);
    assert.equal(resolveConfiguredScope(null, "x"), null);
    assert.equal(resolveConfiguredScope("nope", "x"), null);
  });

  test("normalizeApprovalScope 契约", () => {
    assert.deepEqual([...APPROVAL_SCOPES], ["session", "project", "always"]);
    assert.equal(normalizeApprovalScope("always"), "always");
    assert.equal(normalizeApprovalScope(null), null);
    assert.equal(normalizeApprovalScope("forever"), null);
  });

  // ── D4:destructive 硬约束(核心安全不变量) ──────────────────────────────────
  test("destructive 只允许 session;project/always 被拒并给出 fallback", () => {
    for (const scope of ["project", "always"]) {
      const r = validateApprovalScope({ category: "destructive", scope, toolName: "wipe_db" });
      assert.equal(r.ok, false, `${scope} 必须被拒绝`);
      assert.equal(r.scope, "session", "fallback 到 session");
      assert.equal(r.locked, true, "须标记为硬约束拒绝,便于界面提示原因");
      assert.match(r.reason, /destructive/);
    }
  });

  test("destructive 显式要 session 时放行(仅本次),且不算锁定", () => {
    const r = validateApprovalScope({ category: "destructive", scope: "session", toolName: "wipe_db" });
    assert.equal(r.ok, true);
    assert.equal(r.scope, "session");
    assert.equal(r.locked ?? false, false);
  });

  test("非 destructive 可授予 project / always", () => {
    for (const category of ["read", "mutate"]) {
      for (const scope of ["session", "project", "always"]) {
        const r = validateApprovalScope({ category, scope, toolName: "t" });
        assert.equal(r.ok, true, `${category}/${scope} 应放行`);
        assert.equal(r.scope, scope);
      }
    }
  });

  test("缺省 scope 视为 session", () => {
    const r = validateApprovalScope({ category: "mutate", scope: undefined });
    assert.equal(r.ok, true);
    assert.equal(r.scope, "session");
  });

  // ── D3:策略持久化 ──────────────────────────────────────────────────────────
  async function withStore(fn) {
    const base = await mkdtemp(path.join(tmpdir(), "dsc-mcp-policy-"));
    try {
      await fn({
        store: createPolicyStore({ projectRoot: path.join(base, "project"), userRoot: path.join(base, "user") }),
        projectFile: path.join(base, "project", ".deepseek-code", "mcp-policy.json"),
        // 用户级路径统一落在 <userRoot>/.deepseek-code/mcp-policy.json(与项目级同构)
        userFile: path.join(base, "user", ".deepseek-code", "mcp-policy.json"),
        base
      });
    } finally {
      await rm(base, { recursive: true, force: true }).catch(() => {});
    }
  }

  test("策略持久化:project 与 always 落到各自文件并可读回", async () => {
    await withStore(async ({ store, projectFile, userFile }) => {
      assert.equal(store.grant("read_doc", "project").ok, true);
      assert.equal(store.grant("list_dir", "always").ok, true);
      // session 不落盘
      assert.equal(store.grant("x", "session").ok, false);

      const list = store.list();
      assert.equal(list.find((g) => g.tool === "read_doc").scope, "project");
      assert.equal(list.find((g) => g.tool === "list_dir").scope, "always");

      // 文件真的写下来了,user 级收紧为 0600
      const raw = JSON.parse(readFileSync(userFile, "utf8"));
      assert.ok(raw.grants[policyKey("list_dir")]);
      assert.ok(readFileSync(projectFile, "utf8").includes("read_doc"));
    });
  });

  // ── v1.13.1:授权翻译成引擎規則(消掉平行规则源) ─────────────────────────────
  test("policyGrantsAsRules:产出引擎可消费的 {id,tool,decision} 规则", () => {
    const grants = { [policyKey("mcp__s__read_doc")]: { tool: "mcp__s__read_doc", scope: "project" } };
    const rules = policyGrantsAsRules(grants, "project");

    assert.equal(rules.length, 1);
    assert.deepEqual(
      { id: rules[0].id, tool: rules[0].tool, decision: rules[0].decision },
      { id: "mcp-policy:project:mcp__s__read_doc", tool: "mcp__s__read_doc", decision: "allow" }
    );
    assert.deepEqual(rules[0].meta, { source: "mcp-policy", scope: "project" });
  });

  test("policyGrantsAsRules:忽略非工具级 key", () => {
    assert.deepEqual(policyGrantsAsRules({ other: { tool: "x" } }), []);
    assert.deepEqual(policyGrantsAsRules(null), []);
    assert.deepEqual(policyGrantsAsRules(undefined, "always"), []);
  });

  test("asRules:用户级(always)先于项目级(project) —— 顺序即优先级", async () => {
    await withStore(async ({ store }) => {
      store.grant("proj_only", "project");
      store.grant("user_only", "always");
      const rules = store.asRules();

      assert.equal(rules.length, 2);
      assert.equal(rules[0].tool, "user_only", "always 必须在前面:引擎首条命中即返回");
      assert.equal(rules[0].meta.scope, "always");
      assert.equal(rules[1].tool, "proj_only");
    });
  });

  test("策略持久化:revoke 移除对应 scope 的授权", async () => {
    await withStore(async ({ store }) => {
      store.grant("a", "always");
      store.grant("a", "project");
      assert.equal(store.asRules().length, 2);

      store.revoke("a", "always");
      assert.equal(store.asRules().length, 1, "project 级仍在");
      assert.equal(store.asRules()[0].meta.scope, "project");

      store.revoke("a", "project");
      assert.equal(store.asRules().length, 0);
    });
  });

  test("策略持久化:损坏的策略文件按空表处理(不崩)", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "dsc-mcp-policy-"));
    const dir = path.join(base, "project", ".deepseek-code");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "mcp-policy.json"), "{ broken json", "utf8");
      const store = createPolicyStore({ projectRoot: path.join(base, "project"), userRoot: path.join(base, "user") });
      assert.deepEqual(store.asRules(), [], "损坏文件 → 空规则,回到默认保守");
      // 仍然可以继续写入
      assert.equal(store.grant("ok_tool", "project").ok, true);
      assert.equal(store.asRules().length, 1);
      assert.deepEqual(store.list().map((g) => g.tool), ["ok_tool"]);
    } finally {
      await rm(base, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("策略持久化:无 projectRoot 时 project scope 明确失败", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "dsc-mcp-policy-"));
    try {
      const store = createPolicyStore({ projectRoot: null, userRoot: path.join(base, "user") });
      const r = store.grant("a", "project");
      assert.equal(r.ok, false);
      assert.equal(store.grant("a", "always").ok, true, "always 仍可用");
    } finally {
      await rm(base, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-policy-closure.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-policy-closure", async () => {

  /**
   * v1.13.1 验收闭环:持久化授权能否经"策略存储 → 规则 → 引擎"真正生效。
   *
   * v1.13.0 的缺陷正是这条链断开(policyGrants 恒为 null、validateApprovalScope
   * 无生产调用方),所以这里把整条链一次走通,而不是只测单个模块。
   *
   * 每个用例都拿**独立的临时 userRoot** —— 否则 always 级授权会写进真实主目录,
   * 并在用例之间互相污染。
   */

  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { mkdtemp } = await import("../../helpers/tmp.js");
  const { createPolicyStore, policyGrantsAsRules, validateApprovalScope, normalizeApprovalScope, policyKey } = await import("../../../src/tools/mcp/tool-policy.js");
  const { createPermissionEngine } = await import("../../../src/tools/permissions/permission-engine.js");
  const { createPolicyContext } = await import("../../../src/tools/permissions/policy-loader.js");

  const engine = createPermissionEngine();

  async function withStore(fn) {
    const base = await mkdtemp(path.join(tmpdir(), "dsc-policy-closure-"));
    try {
      const store = createPolicyStore({
        projectRoot: path.join(base, "repo"),
        userRoot: path.join(base, "home")
      });
      await fn({ store });
    } finally {
      await rm(base, { recursive: true, force: true }).catch(() => {});
    }
  }

  function decideWith(store, toolCall, { autonomy = "read-only" } = {}) {
    // 这正是 createKernel 里 mergeProjectRules() 的合并顺序:MCP 策略在前
    const rules = [...(store.asRules())];
    return engine.decide(toolCall, createPolicyContext({ autonomy, projectRules: rules }));
  }

  test("闭环:用户在批准菜单选『本项目』→ 该工具之后不再询问", async () => {
    await withStore(({ store }) => {
      const call = { name: "mcp__fs__write_file", category: "mutate", params: { path: "src/a.js" }, autoApprove: false };
      assert.equal(decideWith(store, call).decision, "deny", "授权前:read-only 下写操作应被拒");

      // 用户点"本项目"
      const verdict = validateApprovalScope({ category: call.category, scope: "project", toolName: call.name });
      assert.equal(verdict.ok, true);
      assert.equal(store.grant(call.name, verdict.scope).ok, true);

      const after = decideWith(store, call);
      assert.equal(after.decision, "allow", "授权后必须放行 —— 闭环的关键断言");
      assert.equal(after.source, "project-rules");
      assert.equal(after.matched_rule, "mcp-policy:project:mcp__fs__write_file");

      // 别的工具不受影响
      const other = decideWith(store, { ...call, name: "mcp__fs__delete_file" });
      assert.equal(other.decision, "deny", "未被授权的工具不得被顺带放行");
    });
  });

  test("闭环:用户选『永久』→ 用户级优先于项目级", async () => {
    await withStore(({ store }) => {
      store.grant("mcp__a__t", "always");
      store.grant("mcp__a__t", "project");

      const rules = store.asRules();
      // 两级授权各自落在独立文件,因此是两条规则;靠**顺序**表达优先级
      assert.equal(rules.length, 2);
      assert.equal(rules[0].meta.scope, "always", "always 必须排在前面:引擎首条命中即返回");
      assert.equal(rules[1].meta.scope, "project");

      const result = engine.decide(
        { name: "mcp__a__t", category: "mutate", params: {} },
        createPolicyContext({ autonomy: "read-only", projectRules: rules })
      );
      assert.equal(result.decision, "allow");
      assert.equal(result.matched_rule, "mcp-policy:always:mcp__a__t", "应命中 always 而非 project");
    });
  });

  test("闭环:destructive 即使在批准菜单也拿不到 project / always", async () => {
    await withStore(({ store }) => {
      const destructive = { name: "mcp__db__drop_table", category: "destructive", params: {}, autoApprove: true };

      // 用户在菜单点了"永久"
      const verdict = validateApprovalScope({ category: "destructive", scope: "always", toolName: destructive.name });
      assert.equal(verdict.ok, false, "必须被拒绝");
      assert.equal(verdict.scope, "session", "降级为仅本次");
      assert.equal(verdict.locked, true);

      // 即使真的写进文件(例如手改 JSON),引擎也一律拒绝
      store.grant(destructive.name, "always");
      const result = decideWith(store, destructive, { autonomy: "full-auto" });
      assert.equal(result.decision, "deny");
      assert.equal(result.source, "safety-invariant");
    });
  });

  test("闭环:session 作用域只进内存缓存,不落盘", async () => {
    await withStore(({ store }) => {
      assert.equal(store.grant("mcp__s__t", "session").ok, false, "session 不落盘");
      assert.deepEqual(store.asRules(), []);
      assert.equal(store.list().length, 0);
    });
  });

  test("闭环:策略规则支持参数作用域(pattern),与内置 projectRules 体验一致", async () => {
    await withStore(({ store }) => {
      // 用户可在 mcp-policy.json 里手写带 pattern 的规则(与内置 projectRules 同格式)
      const rules = [
        ...store.asRules(),
        { id: "mcp-policy:project:mcp__fs__write_file", tool: "mcp__fs__write_file", pattern: "src/**", decision: "allow" }
      ];
      const base = { name: "mcp__fs__write_file", category: "mutate", autoApprove: false };
      const decide = (p) => engine.decide({ ...base, params: p }, createPolicyContext({ autonomy: "read-only", projectRules: rules }));

      assert.equal(decide({ path: "src/a.js" }).decision, "allow", "pattern 内放行");
      assert.equal(decide({ path: "docs/readme.md" }).decision, "deny", "pattern 外不得放行");
    });
  });

  test("闭环:normalizeApprovalScope 与 policyKey 契约", () => {
    assert.equal(normalizeApprovalScope("ALWAYS"), "always");
    assert.equal(normalizeApprovalScope("nope"), null);
    assert.equal(policyKey("mcp__a__b"), "tool:mcp__a__b");
    assert.deepEqual(policyGrantsAsRules({ [policyKey("t")]: { tool: "t" } }, "project")[0].tool, "t");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/mcp-security.test.js
// ---------------------------------------------------------------------------
describe("unit/mcp-security", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createPermissionEngine } = await import("../../../src/tools/permissions/permission-engine.js");

  test("PermissionEngine evaluates MCP tools based on category and autonomy", () => {
    const engine = createPermissionEngine();

    // 1. Read category allows under gated
    const readCall = {
      id: "call-1",
      name: "mcp__db__query",
      category: "read",
      params: { sql: "SELECT * FROM users" }
    };
    const readDecision = engine.decide(readCall, { autonomy: "gated" });
    assert.equal(readDecision.decision, "allow");

    // 2. Mutate category asks under gated
    const mutateCall = {
      id: "call-2",
      name: "mcp__db__drop_table",
      category: "mutate",
      params: { sql: "DROP TABLE users" }
    };
    const mutateDecision = engine.decide(mutateCall, { autonomy: "gated" });
    assert.equal(mutateDecision.decision, "ask");

    // 3. Mutate category allows under full-auto
    const autoDecision = engine.decide(mutateCall, { autonomy: "full-auto" });
    assert.equal(autoDecision.decision, "allow");

    // 4. Mutate category denies under read-only
    const readOnlyDecision = engine.decide(mutateCall, { autonomy: "read-only" });
    assert.equal(readOnlyDecision.decision, "deny");

    // 5. Destructive always denies
    const destructiveCall = {
      id: "call-3",
      name: "mcp__fs__format_disk",
      category: "destructive"
    };
    const destructiveDecision = engine.decide(destructiveCall, { autonomy: "full-auto" });
    assert.equal(destructiveDecision.decision, "deny");
  });

  test("PermissionEngine honors autoApprove on tool call", () => {
    const engine = createPermissionEngine();

    const mutateCallWithApproval = {
      id: "call-4",
      name: "mcp__github__create_issue",
      category: "mutate",
      autoApprove: true,
      params: { title: "Bug" }
    };

    const decision = engine.decide(mutateCallWithApproval, { autonomy: "gated" });
    assert.equal(decision.decision, "allow");
    assert.equal(decision.matched_rule, "mcp:auto-approve");
  });
});
