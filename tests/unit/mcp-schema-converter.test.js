import test from "node:test";
import assert from "node:assert/strict";
import {
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

  const parsed1 = parseExternalToolName(name1);
  assert.deepEqual(parsed1, { serverId: "postgres", originalName: "query_table" });

  // Sanitizes special chars
  const name2 = formatExternalToolName("@company/mcp-server.v1", "read/file.txt");
  assert.equal(name2, "mcp___company_mcp-server_v1__read_file_txt");

  const parsed2 = parseExternalToolName(name2);
  assert.deepEqual(parsed2, { serverId: "_company_mcp-server_v1", originalName: "read_file_txt" });

  assert.equal(parseExternalToolName("builtin_read"), null);
  assert.equal(parseExternalToolName(""), null);
});

test("cleanJsonSchema removes $schema and non-standard fields", () => {
  const dirty = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      url: {
        type: "string",
        $schema: "http://json-schema.org/draft-07/schema#",
        description: "The URL to fetch"
      }
    },
    required: ["url"],
    additionalProperties: false
  };

  const cleaned = cleanJsonSchema(dirty);
  assert.equal(cleaned.$schema, undefined);
  assert.equal(cleaned.type, "object");
  assert.deepEqual(cleaned.required, ["url"]);
  assert.equal(cleaned.properties.url.description, "The URL to fetch");
  assert.equal(cleaned.properties.url.$schema, undefined);
});

test("inferCategory detects read vs mutate from tool semantics", () => {
  assert.equal(inferCategory("query_users", "Fetch user records"), "read");
  assert.equal(inferCategory("list_tables", "Lists database tables"), "read");
  assert.equal(inferCategory("read_file", "Reads content"), "read");

  assert.equal(inferCategory("drop_table", "Drops a table"), "mutate");
  assert.equal(inferCategory("create_user", "Inserts user"), "mutate");
  assert.equal(inferCategory("execute_sql", "Runs arbitrary SQL"), "mutate");
  assert.equal(inferCategory("delete_row", "Deletes a row"), "mutate");
});

test("formatToolResult extracts text and error flags", () => {
  const success = {
    content: [{ type: "text", text: "query output 123" }],
    isError: false
  };
  assert.equal(formatToolResult(success), "query output 123");

  const multiText = {
    content: [
      { type: "text", text: "row 1" },
      { type: "text", text: "row 2" }
    ]
  };
  assert.equal(formatToolResult(multiText), "row 1\nrow 2");

  const errorResult = {
    content: [{ type: "text", text: "table does not exist" }],
    isError: true
  };
  assert.equal(formatToolResult(errorResult), "[MCP Error] table does not exist");
});

test("mcpToolToDeepSeekSchema formats OpenAI/DeepSeek function schema", () => {
  const mcpTool = {
    name: "fetch_page",
    description: "Fetches a web page",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" }
      },
      required: ["url"]
    }
  };

  const schema = mcpToolToDeepSeekSchema("browser", mcpTool);
  assert.equal(schema.type, "function");
  assert.equal(schema.function.name, "mcp__browser__fetch_page");
  assert.equal(schema.function.description, "[MCP: browser] Fetches a web page");
  assert.equal(schema.function.parameters.type, "object");
  assert.deepEqual(schema.function.parameters.required, ["url"]);
});
