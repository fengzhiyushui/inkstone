// tests/unit/security/security-policies.test.js — 安全策略(SSRF/shell/命令/MCP 内容/路径)领域测试
//
// v1.19.1 测试归并:本文件由下列历史任务单测试合并而成,每个来源包裹在独立
// describe 块中(异步回调 + 动态 import,来源间零共享绑定),测试语义与拆分前一致。
import { describe } from "node:test";

// ---------------------------------------------------------------------------
// 来源:tests/unit/security/ssrf.test.js
// ---------------------------------------------------------------------------
describe("unit/security/ssrf", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { validateFetchUrl, validateResolvedAddress, isPrivateIPv4, isReservedIPv4, isAllowedByList } = await import("../../../src/security/ssrf.js");
  const { redactSecrets } = await import("../../../src/security/redactor.js");

  test("validateFetchUrl allows public https URLs", async () => {
    const result = await validateFetchUrl("https://example.com/docs", {
      lookup: async () => ({ address: "93.184.216.34" })
    });
    assert.equal(result.href, "https://example.com/docs");
  });

  test("validateFetchUrl blocks localhost private and file URLs", async () => {
    await assert.rejects(() => validateFetchUrl("http://localhost:3000"), /blocked/i);
    await assert.rejects(() => validateFetchUrl("http://127.0.0.2"), /blocked/i);
    await assert.rejects(() => validateFetchUrl("file:///etc/passwd"), /unsupported protocol/i);
    await assert.rejects(() => validateFetchUrl("http://192.168.1.10"), /blocked/i);
  });

  test("validateFetchUrl blocks DNS rebinding to private IP", async () => {
    await assert.rejects(
      () => validateFetchUrl("https://safe.test", {
        lookup: async () => ({ address: "10.0.0.5" })
      }),
      /blocked private network/
    );
  });

  test("validateFetchUrl validates every DNS A record and fails if any is internal", async () => {
    let optionsSeen = null;
    await assert.rejects(
      () => validateFetchUrl("https://multi.test", {
        lookup: async (_host, options) => {
          optionsSeen = options;
          return [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }];
        }
      }),
      /blocked private network/
    );
    assert.deepEqual(optionsSeen, { family: 4, all: true });
  });

  test("validateFetchUrl fails if one address is in allowlist but another is an unallowed internal address", async () => {
    await assert.rejects(
      () => validateFetchUrl("https://mixed.test", {
        allowlist: ["192.168.1.10"],
        lookup: async () => [{ address: "192.168.1.10", family: 4 }, { address: "10.0.0.5", family: 4 }]
      }),
      /blocked private network/
    );
  });

  test("validateResolvedAddress blocks reserved IPv4 ranges", () => {
    for (const ip of [
      "0.1.2.3", "100.64.0.1", "100.127.255.254", "192.0.0.8",
      "192.0.2.1", "198.18.0.1", "198.19.255.254", "198.51.100.3",
      "203.0.113.8", "224.0.0.1", "255.255.255.255"
    ]) {
      assert.throws(() => validateResolvedAddress(ip), /blocked reserved network/, ip);
      assert.equal(isReservedIPv4(ip), true, ip);
    }
    assert.equal(isReservedIPv4("93.184.216.34"), false);
  });

  test("validateResolvedAddress blocks IPv4 mapped IPv6 and IPv6 literals", () => {
    assert.throws(() => validateResolvedAddress("::ffff:127.0.0.1", "mapped"), /internal/);
    assert.throws(() => validateResolvedAddress("::1", "loopback"), /IPv6/);
  });

  test("isPrivateIPv4 checks exact private ranges", () => {
    assert.equal(isPrivateIPv4("10.2.3.4"), true);
    assert.equal(isPrivateIPv4("172.16.0.1"), true);
    assert.equal(isPrivateIPv4("172.32.0.1"), false);
    assert.equal(isPrivateIPv4("192.168.1.1"), true);  assert.equal(isPrivateIPv4("8.8.8.8"), false);
  });

  test("redactSecrets redacts common secret assignment forms", () => {
    const text = redactSecrets([
      "Authorization: Bearer bearer-secret",
      "api_key=abc123456789",
      "access_token: token-value",
      "client_secret='client-value'",
      "password=correct-horse-battery-staple"
    ].join("\n"));
    assert.match(text, /Bearer \[REDACTED\]/);
    assert.match(text, /api_key=\[REDACTED\]/);
    assert.match(text, /access_token: \[REDACTED\]/);
    assert.match(text, /client_secret=\[REDACTED\]/);
    assert.match(text, /password=\[REDACTED\]/);
    assert.doesNotMatch(text, /bearer-secret|abc123456789|token-value|client-value|correct-horse/);
  });

  test("redactSecrets redacts object JSON while preserving valid JSON", () => {
    const redacted = redactSecrets({ apiKey: "sk-object-secret", nested: { access_token: "token-object" }, safe: "ok" });
    const parsed = JSON.parse(redacted);
    assert.equal(parsed.apiKey, "[REDACTED]");
    assert.equal(parsed.nested.access_token, "[REDACTED]");
    assert.equal(parsed.safe, "ok");
  });

  test("redactSecrets redacts deterministic AWS GitHub and sk token prefixes", () => {
    const text = redactSecrets([
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "github_pat_0123456789abcdefghijklmnopqrstuvwxyz",
      "sk-abcdefghijklmnop"
    ].join(" "));
    assert.equal((text.match(/\[REDACTED\]/g) || []).length, 4);
  });

  test("redactSecrets redacts multiline private key blocks and keeps type", () => {
    const text = redactSecrets("before\n-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----\nafter");
    assert.match(text, /BEGIN RSA PRIVATE KEY/);
    assert.match(text, /\[REDACTED\]/);
    assert.doesNotMatch(text, /abc|def/);
    assert.match(text, /after/);
  });

  test("redactSecrets handles undefined and circular values without throwing", () => {
    assert.equal(redactSecrets(undefined), "undefined");
    const circular = {}; circular.self = circular;
    assert.equal(redactSecrets(circular), "[object Object]");
  });

  test("redactSecrets does not redact ordinary hashes or short source literals", () => {
    const hash = "9f86d081884c7d659a2feaa0c55ad015";
    assert.equal(redactSecrets(`sha256=${hash} const token = \"short\";`), `sha256=${hash} const token = \"short\";`);
  });

  // ── v1.12.0:私网 allowlist(MCP 自建内网 Server 场景) ────────────────────────
  test("allowlist 精确放行列出的私网地址,其余仍 fail-closed", async () => {
    const opts = { allowlist: ["127.0.0.1", "192.168.1.10"] };
    assert.equal((await validateFetchUrl("http://127.0.0.1:8080/mcp", opts)).href, "http://127.0.0.1:8080/mcp");
    assert.equal((await validateFetchUrl("http://192.168.1.10/mcp", opts)).href, "http://192.168.1.10/mcp");
    // 未列出的内网/环回依然被拒 —— allowlist 不是全局开关
    await assert.rejects(() => validateFetchUrl("http://127.0.0.2/mcp", opts), /blocked/i);
    await assert.rejects(() => validateFetchUrl("http://192.168.1.11/mcp", opts), /blocked/i);
    await assert.rejects(() => validateFetchUrl("http://10.0.0.1/mcp", opts), /blocked/i);
  });

  test("allowlist 支持 CIDR 段", async () => {
    const opts = { allowlist: ["127.0.0.0/8", "10.1.0.0/16"] };
    assert.equal((await validateFetchUrl("http://127.0.0.5:9/mcp", opts)).href, "http://127.0.0.5:9/mcp");
    assert.equal((await validateFetchUrl("http://10.1.2.3/mcp", opts)).href, "http://10.1.2.3/mcp");
    await assert.rejects(() => validateFetchUrl("http://10.2.0.1/mcp", opts), /blocked private network/);
  });

  test("allowlist 可放行 hostname,并覆盖其解析结果", async () => {
    const opts = { allowlist: ["mcp.internal"] };
    const resolved = await validateFetchUrl("http://mcp.internal:3000/mcp", {
      lookup: async () => ({ address: "10.0.0.9" }),
      ...opts
    });
    assert.equal(resolved.href, "http://mcp.internal:3000/mcp");
    // 同一 allowlist 不影响别的 hostname
    await assert.rejects(
      () => validateFetchUrl("http://other.internal:3000/mcp", {
        lookup: async () => ({ address: "10.0.0.9" }),
        ...opts
      }),
      /blocked private network/
    );
  });

  test("allowlist 不因命中而放行非 http(s) 协议", async () => {
    await assert.rejects(
      () => validateFetchUrl("file:///etc/passwd", { allowlist: ["127.0.0.1"] }),
      /unsupported protocol/
    );
  });

  test("非法 allowlist CIDR 立即报错(配置错误不静默降级)", async () => {
    await assert.rejects(
      () => validateFetchUrl("http://127.0.0.1/mcp", { allowlist: ["127.0.0.0/33"] }),
      /invalid SSRF allowlist CIDR/
    );
  });

  test("isAllowedByList 精确匹配与 CIDR 边界", () => {
    assert.equal(isAllowedByList("127.0.0.1", ["127.0.0.1"]), true);
    assert.equal(isAllowedByList("127.0.0.1", ["127.0.0.2"]), false);
    assert.equal(isAllowedByList("10.0.0.255", ["10.0.0.0/24"]), true);
    assert.equal(isAllowedByList("10.0.1.0", ["10.0.0.0/24"]), false);
    assert.equal(isAllowedByList("8.8.8.8", ["0.0.0.0/0"]), true);
    assert.equal(isAllowedByList("8.8.8.8", []), false);
    assert.equal(isAllowedByList("8.8.8.8"), false);
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/security/shell-policy.test.js
// ---------------------------------------------------------------------------
describe("unit/security/shell-policy", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { normalizeShellParams, limitOutput, buildChildEnv, runProcess } = await import("../../../src/security/shell-policy.js");

  test("normalizeShellParams rejects raw command strings", () => {
    assert.throws(
      () => normalizeShellParams({ cmd: "npm test" }),
      /structured argv/
    );
  });

  test("normalizeShellParams accepts structured argv and sets shell false", () => {
    const params = normalizeShellParams({ argv: ["node", "--version"], cwd: "src" });
    assert.deepEqual(params.argv, ["node", "--version"]);
    assert.equal(params.cwd, "src");
    assert.equal(params.shell, false);
  });

  test("normalizeShellParams rejects empty or non-string argv", () => {
    assert.throws(() => normalizeShellParams({ argv: [] }), /argv must contain/);
    assert.throws(() => normalizeShellParams({ argv: ["node", 3] }), /argv entries/);
  });

  test("limitOutput truncates long process output", () => {
    const output = limitOutput("x".repeat(20), 8);
    assert.equal(output.truncated, true);
    assert.equal(output.text, "xxxxxxxx");
    assert.equal(output.original_length, 20);
  });

  test("buildChildEnv keeps whitelist keys and drops secrets/proxies/others", () => {
    const baseEnv = {
      PATH: "/usr/bin",
      DEEPSEEK_API_KEY: "sk-secret",
      OPENAI_API_KEY: "sk-other",
      HTTP_PROXY: "http://proxy:8080",
      http_proxy: "http://proxy:8080",
      NODE_OPTIONS: "--max-old-space-size=4096",
      FOO: "bar"
    };
    const env = buildChildEnv(baseEnv);
    assert.equal(env.PATH, "/usr/bin");
    assert.equal("DEEPSEEK_API_KEY" in env, false);
    assert.equal("OPENAI_API_KEY" in env, false);
    assert.equal("HTTP_PROXY" in env, false);
    assert.equal("http_proxy" in env, false);
    assert.equal("NODE_OPTIONS" in env, false);
    assert.equal("FOO" in env, false);
  });

  test("buildChildEnv allowExtra copies exact keys present in baseEnv", () => {
    const env = buildChildEnv({ FOO: "bar", PATH: "/bin" }, { allowExtra: ["FOO"] });
    assert.equal(env.FOO, "bar");
    assert.equal(env.PATH, "/bin");
  });

  test("buildChildEnv preserves actual key casing for whitelist matches", () => {
    const env = buildChildEnv({ Path: "C:\\Windows" });
    assert.equal(env.Path, "C:\\Windows");
    assert.equal("PATH" in env, false);
  });

  test("runProcess refuses forbidden commands before spawning", async () => {
    const result = await runProcess(["format", "/?"], { cwd: process.cwd(), timeoutMs: 10000 });
    assert.equal(result.metadata.exit_code, null);
    assert.match(result.metadata.spawn_error, /command policy: forbidden/);
    assert.match(result.content[0].text, /command policy: forbidden/);
  });

  test("runProcess refuses forbidden commands spelled with the trailing dots Win32 drops", async () => {
    const result = await runProcess(["diskpart.", "/?"], { cwd: process.cwd(), timeoutMs: 10000 });
    assert.equal(result.metadata.exit_code, null);
    assert.match(result.metadata.spawn_error, /command policy: forbidden/);
  });

  test("runProcess does not block the dangerous wrapper shell used by the test tool", async () => {
    const argv = process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", "echo", "nested-ok"]
      : ["sh", "-c", "echo nested-ok"];
    const result = await runProcess(argv, { cwd: process.cwd(), timeoutMs: 10000 });
    assert.equal(result.metadata.exit_code, 0);
    assert.equal(result.stdout.trim(), "nested-ok");
  });

  test("runProcess does not leak secrets to child processes", async () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-should-not-leak";
    try {
      const result = await runProcess(
        [process.execPath, "-e", "process.stdout.write(process.env.DEEPSEEK_API_KEY || '')"],
        { cwd: process.cwd(), timeoutMs: 10000 }
      );
      assert.equal(result.metadata.exit_code, 0);
      assert.equal(result.stdout, "");
    } finally {
      if (previous === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = previous;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/security/command-policy.test.js
// ---------------------------------------------------------------------------
describe("unit/security/command-policy", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { classifyCommand } = await import("../../../src/security/command-policy.js");

  test("classifyCommand normalizes basename, case and executable suffixes", () => {
    assert.equal(classifyCommand(["C:\\Windows\\System32\\cmd.EXE", "/c", "echo", "hi"]), "dangerous");
    assert.equal(classifyCommand(["/usr/bin/bash", "-c", "ls"]), "dangerous");
    assert.equal(classifyCommand(["Git.exe", "push", "--force"]), "dangerous");
    assert.equal(classifyCommand(["rm.exe", "-rf", "x"]), "dangerous");
    assert.equal(classifyCommand(["FORMAT.COM", "c:"]), "forbidden");
  });

  test("classifyCommand strips the trailing dots Win32 drops when resolving a binary", () => {
    assert.equal(classifyCommand(["cmd.", "/c", "whoami"]), "dangerous");
    assert.equal(classifyCommand(["cmd.exe.", "/c", "whoami"]), "dangerous");
    assert.equal(classifyCommand(["powershell...", "-c", "ls"]), "dangerous");
    assert.equal(classifyCommand(["C:\\Windows\\System32\\cmd.EXE.", "/c", "whoami"]), "dangerous");
    assert.equal(classifyCommand(["rm.", "-rf", "x"]), "dangerous");
    assert.equal(classifyCommand(["format.", "c:"]), "forbidden");
    assert.equal(classifyCommand(["diskpart."]), "forbidden");
    assert.equal(classifyCommand(["bcdedit.exe.", "/set"]), "forbidden");
  });

  test("classifyCommand flags forbidden commands", () => {
    assert.equal(classifyCommand(["format", "c:"]), "forbidden");
    assert.equal(classifyCommand(["mkfs.ext4", "/dev/sda1"]), "forbidden");
    assert.equal(classifyCommand(["diskpart"]), "forbidden");
    assert.equal(classifyCommand(["bcdedit", "/set"]), "forbidden");
    assert.equal(classifyCommand(["dd", "if=/dev/zero", "of=/dev/sda"]), "forbidden");
  });

  test("classifyCommand flags deletion and system-level commands as dangerous", () => {
    assert.equal(classifyCommand(["rm", "-rf", "node_modules"]), "dangerous");
    assert.equal(classifyCommand(["rmdir", "/s", "build"]), "dangerous");
    assert.equal(classifyCommand(["rd", "/s", "build"]), "dangerous");
    assert.equal(classifyCommand(["del", "file.txt"]), "dangerous");
    assert.equal(classifyCommand(["shutdown", "/r"]), "dangerous");
    assert.equal(classifyCommand(["reg", "add", "HKCU\\x"]), "dangerous");
    assert.equal(classifyCommand(["sc", "stop", "spooler"]), "dangerous");
    assert.equal(classifyCommand(["schtasks", "/create"]), "dangerous");
    assert.equal(classifyCommand(["taskkill", "/im", "node.exe"]), "dangerous");
    assert.equal(classifyCommand(["curl", "https://example.com"]), "dangerous");
    assert.equal(classifyCommand(["wget", "https://example.com"]), "dangerous");
  });

  test("classifyCommand flags every wrapper shell as dangerous", () => {
    for (const shell of ["bash", "sh", "zsh", "dash", "cmd", "powershell", "pwsh"]) {
      assert.equal(classifyCommand([shell, "--version"]), "dangerous", shell);
    }
  });

  test("classifyCommand flags interpreters only when carrying eval flags", () => {
    assert.equal(classifyCommand(["node", "-e", "process.exit(0)"]), "dangerous");
    assert.equal(classifyCommand(["node", "--eval", "process.exit(0)"]), "dangerous");
    assert.equal(classifyCommand(["node", "--version"]), "safe");
    assert.equal(classifyCommand(["node", "script.js"]), "safe");
    assert.equal(classifyCommand(["python", "-c", "print(1)"]), "dangerous");
    assert.equal(classifyCommand(["python3", "-c", "print(1)"]), "dangerous");
    assert.equal(classifyCommand(["python", "script.py"]), "safe");
    assert.equal(classifyCommand(["ruby", "-e", "puts 1"]), "dangerous");
    assert.equal(classifyCommand(["perl", "-e", "print 1"]), "dangerous");
    assert.equal(classifyCommand(["ruby", "script.rb"]), "safe");
  });

  test("classifyCommand matches eval flags in their equals and print spellings", () => {
    assert.equal(classifyCommand(["node", "--eval=console.log(1)"]), "dangerous");
    assert.equal(classifyCommand(["node", "-e=console.log(1)"]), "dangerous");
    assert.equal(classifyCommand(["node", "-p", "require('os').type()"]), "dangerous");
    assert.equal(classifyCommand(["node", "--print=1"]), "dangerous");
    assert.equal(classifyCommand(["python", "-c=print(1)"]), "dangerous");
    assert.equal(classifyCommand(["node", "--experimental-vm-modules", "script.js"]), "safe");
    assert.equal(classifyCommand(["node", "--enable-source-maps", "script.js"]), "safe");
  });

  test("classifyCommand applies argv rules for npm publish and git push", () => {
    assert.equal(classifyCommand(["npm", "install"]), "safe");
    assert.equal(classifyCommand(["npm", "test"]), "safe");
    assert.equal(classifyCommand(["npm", "publish"]), "dangerous");
    assert.equal(classifyCommand(["git", "status"]), "safe");
    assert.equal(classifyCommand(["git", "push", "origin", "main"]), "safe");
    assert.equal(classifyCommand(["git", "push", "--force", "origin", "main"]), "dangerous");
    assert.equal(classifyCommand(["git", "push", "--force-with-lease"]), "dangerous");
    assert.equal(classifyCommand(["git", "push", "--delete", "origin", "branch"]), "dangerous");
    assert.equal(classifyCommand(["git", "log", "--oneline"]), "safe");
  });

  test("classifyCommand covers the short, bundled and equals spellings of git push force/delete", () => {
    assert.equal(classifyCommand(["git", "push", "-f", "origin", "main"]), "dangerous");
    assert.equal(classifyCommand(["git", "push", "-d", "origin", "topic"]), "dangerous");
    assert.equal(classifyCommand(["git", "push", "-fu", "origin", "main"]), "dangerous");
    assert.equal(classifyCommand(["git", "push", "--force-with-lease=main"]), "dangerous");
    assert.equal(classifyCommand(["git", "push", "-u", "origin", "main"]), "safe");
    assert.equal(classifyCommand(["git", "push", "--dry-run", "origin", "main"]), "safe");
    assert.equal(classifyCommand(["git", "push", "-q", "origin", "main"]), "safe");
  });

  test("classifyCommand treats unknown commands as safe", () => {
    assert.equal(classifyCommand(["cargo", "test"]), "safe");
    assert.equal(classifyCommand(["go", "build", "./..."]), "safe");
    assert.equal(classifyCommand(["definitely-not-a-command-xyz"]), "safe");
  });

  test("classifyCommand never throws and returns dangerous for malformed argv", () => {
    assert.equal(classifyCommand([]), "dangerous");
    assert.equal(classifyCommand(null), "dangerous");
    assert.equal(classifyCommand(undefined), "dangerous");
    assert.equal(classifyCommand("rm -rf"), "dangerous");
    assert.equal(classifyCommand([42, "x"]), "dangerous");
  });
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/security/mcp-content.test.js
// ---------------------------------------------------------------------------
describe("unit/security/mcp-content", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createMcpDisplayRedactor, sanitizeMcpDisplay } = await import("../../../src/security/mcp-content.js");

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
});

// ---------------------------------------------------------------------------
// 来源:tests/unit/workspace/path-safety.test.js
// ---------------------------------------------------------------------------
describe("unit/workspace/path-safety", async () => {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdir, writeFile, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { resolveWorkspacePath, readWorkspaceTextFile, walkWorkspaceFiles, normalizeRelativePath, shouldSkipTraversalSegment } = await import("../../../src/workspace/path-safety.js");
  const { symlinkTraversalSupported, SYMLINK_SKIP_REASON } = await import("../../helpers/symlink-capability.js");
  const { mkdtemp } = await import("../../helpers/tmp.js");

  test("resolveWorkspacePath keeps relative paths inside project root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-"));
    await writeFile(path.join(root, "README.md"), "hello");

    const resolved = await resolveWorkspacePath(root, "README.md", { mustExist: true });

    assert.equal(resolved.relative, "README.md");
    assert.equal(resolved.absolute, path.join(root, "README.md"));
  });

  test("resolveWorkspacePath rejects lexical path traversal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-"));

    await assert.rejects(
      () => resolveWorkspacePath(root, "../outside.txt"),
      /escapes project root/
    );
  });

  test("resolveWorkspacePath rejects symlink escape", async (t) => {
    if (!(await symlinkTraversalSupported())) { t.skip(SYMLINK_SKIP_REASON); return; }
    const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-"));
    const outside = await mkdtemp(path.join(tmpdir(), "dsc-out-"));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "link"), "junction");

    await assert.rejects(
      () => resolveWorkspacePath(root, "link/secret.txt", { mustExist: true }),
      /escapes project root/
    );
  });

  test("resolveWorkspacePath allows new files under existing safe ancestor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-"));
    await mkdir(path.join(root, "src"));

    const resolved = await resolveWorkspacePath(root, "src/new-file.js");

    assert.equal(resolved.relative, "src/new-file.js");
  });

  test("readWorkspaceTextFile rejects binary and large files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-"));
    await writeFile(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(root, "large.txt"), "x".repeat(20));

    await assert.rejects(
      () => readWorkspaceTextFile(root, "bin.dat"),
      /binary/
    );
    await assert.rejects(
      () => readWorkspaceTextFile(root, "large.txt", { maxBytes: 10 }),
      /too large/
    );
  });

  test("walkWorkspaceFiles returns normalized relative file paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "app.js"), "console.log(1)");
    await writeFile(path.join(root, "README.md"), "readme");

    const files = await walkWorkspaceFiles(root, ".", { maxFiles: 10 });

    assert.deepEqual(files.sort(), ["README.md", "src/app.js"].sort());
  });

  test("walkWorkspaceFiles skips build output and other agents' state dirs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-skip-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "app.js"), "console.log(1)");
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "dist", "bundle.js"), "built");
    await mkdir(path.join(root, ".claude"));
    await writeFile(path.join(root, ".claude", "settings.local.json"), "{}");
    await mkdir(path.join(root, ".vscode"));
    await writeFile(path.join(root, ".vscode", "settings.json"), "{}");

    const files = await walkWorkspaceFiles(root, ".", { maxFiles: 50 });

    assert.deepEqual(files, ["src/app.js"]);
  });

  test("walkWorkspaceFiles honours an explicitly requested skipped directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsc-ws-explicit-"));
    await mkdir(path.join(root, ".claude"));
    await writeFile(path.join(root, ".claude", "settings.local.json"), "{}");

    // 显式指定起点时不受目录级忽略影响：调用方明确要看这里。
    const files = await walkWorkspaceFiles(root, ".claude", { maxFiles: 50 });

    assert.deepEqual(files, [".claude/settings.local.json"]);
  });

  test("shouldSkipTraversalSegment covers build output and hidden tool dirs", () => {
    for (const name of ["node_modules", ".git", "dist", "build", "coverage", "__pycache__", ".claude", ".vscode", ".cursor"]) {
      assert.equal(shouldSkipTraversalSegment(name), true, name);
    }
    for (const name of ["src", "docs", ".github", "app.js"]) {
      assert.equal(shouldSkipTraversalSegment(name), false, name);
    }
  });

  test("normalizeRelativePath uses forward slashes and rejects empty paths", () => {
    assert.equal(normalizeRelativePath("src\\app.js"), "src/app.js");
    assert.throws(() => normalizeRelativePath(""), /path is required/);
  });
});
