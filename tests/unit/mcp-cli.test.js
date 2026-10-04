import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.js";
import { mkdtemp } from "../helpers/tmp.js";

/**
 * runCli 以 process.cwd() 作为项目根,没有 cwd 参数。测试里临时切目录,
 * 并保证无论断言如何失败都还原(否则会污染同进程的其它测试)。
 */
async function withProjectDir(root, fn) {
  const previous = process.cwd();
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

async function writeProjectConfig(root, mcpServers) {
  await mkdir(path.join(root, ".deepseek-code"), { recursive: true });
  await writeFile(
    path.join(root, ".deepseek-code", "config.json"),
    JSON.stringify({ mcpServers }),
    "utf8"
  );
}

/** 起一个最小 Streamable HTTP mock,返回 { url, close }。 */
async function startMockHttpServer() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const msg = JSON.parse(body);
      const send = (p) => {
        const t = JSON.stringify(p);
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(t) });
        res.end(t);
      };
      if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
      if (msg.method === "server/discover") {
        send({
          jsonrpc: "2.0", id: msg.id,
          result: {
            era: "modern",
            protocolVersion: "2026-07-28",
            supportedVersions: ["2026-07-28"],
            serverInfo: { name: "cli-mock", version: "9.9" },
            capabilities: {}
          }
        });
      } else if (msg.method === "tools/list") {
        send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "Ping the server" }] } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nf" } });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((r) => server.close(r))
  };
}

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

test("CLI mcp add and remove validate arguments", async () => {
  await assert.rejects(
    async () => await runCli(["mcp", "add"]),
    /请指定有效的 MCP 服务标识/
  );

  await assert.rejects(
    async () => await runCli(["mcp", "add", "bad id with space!"]),
    /请指定有效的 MCP 服务标识/
  );

  await assert.rejects(
    async () => await runCli(["mcp", "add", "my_srv"]),
    /必须指定 --command/
  );

  await assert.rejects(
    async () => await runCli(["mcp", "remove"]),
    /请指定要移除的 MCP 服务标识/
  );

  await assert.rejects(
    async () => await runCli(["mcp", "remove", "no_such_server"]),
    /未找到名为 "no_such_server" 的 MCP 服务配置/
  );
});

// ── v1.12.0:远程(Streamable HTTP)服务的 CLI 支持 ───────────────────────────
test("CLI mcp add 支持 --url 并以 streamable-http 记录", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-mcp-"));
  const origLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await withProjectDir(root, () => runCli(["mcp", "add", "remote1", "--url", "https://mcp.example/mcp"]));
    const text = logs.join("\n");
    assert.match(text, /已成功添加并保存/);
    assert.match(text, /mcp\.example/);

    const saved = JSON.parse(await readFile(path.join(root, ".deepseek-code", "config.json"), "utf8"));
    assert.equal(saved.mcpServers.remote1.url, "https://mcp.example/mcp");
    assert.equal(saved.mcpServers.remote1.type, "streamable-http");
    assert.ok(!saved.mcpServers.remote1.command, "远程服务不应写入 command");
  } finally {
    console.log = origLog;
  }
});

test("CLI mcp add 拒绝非法 --headers JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-mcp-"));
  await assert.rejects(
    () => withProjectDir(root, () => runCli(["mcp", "add", "bad_hdr", "--url", "https://x.example/mcp", "--headers", "not-json"])),
    /--headers 必须是 JSON 对象/
  );
});

test("CLI mcp check 连通真实 Streamable HTTP 服务并列出工具", async () => {
  const mock = await startMockHttpServer();
  const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-mcp-"));
  await writeProjectConfig(root, { local: { url: mock.url, type: "streamable-http", allowlist: ["127.0.0.1"] } });

  const origLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await withProjectDir(root, () => runCli(["mcp", "check", "local"]));
    const text = logs.join("\n");
    assert.match(text, /连接成功/);
    assert.match(text, /cli-mock/);
    assert.match(text, /ping/);
    assert.match(text, /modern/, "应显示协商到的协议模式");
  } finally {
    console.log = origLog;
    await mock.close();
  }
});

test("CLI mcp check 对私网目标默认拒绝(需显式放行)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-mcp-"));
  await writeProjectConfig(root, { blocked: { url: "http://10.0.0.5/mcp", type: "streamable-http" } });
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await assert.rejects(
      () => withProjectDir(root, () => runCli(["mcp", "check", "blocked"])),
      /blocked private network|blocked/i
    );
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});

test("CLI mcp list 标注远程类型与 legacy SSE 弃用提示", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-mcp-"));
  await writeProjectConfig(root, {
    modern: { url: "https://a.example/mcp", type: "streamable-http" },
    legacy: { url: "https://b.example/sse", type: "sse" }
  });
  const origLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await withProjectDir(root, () => runCli(["mcp", "list"]));
    const text = logs.join("\n");
    assert.match(text, /streamable-http/);
    assert.match(text, /\[sse\]/);
    assert.match(text, /legacy SSE 传输已废弃/);
  } finally {
    console.log = origLog;
  }
});

// ── v1.13.0:trust 与持久放行策略 ───────────────────────────────────────────
test("CLI mcp add --trust 写入 trust 并提示风险", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-mcp-"));
  const origLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await withProjectDir(root, () => runCli(["mcp", "add", "trusted_srv", "--command", "npx", "--trust"]));
    assert.match(logs.join("\n"), /已信任/);

    const saved = JSON.parse(await readFile(path.join(root, ".deepseek-code", "config.json"), "utf8"));
    assert.equal(saved.mcpServers.trusted_srv.trust, true);
  } finally {
    console.log = origLog;
  }
});

test("CLI mcp add 未加 --trust 时不写 trust 字段", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-mcp-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    await withProjectDir(root, () => runCli(["mcp", "add", "plain_srv", "--command", "npx"]));
    const saved = JSON.parse(await readFile(path.join(root, ".deepseek-code", "config.json"), "utf8"));
    assert.ok(!("trust" in saved.mcpServers.plain_srv), "默认不得写 trust,保持最小惊讶");
  } finally {
    console.log = origLog;
  }
});

/** 把 DEEPSEEK_CODE_HOME 指到临时目录,避免测试写进真实主目录。 */
async function withIsolatedHome(fn) {
  const orig = process.env.DEEPSEEK_CODE_HOME;
  process.env.DEEPSEEK_CODE_HOME = await mkdtemp(path.join(tmpdir(), "dsc-cli-policy-home-"));
  try {
    return await fn(process.env.DEEPSEEK_CODE_HOME);
  } finally {
    if (orig === undefined) delete process.env.DEEPSEEK_CODE_HOME;
    else process.env.DEEPSEEK_CODE_HOME = orig;
  }
}

test("CLI mcp policy list 空/有记录两种情形", async () => {
  await withIsolatedHome(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-policy-"));
    await writeProjectConfig(root, { s: { command: "npx" } });
    const origLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await withProjectDir(root, () => runCli(["mcp", "policy", "list"]));
      assert.match(logs.join("\n"), /当前没有持久放行记录/);

      const { createPolicyStore } = await import("../../src/tools/mcp/tool-policy.js");
      createPolicyStore({ projectRoot: root }).grant("mcp__s__read_doc", "project");

      logs.length = 0;
      await withProjectDir(root, () => runCli(["mcp", "policy", "list"]));
      const text = logs.join("\n");
      assert.match(text, /持久放行记录/);
      assert.match(text, /mcp__s__read_doc/);
      assert.match(text, /本项目/);
      assert.match(text, /破坏性/, "应提示 destructive 不可持久放行");
    } finally {
      console.log = origLog;
    }
  });
});

test("CLI mcp policy revoke 撤销两个作用域的授权", async () => {
  await withIsolatedHome(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-policy-"));
    await writeProjectConfig(root, { s: { command: "npx" } });
    const origLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      const { createPolicyStore } = await import("../../src/tools/mcp/tool-policy.js");
      const store = createPolicyStore({ projectRoot: root });
      store.grant("mcp__s__t", "project");
      store.grant("mcp__s__t", "always");
      assert.equal(store.grantedKeys().size, 1);

      await withProjectDir(root, () => runCli(["mcp", "policy", "revoke", "mcp__s__t"]));
      assert.match(logs.join("\n"), /已撤销/);

      assert.equal(createPolicyStore({ projectRoot: root }).grantedKeys().size, 0, "两个作用域都应被撤销");
    } finally {
      console.log = origLog;
    }
  });
});

test("CLI mcp policy revoke 缺少工具名时报错", async () => {
  await withIsolatedHome(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-cli-policy-"));
    await writeProjectConfig(root, { s: { command: "npx" } });
    await assert.rejects(
      () => withProjectDir(root, () => runCli(["mcp", "policy", "revoke"])),
      /请指定要撤销的工具名/
    );
  });
});
