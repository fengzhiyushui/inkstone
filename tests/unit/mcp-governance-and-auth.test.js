// tests/unit/mcp-governance-and-auth.test.js — MCP 治理配置、工具策略、OAuth、表单与诊断
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { normalizeServerConfig, normalizeOAuthConfig } from "../../src/tools/mcp/config-loader.js";
import { parseAnnotations, RISK_LADDER } from "../../src/tools/mcp/annotations.js";
import { normalizeToolPolicy, APPROVAL_SCOPES } from "../../src/tools/mcp/tool-policy.js";
import { McpOAuthClient } from "../../src/tools/mcp/auth/oauth-client.js";
import { createMcpInputBroker } from "../../src/tools/mcp/input-broker.js";
import { McpSubscriptions } from "../../src/tools/mcp/subscriptions.js";
import { diagnosticCategory, summarizeFrame } from "../../src/tools/mcp/diagnostics.js";
import { createMcpToolTrials } from "../../src/tools/mcp/tool-trials.js";

test("normalizeServerConfig 与 normalizeOAuthConfig 格式校验与安全防护", () => {
  const stdioServer = normalizeServerConfig("test_node", { command: "node", args: ["app.js"] });
  assert.equal(stdioServer.command, "node");

  assert.throws(
    () => normalizeServerConfig("invalid_server", { env: {} }),
    /requires 'command' or 'url'/i
  );

  const oauthCfg = normalizeOAuthConfig({
    enabled: true,
    clientId: "client_123",
    scopes: ["read", "write"]
  }, "streamable-http");
  assert.equal(oauthCfg.enabled, true);
  assert.deepEqual(oauthCfg.scopes, ["read", "write"]);

  assert.throws(
    () => normalizeOAuthConfig({ enabled: true, client_secret: "inline_secret" }, "streamable-http"),
    /cannot contain credentials/i
  );
});

test("parseAnnotations 严格解析与风险阶梯判定", () => {
  assert.deepEqual(RISK_LADDER, ["read", "mutate", "destructive"]);

  const readOnly = parseAnnotations({ readOnlyHint: true, destructiveHint: false });
  assert.equal(readOnly.readOnly, true);
  assert.equal(readOnly.destructive, false);

  const destructive = parseAnnotations({ destructiveHint: true });
  assert.equal(destructive.destructive, true);

  const untrustedLoose = parseAnnotations({ readOnlyHint: "yes", destructiveHint: 1 });
  assert.equal(untrustedLoose.readOnly, false);
  assert.equal(untrustedLoose.destructive, false);
});

test("normalizeToolPolicy 工具级开关与三级批准范围", () => {
  assert.deepEqual(APPROVAL_SCOPES, ["session", "project", "always"]);

  const policy = normalizeToolPolicy({
    enabled: ["read_*", "fetch"],
    disabled: ["delete_all"],
    approval: {
      "write_file": "project",
      "restart_server": "always"
    },
    risk: {
      "read_special": "read"
    }
  });

  assert.deepEqual(policy.enabled, ["read_*", "fetch"]);
  assert.deepEqual(policy.disabled, ["delete_all"]);
  assert.equal(policy.approval.write_file, "project");
  assert.equal(policy.approval.restart_server, "always");
  assert.equal(policy.risk.read_special, "read");
});

test("McpOAuthClient 初始状态与状态枚举", () => {
  const activeClient = new McpOAuthClient({
    serverId: "oauth_srv_1",
    config: { oauth: { enabled: true } }
  });
  assert.equal(activeClient.getStatus().status, "unauthenticated");

  const disabledClient = new McpOAuthClient({
    serverId: "oauth_srv_2",
    config: { oauth: { enabled: false } }
  });
  assert.equal(disabledClient.getStatus().status, "disabled");
});

test("createMcpInputBroker 表单暂存与密钥脱敏预算控制", () => {
  const fakeHub = {
    serverConfigs: new Map(),
    clients: new Map(),
    inputSecrets: new Set()
  };

  const broker = createMcpInputBroker({ hub: fakeHub });
  assert.ok(broker);
  assert.ok(fakeHub.inputSecrets instanceof Set);
});

test("McpSubscriptions 订阅生命周期与通知分发", () => {
  const fakeClient = new EventEmitter();
  fakeClient.protocolMode = "legacy";
  fakeClient.serverCapabilities = {};

  const subs = new McpSubscriptions(fakeClient, { enabled: true });
  assert.equal(subs.enabled, true);
  assert.equal(subs.current, null);

  subs.start();
  assert.equal(subs.current, null);
});

test("createMcpDiagnostics 日志记录、级别过滤与分类", () => {
  assert.equal(diagnosticCategory({ code: -32800 }), "cancelled");
  assert.equal(diagnosticCategory({ code: -32000 }), "timeout");
  assert.equal(diagnosticCategory({ code: 401 }), "auth");
  assert.equal(diagnosticCategory({ code: "PERMISSION_DENIED" }), "permission");
  assert.equal(diagnosticCategory(new Error("tool error"), "tools/call"), "tool");

  const frameSummary = summarizeFrame({
    id: 42,
    method: "tools/call",
    result: { content: [{ type: "text", text: "secret" }] }
  });

  assert.equal(frameSummary.requestId, 42);
  assert.equal(frameSummary.method, "tools/call");
  assert.equal(frameSummary.status, "success");
  assert.ok(frameSummary.preview.includes("omitted"));
});

test("createMcpToolTrials 工具试跑沙箱运行与审批控制", () => {
  const fakeHub = new EventEmitter();
  fakeHub.serverConfigs = new Map();

  const trials = createMcpToolTrials({
    hub: fakeHub,
    registry: { resolve: () => null },
    permissionEngine: { decide: () => ({ decision: "allow" }) }
  });

  const notFound = trials.cancel("non_existent_run");
  assert.equal(notFound.status, "not_found");
  assert.equal(notFound.cancelled, false);

  assert.throws(
    () => trials.approve("non_existent_run"),
    /No pending MCP test approval/i
  );

  trials.dispose();
});
