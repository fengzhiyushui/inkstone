import test from "node:test";
import assert from "node:assert/strict";
import { runCli, runMcp } from "../../src/cli.js";

function fixture() {
  const calls = [], output = [];
  let disposed = 0;
  const mcp = { hub: { inputs: { auth: { value: "local-credential" } } } };
  for (const name of ["listResources", "listResourceTemplates", "readResource", "listPrompts", "getPrompt"]) {
    mcp[name] = async (...args) => {
      calls.push([name, ...args]);
      return { supported: true, truncated: true, nextCursor: "server-cursor", contents: [{ text: "local-credential api-local-key", blob: "raw-binary" }] };
    };
  }
  const deps = {
    write: (line) => output.push(line), loadConfigImpl: async () => ({ apiKey: "api-local-key" }),
    buildKernelOptionsImpl: async () => ({ sentinel: true }),
    createKernelImpl: async (_root, options) => {
      assert.equal(options.autoInitMcp, false);
      assert.equal(options.sentinel, true);
      return { mcp, dispose: async () => { disposed++; } };
    }
  };
  return { calls, output, mcp, deps, disposed: () => disposed };
}

test("CLI resources routes lists/templates/read with limits and opaque URI through MCP", async () => {
  const f = fixture();
  const flags = new Map([["max-pages", "2"], ["max-items", "10"], ["max-bytes", "1024"], ["cursor", "opaque=server"]]);
  for (const sub of ["list", "templates", "read"]) {
    await runMcp("/repo", ["resources", "srv", sub, ...(sub === "read" ? ["custom://thing?x=1"] : [])], flags, f.deps);
  }
  assert.deepEqual(f.calls.map((call) => call[0]), ["listResources", "listResourceTemplates", "readResource"]);
  assert.deepEqual(f.calls[2], ["readResource", "srv", "custom://thing?x=1", { maxPages: 2, maxItems: 10, maxBytes: 1024, cursor: "opaque=server" }]);
  assert.equal(f.disposed(), 3);
  assert.doesNotMatch(f.output.join("\n"), /local-credential|api-local-key|raw-binary/);
  assert.match(f.output.join("\n"), /截断/);
});

test("CLI prompts accepts JSON arguments including equals and does not send to an agent", async () => {
  const f = fixture();
  await runCli(["mcp", "prompts", "srv", "get", "review", '--arguments={"context":"a=b","password":"test-secret"}'], { root: "/repo", mcp: f.deps });
  assert.equal(f.calls[0][0], "getPrompt");
  assert.deepEqual(f.calls[0][3], { context: "a=b", password: "test-secret" });
  assert.equal(f.disposed(), 1);
  await runMcp("/repo", ["prompts", "srv"], new Map(), f.deps);
  assert.equal(f.calls.at(-1)[0], "listPrompts");
});

test("CLI content validates before opening a connection and identifies stale local cursors", async () => {
  const f = fixture();
  for (const [args, flags] of [
    [["resources"], []], [["resources", "srv", "read"], []],
    [["prompts", "srv", "get", "review"], [["arguments", '"secret"']]],
    [["resources", "srv"], [["max-items", "0"]]],
    [["resources", "srv"], [["cursor", "inkstone-page:stale"]]]
  ]) await assert.rejects(() => runMcp("/repo", args, new Map(flags), f.deps));
  assert.equal(f.calls.length, 0);
});

test("CLI content shows unsupported state and disposes after redacted failure", async () => {
  const f = fixture();
  f.mcp.listResources = async () => ({ supported: false, resources: [] });
  await runMcp("/repo", ["resources", "srv"], new Map(), f.deps);
  assert.match(f.output.join("\n"), /不支持/);
  f.mcp.readResource = async () => { throw new Error("denied: local-credential"); };
  await assert.rejects(() => runMcp("/repo", ["resources", "srv", "read", "file:///x"], new Map(), f.deps),
    (error) => /REDACTED/.test(error.message) && !error.message.includes("local-credential"));
  assert.equal(f.disposed(), 2);
});
