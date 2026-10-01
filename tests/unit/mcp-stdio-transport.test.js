import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { StdioTransport } from "../../src/tools/mcp/stdio-transport.js";

test("StdioTransport filters sensitive environment variables while retaining system paths", () => {
  const origKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DEEPSEEK_API_KEY = "sk-super-secret-key-that-should-not-leak";
    const transport = new StdioTransport({
      command: "node",
      env: { CUSTOM_VAR: "allowed_value" }
    });

    const env = transport.getSafeEnvironment();
    assert.equal(env.DEEPSEEK_API_KEY, undefined, "Sensitive API key must not be passed");
    assert.equal(env.CUSTOM_VAR, "allowed_value", "Configured environment variable must be passed");
    assert.ok(env.PATH || env.Path, "System PATH must be preserved");
  } finally {
    if (origKey !== undefined) {
      process.env.DEEPSEEK_API_KEY = origKey;
    } else {
      delete process.env.DEEPSEEK_API_KEY;
    }
  }
});

test("StdioTransport communicates with a live child process over stdio line protocol", async () => {
  // A small Node.js echo worker that parses JSON from stdin and echoes back a response
  const workerScript = `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.method === 'ping') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'pong' }) + '\\n');
        }
      } catch (e) {}
    });
  `;

  const transport = new StdioTransport({
    command: process.execPath,
    args: ["-e", workerScript]
  });

  const receivedMessages = [];
  transport.on("message", (msg) => {
    receivedMessages.push(msg);
  });

  transport.start();
  assert.equal(transport.state, "running");

  transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });

  // Wait for response
  for (let i = 0; i < 50; i++) {
    if (receivedMessages.length > 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.equal(receivedMessages.length, 1);
  assert.deepEqual(receivedMessages[0], { jsonrpc: "2.0", id: 1, result: "pong" });

  await transport.close();
  assert.equal(transport.state, "stopped");
});

test("StdioTransport buffers stderr output for diagnostics", async () => {
  const workerScript = `
    console.error('stderr diagnostic line 1');
    console.error('stderr diagnostic line 2');
    setTimeout(() => process.exit(0), 50);
  `;

  const transport = new StdioTransport({
    command: process.execPath,
    args: ["-e", workerScript]
  });

  transport.start();

  await new Promise((resolve) => transport.on("close", resolve));

  const recentStderr = transport.getRecentStderr();
  assert.match(recentStderr, /stderr diagnostic line 1/);
  assert.match(recentStderr, /stderr diagnostic line 2/);

  await transport.close();
});
