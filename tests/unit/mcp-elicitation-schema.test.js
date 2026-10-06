import test from "node:test";
import assert from "node:assert/strict";
import { validateElicitationSchema, validateElicitationResponse } from "../../src/tools/mcp/elicitation-schema.js";

const form = (properties = {}, required = []) => ({ type: "object", properties, required });
const assertInvalid = (operation) => assert.throws(operation, (error) => error.code === "MCP_INPUT_INVALID"
  && error.message === "MCP input does not match the supported form schema");

test("elicitation supports scalars, all enum shapes and detached responses without defaults", () => {
  const schema = form({
    text: { type: "string", title: "Label", description: "Description", minLength: 0, maxLength: 20, default: "unused" },
    integer: { type: "integer", minimum: -2, maximum: 4, default: 1 },
    decimal: { type: "number", minimum: 0, maximum: 1 },
    flag: { type: "boolean", default: true },
    plain: { type: "string", enum: ["a", "b"] },
    legacy: { type: "string", enum: ["a", "b"], enumNames: ["Alpha", "Beta"] },
    titled: { type: "string", oneOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }] },
    many: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: ["a", "b"] } },
    titledMany: { type: "array", items: { anyOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }] }, default: ["b"] }
  }, ["integer", "decimal", "flag", "plain", "legacy", "titled", "many", "titledMany"]);
  const normalized = validateElicitationSchema(schema);
  normalized.properties.text.title = "Changed";
  assert.equal(schema.properties.text.title, "Label");
  const value = { integer: 2, decimal: 0.5, flag: false, plain: "a", legacy: "b", titled: "a", many: ["a", "b"], titledMany: ["b"] };
  const result = validateElicitationResponse(schema, value);
  assert.deepEqual(result, value);
  assert.equal(Object.hasOwn(result, "text"), false);
  result.many.push("a");
  assert.deepEqual(value.many, ["a", "b"]);
  assert.deepEqual(validateElicitationResponse(form(), {}), {});
});

test("elicitation rejects nested, ambiguous and unknown schema assertions", () => {
  const badFields = [
    { type: "object", properties: {} }, { type: "array", items: { type: "string" } }, { type: "null" }, { type: ["string", "null"] },
    { type: "string", pattern: ".*" }, { type: "string", $ref: "#" }, { type: "string", minLength: -1 },
    { type: "string", minLength: 2, maxLength: 1 }, { type: "string", format: "password" },
    { type: "integer", minimum: 3, maximum: 1 }, { type: "number", minimum: "1" }, { type: "boolean", default: "true" },
    { type: "string", enum: [] }, { type: "string", enum: ["a", "a"] }, { type: "string", enum: [1] },
    { type: "string", enum: ["a"], oneOf: [{ const: "a", title: "A" }] },
    { type: "string", enum: ["a"], minLength: 1 }, { type: "string", enum: ["a"], enumNames: [] },
    { type: "string", enumNames: ["A"] }, { type: "string", oneOf: [{ const: "a" }] },
    { type: "string", oneOf: [{ const: "a", title: "A", type: "string" }] },
    { type: "string", oneOf: [{ const: "a", title: "A" }, { const: "a", title: "B" }] },
    { type: "array", items: { enum: ["a"] } }, { type: "array", items: { anyOf: [] } },
    { type: "array", items: { type: "string", enum: ["a"], anyOf: [{ const: "a", title: "A" }] } },
    { type: "array", items: { anyOf: [{ const: "a", title: "A" }] }, maxItems: 0.5 },
    { type: "string", default: false }, { type: "integer", default: 1.5 }, { type: "string", enum: ["a"], default: "b" }
  ];
  for (const field of badFields) assertInvalid(() => validateElicitationSchema(form({ privateField: field })));
  for (const schema of [null, [], { type: "object" }, { ...form(), additionalProperties: false }, { ...form(), properties: [] },
    { ...form(), title: "ignored" }, { ...form(), $schema: "https://example.invalid/schema" }, form({}, ["missing"]), form({ a: { type: "string" } }, ["a", "a"])]) {
    assertInvalid(() => validateElicitationSchema(schema));
  }
});

test("elicitation checks required, types, bounds and extra properties without echoing values", () => {
  const schema = form({ privateField: { type: "integer", minimum: 1, maximum: 3 }, value: { type: "string", minLength: 2, maxLength: 3 } }, ["privateField"]);
  for (const content of [{}, { privateField: 0 }, { privateField: 4 }, { privateField: 1.2 }, { privateField: "sensitive-value" },
    { privateField: 1, value: "a" }, { privateField: 1, value: "long" }, { privateField: 1, injectedSecret: "sensitive-value" }, null, [], "sensitive-value"]) {
    assertInvalid(() => validateElicitationResponse(schema, content));
  }
  assert.equal(validateElicitationResponse(schema, { privateField: 1, value: "界字" }).value, "界字");
  const arraySchema = form({ values: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: ["a", "b"] } } });
  for (const values of [[], ["a", "b", "a"], ["c"], [1], [{}], "a"]) assertInvalid(() => validateElicitationResponse(arraySchema, { values }));
});

test("elicitation enforces email, URI, calendar dates and RFC3339 date-time formats", () => {
  const cases = {
    email: { valid: ["a@example.com", "first.last+tag@example.co.uk", '"quoted local"@example.com', "a@[192.0.2.1]", "a@[IPv6:2001:db8::1]"], invalid: ["plain", "a@@example.com", ".a@example.com", "a..b@example.com", "a@-host.com", "a@host..com", "a@example.com\n", "a@例子.com"] },
    uri: { valid: ["https://example.com/path?q=1#anchor", "urn:example:animal:ferret:nose", "mailto:a@example.com", "https://example.com/a%20b"], invalid: ["/relative", "example.com", "https://", "https://example.com/space here", "https://example.com/%no", "https://example.com/\u0000", "https://example.com/界"] },
    date: { valid: ["2024-02-29", "2000-02-29", "0000-01-01"], invalid: ["2023-02-29", "1900-02-29", "2024-04-31", "2024-00-10", "2024-1-01", "2024-01-01Z"] },
    "date-time": { valid: ["2024-02-29T12:34:56Z", "2024-02-29t12:34:56.123z", "2024-02-29T12:34:56+05:30", "2016-12-31T23:59:60Z", "2017-01-01T00:59:60+01:00"], invalid: ["2024-02-29 12:34:56Z", "2023-02-29T12:34:56Z", "2024-01-01T24:00:00Z", "2024-01-01T12:34:56", "2024-01-01T12:34:56+24:00", "2024-01-01T12:34:56+02:60", "2024-01-01T12:34:60Z", "2024-01-01T12:34:61Z"] }
  };
  for (const [format, values] of Object.entries(cases)) {
    const schema = form({ value: { type: "string", format } }, ["value"]);
    assert.equal(validateElicitationSchema(schema).properties.value.format, format);
    for (const value of values.valid) assert.equal(validateElicitationResponse(schema, { value }).value, value, `${format}: ${value}`);
    for (const value of values.invalid) assertInvalid(() => validateElicitationResponse(schema, { value }));
  }
});

test("elicitation bounds schema/content UTF8 bytes, field sizes, fields, depth and nodes", () => {
  const fields = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`f${index}`, { type: "string" }]));
  assert.equal(Object.keys(validateElicitationSchema(form(fields)).properties).length, 64);
  assertInvalid(() => validateElicitationSchema(form({ ...fields, overflow: { type: "string" } })));
  assertInvalid(() => validateElicitationSchema(form({ value: { type: "string", title: "界".repeat(22_000) } })));
  const schema = form({ value: { type: "string" } });
  assert.equal(validateElicitationResponse(schema, { value: "a".repeat(16_384) }).value.length, 16_384);
  assertInvalid(() => validateElicitationResponse(schema, { value: "a".repeat(16_385) }));
  assertInvalid(() => validateElicitationResponse(schema, { value: "界".repeat(5500) }));
  assertInvalid(() => validateElicitationResponse(form(fields), Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`f${index}`, "x".repeat(16_000)]))));
  let deep = {};
  for (let index = 0; index < 70; index++) deep = { next: deep };
  assertInvalid(() => validateElicitationSchema(deep));
  assertInvalid(() => validateElicitationResponse(schema, deep));
  assertInvalid(() => validateElicitationResponse(schema, { value: Array(20_001).fill(null) }));
});

test("elicitation rejects unsafe JSON without evaluating accessors or serialization hooks", () => {
  let reads = 0;
  const accessor = { get privateField() { reads++; return "secret"; } };
  const cyclic = {}; cyclic.self = cyclic;
  const schema = form({ privateField: { type: "string" } });
  for (const content of [accessor, cyclic, { privateField: NaN }, { privateField: Infinity }, { privateField: undefined },
    { privateField: () => "secret" }, new Date(), new Map(), { toJSON() { reads++; return "secret"; } }]) assertInvalid(() => validateElicitationResponse(schema, content));
  assert.equal(reads, 0);
  assertInvalid(() => validateElicitationSchema(form({ privateField: accessor })));
  assert.equal(reads, 0);
  const trickySchema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"boolean"}},"required":["__proto__"]}');
  const trickyContent = JSON.parse('{"__proto__":"private","constructor":false}');
  const result = validateElicitationResponse(trickySchema, trickyContent);
  assert.deepEqual(result, trickyContent);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.prototype.private, undefined);
});
