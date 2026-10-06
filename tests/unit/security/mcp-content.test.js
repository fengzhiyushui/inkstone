import test from "node:test";
import assert from "node:assert/strict";
import { createMcpDisplayRedactor, sanitizeMcpDisplay } from "../../../src/security/mcp-content.js";

test("MCP presentation redacts known credentials, nested secrets and binary payloads", () => {
  const clean = createMcpDisplayRedactor({ config: { apiKey: "opaque-api", mcpServers: { srv: { headers: { Authorization: "Bearer opaque-auth" } } } },
    hub: { inputs: { userInput: { value: "opaque-input" } } } });
  const result = clean({ contents: [{ text: "opaque-api opaque-auth opaque-input sk-secret123456", blob: "c2VjcmV0" }],
    messages: [{ content: { type: "image", data: "raw-image" } }], password: "plain", nextCursor: "opaque-cursor" });
  assert.doesNotMatch(JSON.stringify(result), /opaque-api|opaque-auth|opaque-input|sk-secret123456|c2VjcmV0|raw-image|plain/);
  assert.equal(result.nextCursor, "opaque-cursor");
  assert.match(result.contents[0].text, /REDACTED/);
  assert.equal(result.contents[0].blob, "[binary omitted]");
  assert.deepEqual(clean({ structuredContent: { data: { count: 1 }, label: "ok" } }), { structuredContent: { data: { count: 1 }, label: "ok" } });
  assert.deepEqual(clean({ data: "ordinary text" }), { data: "ordinary text" });
});

test("MCP presentation bounds recursion and reports omission rather than throwing", () => {
  const cyclic = { text: "visible" };
  cyclic.self = cyclic;
  const result = sanitizeMcpDisplay(cyclic, { config: cyclic });
  assert.equal(result.truncated, true);
  assert.equal(result.displayTruncated, true);
  assert.match(result.self, /circular/);
  let deep = { text: "end" };
  for (let i = 0; i < 100; i++) deep = { child: deep };
  const bounded = sanitizeMcpDisplay(deep);
  assert.equal(bounded.truncated, true);
  assert.match(JSON.stringify(bounded), /depth limit/);
});

test("MCP presentation scrubs secret object keys and preserves colliding fields", () => {
  const result = sanitizeMcpDisplay({ structuredContent: { "opaque-a": 1, "opaque-b": 2, "[REDACTED]": 3 } },
    { knownSecrets: ["opaque-a", "opaque-b"] });
  assert.doesNotMatch(JSON.stringify(result), /opaque-a|opaque-b/);
  assert.deepEqual(result.structuredContent, { "[REDACTED]": 1, "[REDACTED]#2": 2, "[REDACTED]#3": 3 });
});
