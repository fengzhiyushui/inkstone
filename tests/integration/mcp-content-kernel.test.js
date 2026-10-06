import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { createKernel } from "../../src/index.js";
import { mkdtemp } from "../helpers/tmp.js";

// Real stdio transport and kernel/runtime, with a local deterministic model.
// No model API, remote MCP endpoint or user credentials are used.
const secret = "fixture-private-value-76342";
const serverScript = `
  const rl = require('readline').createInterface({ input: process.stdin });
  rl.on('line', line => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) return;
    if (msg.method === 'resources/read' && msg.params.uri === 'memory://error') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Resource failed: ${secret}' } }) + '\\n');
      return;
    }
    let result;
    switch (msg.method) {
      case 'server/discover': result = { era: 'modern', supportedVersions: ['2026-07-28'], capabilities: { resources: {}, prompts: {} } }; break;
      case 'resources/list': result = { resources: [{ uri: 'memory://sprint', name: 'Sprint plan' }] }; break;
      case 'resources/read': result = { contents: [{ uri: msg.params.uri, text: 'RESOURCE_PROOF: finish E1-E6; ${secret}' }] }; break;
      case 'templates/list': result = { resourceTemplates: [{ uriTemplate: 'memory://{name}', name: 'Plans' }] }; break;
      case 'prompts/list': result = { prompts: [{ name: 'review', arguments: [{ name: 'topic', required: true }] }] }; break;
      case 'prompts/get': result = { messages: [{ role: 'system', content: { type: 'text', text: 'PROMPT_PROOF: review ' + msg.params.arguments.topic } }] }; break;
      default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unexpected request: ' + msg.method } }) + '\\n'); return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  });
`;

test("MCP resource and prompt content reaches the model through tool messages with capability lifecycle and redaction", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "inkstone-mcp-content-"));
  let invocation = 0;
  const kernel = await createKernel(root, {
    sessionLog: null, mcpPolicyStore: null,
    orchestration: { router: { model: { enabled: false } } },
    mcpServers: { content: { command: process.execPath, args: ["-e", serverScript], env: { API_TOKEN: secret } } },
    modelGateway: {
      invoke: async (messages, options) => {
        invocation++;
        assert.ok(options.tools.some((tool) => tool.function.name === "mcp_resources"));
        assert.ok(options.tools.some((tool) => tool.function.name === "mcp_prompts"));
        const call = (id, name, args) => ({ content: "", tool_calls: [{ id, name, arguments: args }] });
        if (invocation === 1) return call("list", "mcp_resources", { server: "content" });
        const resultText = messages.filter((msg) => msg.role === "tool").map((msg) => msg.content).join("\n");
        if (invocation === 2) {
          assert.match(resultText, /memory:\/\/sprint/);
          return call("read", "mcp_resources", { server: "content", action: "read", uri: "memory://sprint" });
        }
        assert.match(resultText, /RESOURCE_PROOF/);
        assert.ok(!resultText.includes(secret));
        assert.match(resultText, /REDACTED/);
        if (invocation === 3) return call("prompt", "mcp_prompts", { server: "content", action: "get", name: "review", arguments: { topic: "E1-E6" } });
        assert.match(resultText, /PROMPT_PROOF: review E1-E6/);
        assert.ok(messages.filter((msg) => msg.role === "system").every((msg) => !String(msg.content).includes("PROMPT_PROOF")), "external prompt roles must remain quoted tool data");
        return { content: "Verified resource and prompt context", tool_calls: [] };
      },
      reply: async () => ({ content: "offline" })
    }
  });
  t.after(() => kernel.dispose());
  assert.equal(kernel.mcp.listServers()[0].status, "CONNECTED", "resources-only server must not probe tools/list");
  const result = await kernel.agent.send("Read the sprint resource and its review prompt", { autonomy: "read-only" });
  assert.equal(result.status, "complete");
  assert.equal(invocation, 4);
  assert.equal((await kernel.mcp.listResourceTemplates("content")).resourceTemplates.length, 1);
  assert.equal((await kernel.mcp.listPrompts("content")).prompts[0].name, "review");

  const failure = await kernel.tools.execute({ id: "rpc-error", name: "mcp_resources", params: { server: "content", action: "read", uri: "memory://error" } }, { autonomy: "read-only" });
  assert.equal(failure.status, "error");
  assert.match(failure.content[0].text, /Resource failed/);
  assert.ok(!JSON.stringify(failure).includes(secret), "RPC errors must be scrubbed before ToolExecutor publishes them");

  const invalid = await kernel.tools.execute({ id: "invalid", name: "mcp_resources", params: { server: "unknown", action: "list" } }, { autonomy: "read-only" });
  assert.equal(invalid.status, "error");
  await kernel.mcp.toggleServer("content", false);
  assert.equal(kernel.tools.registry.resolve("mcp_resources"), null);
  assert.equal(kernel.tools.registry.resolve("mcp_prompts"), null);
  await assert.rejects(kernel.mcp.readResource("content", "memory://sprint"), /disabled/i);
  await kernel.mcp.toggleServer("content", true);
  assert.ok(kernel.tools.registry.resolve("mcp_resources"));
  await kernel.mcp.removeServer("content");
  assert.equal(kernel.tools.registry.resolve("mcp_resources"), null);
});
