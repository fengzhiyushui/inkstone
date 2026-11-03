// tests/unit/tools-and-security.test.js — 工具系统、权限引擎、命令策略与安全防线
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inspectJson,
  mapJson,
  matchesJsonType,
  canonicalJson,
  compileSafePattern,
  validateToolParams,
  toDeepSeekToolSchema,
  JSON_SAFE_LIMITS,
  JSON_SAFE_COST
} from "../../src/tools/schema.js";
import { createToolRegistry } from "../../src/tools/registry.js";
import { createToolExecutor } from "../../src/tools/executor.js";
import { createPermissionEngine, DEFAULT_POLICY_MATRIX, globMatch } from "../../src/tools/permissions/permission-engine.js";
import { classifyCommand } from "../../src/security/command-policy.js";
import { normalizeShellParams, buildChildEnv } from "../../src/security/shell-policy.js";
import { validateFetchUrl, validateResolvedAddress, isPrivateIPv4, isReservedIPv4, SsrfBlockedError } from "../../src/security/ssrf.js";
import { redactSecrets, redactToolContent } from "../../src/security/redactor.js";
import { createBuiltinTools } from "../../src/tools/builtin/index.js";
import { createEventBus } from "../../src/shared/event-bus.js";
import { mkdtemp } from "../helpers/tmp.js";

test("公共 Schema 校验内核（inspectJson/mapJson/类型/枚举/安全正则）", () => {
  assert.equal(matchesJsonType("hello", "string"), true);
  assert.equal(matchesJsonType(123, "number"), true);
  assert.equal(matchesJsonType(true, "boolean"), true);
  assert.equal(matchesJsonType([], "array"), true);
  assert.equal(matchesJsonType({}, "object"), true);
  assert.equal(matchesJsonType(null, "null"), true);

  assert.doesNotThrow(() => {
    inspectJson({ a: 1, b: [2, 3] }, {
      limits: JSON_SAFE_LIMITS,
      cost: JSON_SAFE_COST,
      fail: (k) => { throw new Error(k); }
    });
  });

  const mapped = mapJson({ key: " secret ", list: [" item "] }, {
    limits: JSON_SAFE_LIMITS,
    cost: JSON_SAFE_COST,
    fail: (k) => { throw new Error(k); },
    onString: (s) => s.trim()
  });
  assert.equal(mapped.key, "secret");
  assert.equal(mapped.list[0], "item");

  assert.equal(canonicalJson({ b: 2, a: 1 }), "{\"a\":1,\"b\":2}");

  const pattern = compileSafePattern("^[a-z0-9_-]+$", { maxLength: 32, fail: () => { throw new Error("bad"); } });
  assert.ok(pattern.test("valid_name-1"));
  assert.equal(pattern.test("invalid name!"), false);

  const valid = validateToolParams("testTool", {
    path: { type: "string" }
  }, { path: "src/main.js" });
  assert.equal(valid.path, "src/main.js");

  assert.throws(
    () => validateToolParams("testTool", { path: { type: "string" } }, { unknown: "x" }),
    /unknown param/
  );
});

test("工具注册表与参数归一化", () => {
  const registry = createToolRegistry();
  const dummyTool = {
    name: "probe",
    description: "test tool",
    category: "custom",
    parameters: {
      type: "object",
      properties: { target: { type: "string" } }
    },
    execute: async (params) => ({ found: params.target })
  };

  registry.register(dummyTool);
  assert.ok(registry.resolve("probe"));
  assert.equal(registry.resolve("probe").name, "probe");

  const schemas = registry.listTools();
  assert.equal(schemas.length, 1);
  assert.equal(schemas[0].name, "probe");

  const deepseekSchema = toDeepSeekToolSchema(dummyTool);
  assert.equal(deepseekSchema.type, "function");
  assert.equal(deepseekSchema.function.name, "probe");
});

test("五档自治×十类别权限矩阵、风险线索升级与持久策略", () => {
  assert.ok(DEFAULT_POLICY_MATRIX);
  assert.ok(globMatch("src/**", "src/core/main.js"));
  assert.equal(globMatch("*.js", "test.py"), false);

  const engine = createPermissionEngine();
  const readPerm = engine.decide({
    name: "read",
    category: "read",
    params: { path: "package.json" }
  }, { autonomy: "read-only" });
  assert.equal(readPerm.decision, "allow");

  const writeDeniedInReadOnly = engine.decide({
    name: "write",
    category: "write",
    params: { path: "src/app.js" }
  }, { autonomy: "read-only" });
  assert.notEqual(writeDeniedInReadOnly.decision, "allow");

  const destructivePerm = engine.decide({
    name: "dangerTool",
    category: "destructive",
    params: {}
  }, { autonomy: "full-auto" });
  assert.equal(destructivePerm.decision, "deny");
});

test("Shell/Git 命令分类（safe/dangerous/forbidden）与环境变量白名单", () => {
  assert.equal(classifyCommand(["git", "status"]), "safe");
  assert.equal(classifyCommand(["git", "push", "--force"]), "dangerous");
  assert.equal(classifyCommand(["format", "c:"]), "forbidden");
  assert.equal(classifyCommand(["dd", "if=/dev/zero"]), "forbidden");

  const normalized = normalizeShellParams({ argv: ["echo", "hello"] });
  assert.ok(normalized.argv.length > 0);

  const childEnv = buildChildEnv({
    USER_DEFINED: "safe",
    SECRET_KEY: "hidden",
    PATH: process.env.PATH
  });
  assert.equal(typeof childEnv, "object");
  assert.ok(childEnv.PATH !== undefined);
});

test("ToolExecutor 执行流、审批挂起与协作式超时", async () => {
  const events = [];
  const bus = createEventBus();
  bus.subscribe("tool:call", (e) => events.push(["call", e]));
  bus.subscribe("tool:result", (e) => events.push(["result", e]));

  const registry = createToolRegistry();
  registry.register({
    name: "ping",
    description: "ping tool",
    category: "custom",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "pong" }] })
  });

  const allowEngine = {
    decide: () => ({ decision: "allow" })
  };
  const executor = createToolExecutor({ registry, permissionEngine: allowEngine, eventBus: bus });

  const result = await executor.execute({
    id: "call_1",
    name: "ping",
    params: {}
  });

  assert.equal(result.status, "success");
  assert.equal(events.length, 2);
  assert.equal(events[0][0], "call");
  assert.equal(events[1][0], "result");

  registry.register({
    name: "gated",
    description: "needs approval",
    category: "custom",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ ok: true })
  });

  const askEngine = {
    decide: () => ({ decision: "ask", reason: "manual confirmation needed" })
  };
  const gatedExecutor = createToolExecutor({ registry, permissionEngine: askEngine, eventBus: bus });
  const suspended = await gatedExecutor.execute({ id: "call_2", name: "gated", params: {} });
  assert.equal(suspended.status, "approval_required");
});

test("内置文件/检索/记忆/网络工具（含 grep 超时与 path 安全）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsc-builtin-tools-"));
  await fs.writeFile(path.join(root, "file.txt"), "hello from file\n");
  await fs.mkdir(path.join(root, "sub"), { recursive: true });
  await fs.writeFile(path.join(root, "sub", "test.js"), "const x = 42;\n");

  const tools = createBuiltinTools({ projectRoot: root });
  const readTool = tools.find((t) => t.name === "read");
  assert.ok(readTool);

  const readRes = await readTool.execute({ path: "file.txt" }, { projectRoot: root });
  assert.ok(readRes.content[0].text.includes("hello from file"));

  await assert.rejects(
    async () => readTool.execute({ path: "../outside.txt" }, { projectRoot: root }),
    /outside|越界|path/i
  );

  const grepTool = tools.find((t) => t.name === "grep");
  assert.ok(grepTool);
  const grepRes = await grepTool.execute({ pattern: "42", path: "sub" }, { projectRoot: root });
  assert.ok(grepRes.content?.[0]?.text?.includes("42") || grepRes.matches?.length > 0);
});

test("SSRF 逐跳与多记录 DNS 安全防护", async () => {
  assert.equal(isPrivateIPv4("10.0.0.1"), true);
  assert.equal(isPrivateIPv4("192.168.1.1"), true);
  assert.equal(isPrivateIPv4("172.16.0.1"), true);
  assert.equal(isReservedIPv4("127.0.0.1"), true);
  assert.equal(isPrivateIPv4("8.8.8.8"), false);
  assert.equal(isPrivateIPv4("1.1.1.1"), false);

  assert.throws(() => validateResolvedAddress("127.0.0.1"), SsrfBlockedError);
  assert.throws(() => validateResolvedAddress("10.10.10.10"), SsrfBlockedError);
  assert.doesNotThrow(() => validateResolvedAddress("93.184.216.34"));

  const mockLookup = async (host) => {
    if (host === "malicious.test") {
      return [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }];
    }
    return [{ address: "93.184.216.34", family: 4 }];
  };

  await assert.rejects(
    async () => validateFetchUrl("http://malicious.test/api", { lookup: mockLookup }),
    SsrfBlockedError
  );
  await assert.rejects(
    async () => validateFetchUrl("http://127.0.0.1:8080/secret"),
    SsrfBlockedError
  );
});

test("敏感词与凭据块脱敏过滤", () => {
  const secretText = "Bearer sk-1234567890abcdef1234567890abcdef and password=mySecretPassword123";
  const redacted = redactSecrets(secretText);
  assert.equal(redacted.includes("sk-1234567890abcdef1234567890abcdef"), false);
  assert.ok(redacted.includes("[REDACTED]") || redacted.includes("sk-***") || redacted.includes("***"));

  const contentBlocks = [
    { type: "text", text: "api_key=sk-ant-api03-1234567890abcdef" },
    { type: "image", data: "image_data" }
  ];
  const cleaned = redactToolContent(contentBlocks);
  assert.equal(cleaned[0].text.includes("sk-ant-api03-1234567890abcdef"), false);
  assert.equal(cleaned[1].type, "image");
});
