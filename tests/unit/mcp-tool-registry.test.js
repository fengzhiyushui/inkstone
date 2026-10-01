import test from "node:test";
import assert from "node:assert/strict";
import { createToolRegistry } from "../../src/tools/registry.js";
import { formatExternalToolName, mcpToolToDeepSeekSchema } from "../../src/tools/mcp/schema-converter.js";

test("ToolRegistry dynamic mounting and unmounting of external tools", () => {
  const registry = createToolRegistry();

  const externalTool = {
    name: "mcp__pg__query",
    description: "[MCP: pg] Run SQL",
    category: "read",
    source: "mcp",
    serverId: "pg",
    originalName: "query",
    rawFunctionSchema: {
      type: "function",
      function: {
        name: "mcp__pg__query",
        description: "[MCP: pg] Run SQL",
        parameters: { type: "object", properties: { sql: { type: "string" } } }
      }
    },
    execute: async (params) => `Executed: ${params.sql}`
  };

  assert.equal(registry.isExternalTool("mcp__pg__query"), true);
  assert.equal(registry.isExternalTool("read"), false);

  // Mount
  registry.mountExternalTools("pg", [externalTool]);

  const resolved = registry.resolve("mcp__pg__query");
  assert.ok(resolved);
  assert.equal(resolved.name, "mcp__pg__query");

  // DeepSeek tools schema export
  const dsTools = registry.toDeepSeekTools();
  assert.equal(dsTools.length, 1);
  assert.equal(dsTools[0].type, "function");
  assert.equal(dsTools[0].function.name, "mcp__pg__query");
  assert.deepEqual(dsTools[0].function.parameters.properties.sql, { type: "string" });

  // Unmount
  registry.unmountExternalTools("pg");
  assert.equal(registry.resolve("mcp__pg__query"), null);
  assert.equal(registry.toDeepSeekTools().length, 0);
});

test("ToolRegistry normalizeParams handles MCP tools without throwing for arbitrary params", () => {
  const registry = createToolRegistry();

  const externalTool = {
    name: "mcp__custom__action",
    description: "Custom",
    category: "mutate",
    source: "mcp",
    rawFunctionSchema: {
      type: "function",
      function: { name: "mcp__custom__action", parameters: {} }
    },
    execute: async () => "ok"
  };

  registry.mountExternalTools("custom", [externalTool]);

  const normalized = registry.normalizeParams("mcp__custom__action", {
    arbitraryField1: 123,
    nested: { a: "b" }
  });

  assert.deepEqual(normalized, { arbitraryField1: 123, nested: { a: "b" } });
});
