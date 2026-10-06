import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMcpConfig,
  extractServersFromDocument,
  resolveInputTemplates,
  resolveServerEnvAndHeaders,
  looksLikeSecret,
  auditConfigSecrets,
  normalizeServersMap,
  normalizeServerConfig,
  bindInputs
} from "../../src/tools/mcp/config-loader.js";
import { mkdtempSync } from "../helpers/tmp.js";
import { normalizeMcpServers } from "../../src/config.js";

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
