import test from "node:test";
import assert from "node:assert/strict";
import {
  formatExternalToolName,
  parseExternalToolName,
  MAX_TOOL_NAME_LENGTH,
  formatToolResult,
  summarizeToolResult
} from "../../src/tools/mcp/schema-converter.js";

test("formatExternalToolName stays within 128 chars and is unique on overflow", () => {
  const longName = "a".repeat(200);
  const n1 = formatExternalToolName("server", longName);
  const n2 = formatExternalToolName("server", longName + "b");
  const n3 = formatExternalToolName("server", longName);

  assert.ok(n1.length <= MAX_TOOL_NAME_LENGTH);
  assert.ok(n2.length <= MAX_TOOL_NAME_LENGTH);
  assert.notEqual(n1, n2);
  assert.equal(n1, n3); // stable
});

test("formatExternalToolName keeps short names as mcp__server__tool", () => {
  assert.equal(formatExternalToolName("fs", "read_file"), "mcp__fs__read_file");
  assert.deepEqual(
    parseExternalToolName("mcp__fs__read_file"),
    { serverId: "fs", originalName: "read_file" }
  );
});

test("formatToolResult handles structuredContent and input_required", () => {
  const structured = formatToolResult({
    resultType: "complete",
    content: [{ type: "text", text: "" }],
    structuredContent: { ok: true },
    isError: false
  });
  assert.match(structured, /"ok":true/);

  const inputRequired = formatToolResult({
    resultType: "input_required",
    content: [{ type: "text", text: "need name" }]
  });
  assert.match(inputRequired, /Input Required/);
});

test("summarizeToolResult exposes meta", () => {
  const { text, meta } = summarizeToolResult({
    resultType: "complete",
    content: [{ type: "text", text: "hi" }],
    structuredContent: { x: 1 },
    isError: false
  });
  assert.equal(text, "hi");
  assert.equal(meta.resultType, "complete");
  assert.deepEqual(meta.structuredContent, { x: 1 });
});
