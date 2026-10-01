import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeIdentifier,
  formatExternalToolName,
  parseExternalToolName,
  cleanJsonSchema,
  inferCategory,
  formatToolResult,
  mcpToolToDeepSeekSchema
} from "../../src/tools/mcp/schema-converter.js";

test("formatExternalToolName and parseExternalToolName two-level namespacing", () => {
  const name1 = formatExternalToolName("postgres", "query_table");
  assert.equal(name1, "mcp__postgres__query_table");
  assert.deepEqual(parseExternalToolName(name1), {
    serverId: "postgres",
    originalName: "query_table"
  });

  const name2 = formatExternalToolName("@company/mcp-server.v1", "read/file.txt");
  // server: non [A-Za-z0-9_.-] → _ ; tool keeps dot (spec-legal)
  assert.equal(name2, "mcp___company_mcp-server.v1__read_file.txt");
  assert.deepEqual(parseExternalToolName(name2), {
    serverId: "_company_mcp-server.v1",
    originalName: "read_file.txt"
  });
});

test("sanitizeIdentifier allows spec-legal dots", () => {
  assert.equal(sanitizeIdentifier("admin.tools.list"), "admin.tools.list");
  assert.equal(sanitizeIdentifier("read/file"), "read_file");
});

test("cleanJsonSchema removes $schema and non-standard fields", () => {
  const cleaned = cleanJsonSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      a: { type: "string", $schema: "x" },
      b: { type: "number" }
    },
    required: ["a"],
    additionalProperties: false,
    description: "d"
  });
  assert.equal(cleaned.$schema, undefined);
  assert.equal(cleaned.properties.a.$schema, undefined);
  assert.deepEqual(cleaned.required, ["a"]);
  assert.equal(cleaned.description, "d");
});

test("inferCategory detects read vs mutate from tool semantics", () => {
  assert.equal(inferCategory("get_user", "fetch a user"), "read");
  assert.equal(inferCategory("delete_row", "remove a row"), "mutate");
  assert.equal(inferCategory("do_thing", "execute command"), "mutate");
});

test("formatToolResult extracts text and error flags", () => {
  assert.equal(
    formatToolResult({ content: [{ type: "text", text: "ok" }], isError: false }),
    "ok"
  );
  assert.match(
    formatToolResult({ content: [{ type: "text", text: "boom" }], isError: true }),
    /\[MCP Error\] boom/
  );
});

test("mcpToolToDeepSeekSchema formats OpenAI/DeepSeek function schema", () => {
  const schema = mcpToolToDeepSeekSchema("fs", {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  });
  assert.equal(schema.type, "function");
  assert.equal(schema.function.name, "mcp__fs__read_file");
  assert.match(schema.function.description, /\[MCP: fs\]/);
  assert.equal(schema.function.parameters.required[0], "path");
});
