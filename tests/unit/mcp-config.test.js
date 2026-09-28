import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, normalizeMcpServers } from "../../src/config.js";

test("normalizeMcpServers validates and normalizes server configurations", () => {
  const raw = {
    sqlite: {
      command: "uvx",
      args: ["mcp-server-sqlite", "--db-path", "test.db"],
      env: { DB_MODE: "ro" },
      disabled: false,
      autoApprove: ["read_query"]
    },
    emptyCommand: {
      command: "   ",
      args: []
    },
    disabledServer: {
      command: "npx",
      args: ["-y", "dummy"],
      disabled: true
    },
    invalidEntry: "not an object"
  };

  const normalized = normalizeMcpServers(raw);

  assert.ok(normalized.sqlite);
  assert.equal(normalized.sqlite.command, "uvx");
  assert.deepEqual(normalized.sqlite.args, ["mcp-server-sqlite", "--db-path", "test.db"]);
  assert.deepEqual(normalized.sqlite.env, { DB_MODE: "ro" });
  assert.equal(normalized.sqlite.disabled, false);
  assert.deepEqual(normalized.sqlite.autoApprove, ["read_query"]);
  assert.equal(normalized.sqlite.timeoutMs, 60000);

  assert.equal(normalized.emptyCommand, undefined);
  assert.equal(normalized.invalidEntry, undefined);

  assert.ok(normalized.disabledServer);
  assert.equal(normalized.disabledServer.disabled, true);
});

test("normalizeConfig incorporates mcpServers safely", () => {
  const config = normalizeConfig({
    apiKey: "test-key",
    mcpServers: {
      fetch: {
        command: "node",
        args: ["./fetch-mcp.js"]
      }
    }
  });

  assert.ok(config.mcpServers.fetch);
  assert.equal(config.mcpServers.fetch.command, "node");
  assert.deepEqual(config.mcpServers.fetch.args, ["./fetch-mcp.js"]);
});
