import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { mkdtemp } from "../helpers/tmp.js";

test("createKernel integrates McpHub, exposes kernel.mcp facet, and cleans up on dispose", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inkstone-mcp-kernel-"));

  const mockServerScript = `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.method === 'server/discover') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: 'Method not found' }
          }) + '\\n');
        } else if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { serverInfo: { name: 'kernel-mock' }, capabilities: {} }
          }) + '\\n');
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                {
                  name: 'calc_multiply',
                  description: 'Multiplies two numbers',
                  inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } }
                }
              ]
            }
          }) + '\\n');
        } else if (msg.method === 'tools/call') {
          const a = Number(msg.params?.arguments?.a || 0);
          const b = Number(msg.params?.arguments?.b || 0);
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'text', text: String(a * b) }],
              isError: false
            }
          }) + '\\n');
        }
      } catch (e) {}
    });
  `;

  const kernel = await createKernel(root, {
    deepseek: { apiKey: "test-dummy-key" },
    mcpServers: {
      math: {
        command: process.execPath,
        args: ["-e", mockServerScript],
        autoApprove: ["calc_multiply"]
      }
    }
  });

  try {
    assert.ok(kernel.mcp, "Kernel must expose mcp facet");

    const servers = kernel.mcp.listServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0].serverId, "math");
    assert.equal(servers[0].status, "CONNECTED");
    assert.equal(servers[0].toolCount, 1);

    // Call tool directly via kernel.mcp.callTool
    const directResult = await kernel.mcp.callTool("mcp__math__calc_multiply", { a: 6, b: 7 });
    assert.equal(directResult, "42");

    // Check that tool is registered in kernel tools
    const resolvedTool = kernel.tools.registry.resolve("mcp__math__calc_multiply");
    assert.ok(resolvedTool);
    assert.equal(resolvedTool.autoApprove, true);

    const execResult = await resolvedTool.execute({ a: 8, b: 9 });
    assert.equal(execResult, "72");
  } finally {
    await kernel.dispose();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
