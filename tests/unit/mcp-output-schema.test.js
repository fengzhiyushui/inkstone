import test from "node:test";
import assert from "node:assert/strict";
import { validateOutputSchema } from "../../src/tools/mcp/output-schema.js";
import { toToolExecutionResult, redactStructuredContent } from "../../src/tools/mcp/schema-converter.js";

test("outputSchema validates nested objects, local refs, required and additional properties", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: { count: { type: "integer", minimum: 0 } },
    type: "object", required: ["count"], additionalProperties: false,
    properties: { count: { $ref: "#/$defs/count", maximum: 10 } }
  };
  assert.equal(validateOutputSchema(schema, { count: 3 }).valid, true);
  for (const value of [{}, { count: -1 }, { count: 11 }, { count: 1.5 }, { count: 1, extra: true }]) assert.equal(validateOutputSchema(schema, value).valid, false);
  assert.equal(validateOutputSchema({ $defs: { "a/b": { const: "ok" } }, $ref: "#/$defs/a~1b" }, "ok").valid, true);
});

test("outputSchema enforces tuples, items, uniqueItems and contains bounds", () => {
  const schema = { type: "array", prefixItems: [{ const: "tag" }], items: { type: "integer" }, uniqueItems: true, contains: { type: "integer", minimum: 2 }, minContains: 1, maxContains: 2, minItems: 2, maxItems: 4 };
  assert.equal(validateOutputSchema(schema, ["tag", 1, 2]).valid, true);
  for (const value of [["bad", 2], ["tag", 1], ["tag", 2, 2], ["tag", 2, 3, 4], ["tag", "bad", 2]]) assert.equal(validateOutputSchema(schema, value).valid, false);
  assert.equal(validateOutputSchema({ type: "array", uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }]).valid, false);
});

test("outputSchema supports composition, conditionals and property dependencies", () => {
  const schema = {
    type: "object", properties: { mode: { enum: ["a", "b"] }, count: { type: "number", multipleOf: 0.1 } },
    required: ["mode"], dependentRequired: { count: ["label"] },
    dependentSchemas: { label: { properties: { label: { type: "string", minLength: 1 } } } },
    if: { properties: { mode: { const: "a" } } }, then: { required: ["count"] }, else: { not: { required: ["count"] } }
  };
  assert.equal(validateOutputSchema(schema, { mode: "a", count: 0.3, label: "ok" }).valid, true);
  assert.equal(validateOutputSchema(schema, { mode: "b" }).valid, true);
  for (const value of [{ mode: "a" }, { mode: "a", count: 0.3 }, { mode: "a", count: 0.35, label: "x" }, { mode: "b", count: 1 }]) assert.equal(validateOutputSchema(schema, value).valid, false);
  assert.equal(validateOutputSchema({ allOf: [{ anyOf: [{ type: "null" }, { type: "string" }] }], oneOf: [{ const: null }, { const: "ok" }] }, "ok").valid, true);
  assert.equal(validateOutputSchema({ oneOf: [{ type: "number" }, { type: "integer" }] }, 2).valid, false);
});

test("outputSchema supports safe patterns, Unicode lengths, and patternProperties", () => {
  assert.equal(validateOutputSchema({ type: "string", minLength: 1, maxLength: 1 }, "😀").valid, true);
  assert.equal(validateOutputSchema({ pattern: "^[a-z]+$" }, "abc").valid, true);
  assert.equal(validateOutputSchema({ pattern: "^[a-z]+$" }, "a1").valid, false);
  const schema = { type: "object", propertyNames: { pattern: "^x_[a-z]+$" }, patternProperties: { "^x_": { type: "integer" } }, additionalProperties: false };
  assert.equal(validateOutputSchema(schema, { x_a: 1 }).valid, true);
  assert.equal(validateOutputSchema(schema, { x_a: "bad" }).valid, false);
  assert.equal(validateOutputSchema(schema, { y_a: 1 }).valid, false);
});

test("unsupported assertions fail explicitly even in unselected branches", () => {
  for (const schema of [
    { unevaluatedProperties: false }, { format: "email" }, { $ref: "https://example.invalid/schema" },
    { $defs: { future: { contentEncoding: "base64" } } },
    { anyOf: [true, { $dynamicRef: "#node" }] }, { pattern: "(a+)+$" }, { pattern: "a+a+$" }
  ]) {
    const result = validateOutputSchema(schema, {});
    assert.equal(result.valid, false);
    assert.equal(result.supported, false);
    assert.equal(result.errors[0].code, "MCP_OUTPUT_SCHEMA_UNSUPPORTED");
  }
});

test("invalid schemas and missing structuredContent never count as valid", () => {
  for (const schema of [{ required: "name" }, { type: "unknown" }, { minItems: -1 }, { $ref: "#/missing" }, { items: [] }, { pattern: "[" }]) assert.equal(validateOutputSchema(schema, {}).valid, false);
  assert.equal(validateOutputSchema({}, undefined).valid, false);
  assert.equal(validateOutputSchema(false, {}).valid, false);
  assert.equal(validateOutputSchema(undefined, undefined).skipped, true);
});

test("local recursive schemas terminate and validation budgets fail closed", () => {
  const recursive = { type: "object", properties: { next: { anyOf: [{ type: "null" }, { $ref: "#" }] } }, required: ["next"] };
  assert.equal(validateOutputSchema(recursive, { next: { next: null } }).valid, true);
  assert.equal(validateOutputSchema({ $ref: "#" }, {}).errors[0].code, "MCP_OUTPUT_SCHEMA_LIMIT");
  assert.equal(validateOutputSchema({}, "x".repeat(400_000)).errors[0].code, "MCP_OUTPUT_SCHEMA_LIMIT");
  assert.equal(validateOutputSchema({ pattern: "a+b" }, "a".repeat(4000)).errors[0].code, "MCP_OUTPUT_SCHEMA_LIMIT");
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(validateOutputSchema({}, cyclic).valid, false);
});

test("JSON property names cannot traverse prototypes and getters are not evaluated", () => {
  const value = JSON.parse('{"__proto__":{"safe":true},"toString":1}');
  assert.equal(validateOutputSchema({ type: "object", dependentRequired: {} }, value).valid, true);
  assert.equal(validateOutputSchema({ $ref: "#/__proto__" }, {}).valid, false);
  let accessed = false;
  const withGetter = { get token() { accessed = true; return "secret"; } };
  assert.equal(validateOutputSchema({}, withGetter).valid, false);
  assert.equal(accessed, false);
  assert.throws(() => redactStructuredContent(withGetter), /accessors/);
  assert.equal(accessed, false);
});

test("result adapter validates original data then redacts metadata without mutating input", () => {
  const original = { count: 2, password: "sensitive", nested: { token: "private" }, text: "sk-test_secret_123456" };
  const result = toToolExecutionResult({ content: [{ type: "text", text: "ok" }], structuredContent: original }, { outputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } } } });
  assert.equal(result.status, "success");
  assert.equal(result.metadata.outputValidation.valid, true);
  assert.equal(result.metadata.structuredContent.password, "[REDACTED]");
  assert.equal(result.metadata.structuredContent.nested.token, "[REDACTED]");
  assert.equal(result.metadata.structuredContent.text, "[REDACTED]");
  assert.equal(original.password, "sensitive");
});

test("tool errors and input_required remain errors, schema mismatches are diagnostic", () => {
  const remoteError = toToolExecutionResult({ isError: true, content: [{ type: "text", text: "failed" }] }, { outputSchema: { type: "object" } });
  assert.equal(remoteError.status, "error");
  assert.match(remoteError.content[0].text, /MCP Error/);
  assert.equal(remoteError.metadata.outputValidation, undefined);
  assert.equal(toToolExecutionResult({ resultType: "input_required", content: [] }).metadata.errorCode, "MCP_INPUT_REQUIRED");
  const mismatch = toToolExecutionResult({ structuredContent: { count: "bad" } }, { outputSchema: { properties: { count: { type: "integer" } } } });
  assert.equal(mismatch.status, "error");
  assert.equal(mismatch.metadata.errorCode, "MCP_OUTPUT_SCHEMA_MISMATCH");
  assert.match(mismatch.content[0].text, /validation failed/);
});
