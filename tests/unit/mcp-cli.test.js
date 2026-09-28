import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../../src/cli.js";

test("CLI mcp list handles empty config and prints guidance", async () => {
  const origLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));

  try {
    await runCli(["mcp", "list"]);
    const text = logs.join("\n");
    assert.match(text, /当前项目未配置任何 MCP 服务|已配置的 MCP 服务/);
  } finally {
    console.log = origLog;
  }
});

test("CLI mcp check validates arguments", async () => {
  await assert.rejects(
    async () => await runCli(["mcp", "check"]),
    /请指定要测试的 MCP 服务标识/
  );

  await assert.rejects(
    async () => await runCli(["mcp", "check", "non-existent-server-id"]),
    /未找到名为 "non-existent-server-id" 的 MCP 服务配置/
  );
});

test("CLI help output includes inkstone mcp command", async () => {
  const origLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));

  try {
    await runCli(["help"]);
    const text = logs.join("\n");
    assert.match(text, /inkstone mcp/);
    assert.match(text, /MCP 外部扩展服务与工具/);
  } finally {
    console.log = origLog;
  }
});
