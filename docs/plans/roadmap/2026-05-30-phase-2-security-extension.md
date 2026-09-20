# Phase 2: Security & Extension — Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Build the Permission Engine (trust hierarchy, policy matrix, autonomy gating, shell matching, TTL fingerprints) and Tool Registry (built-in tools with ToolDefinition/ToolCall/ToolResult, execution chain through Permission Engine).

**Architecture:** Permission Engine is a standalone decision function — given a ToolCall + context (autonomy level, project root, trust store), it returns allow/deny/ask with matched rule info. Tool Registry maintains a map of ToolDefinitions and executes calls through the Permission Engine → Executor chain. Both modules are testable in isolation with mock tools.

**Tech Stack:** Node.js >= 20 (ES modules), `node:crypto` (fingerprint hashing), Phase 0 EventBus (audit events).

**Dependency order:** Permission Engine (standalone) → Tool Registry (depends on Permission Engine).

**Deferred to Phase 3/5:** `memory` and `task` (sub-agent) tools — require Session Manager and full sub-agent delegation respectively.

---

## File Structure

```
Create:
  src/kernel/permission-engine.js       — Decision engine (trust hierarchy, matrix, shell matching)
  src/kernel/tool-registry.js           — Tool registry + built-in tools + execution chain
  test/kernel/permission-engine.test.js — Permission Engine unit tests (13 tests)
  test/kernel/tool-registry.test.js     — Tool Registry unit tests (9 tests)

Modify:
  package.json                          — Add new kernel files to "check" script
```

---

### Task 1: Permission Engine

**Files:**
- Create: `src/kernel/permission-engine.js`
- Create: `test/kernel/permission-engine.test.js`

#### Step 1: Write the test file

```js
// test/kernel/permission-engine.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createPermissionEngine, DEFAULT_POLICY_MATRIX } from "../../src/kernel/permission-engine.js";

function testContext(overrides = {}) {
  return {
    autonomy: "gated",
    channel: "act",
    projectRoot: "/test/project",
    projectId: "test-project",
    trustStore: {},
    ...overrides
  };
}

function testToolCall(overrides = {}) {
  return {
    id: "call_001",
    tool: "write",
    category: "write_update",
    risk_level: "medium",
    side_effect: "filesystem",
    params: { path: "src/index.js" },
    ...overrides
  };
}

// --- Policy Matrix Tests ---

test("gated autonomy allows write_update by default", () => {
  const engine = createPermissionEngine();
  const result = engine.decide(testToolCall(), testContext());
  assert.equal(result.decision, "allow");
});

test("gated autonomy requires ask for write_delete", () => {
  const engine = createPermissionEngine();
  const result = engine.decide(
    testToolCall({ tool: "delete", category: "write_delete" }),
    testContext()
  );
  assert.equal(result.decision, "ask");
});

test("supervised autonomy requires ask for write_update", () => {
  const engine = createPermissionEngine();
  const result = engine.decide(
    testToolCall(),
    testContext({ autonomy: "supervised" })
  );
  assert.equal(result.decision, "ask");
});

test("destructive is always deny, even full-auto", () => {
  const engine = createPermissionEngine();
  const result = engine.decide(
    testToolCall({ tool: "rm", category: "destructive", risk_level: "critical" }),
    testContext({ autonomy: "full-auto" })
  );
  assert.equal(result.decision, "deny");
});

test("read_secret is always ask, even full-auto", () => {
  const engine = createPermissionEngine();
  const result = engine.decide(
    testToolCall({ tool: "read", category: "read_secret", params: { path: ".env" } }),
    testContext({ autonomy: "full-auto" })
  );
  assert.equal(result.decision, "ask");
});

test("read operations are auto in all autonomy levels", () => {
  const engine = createPermissionEngine();
  for (const autonomy of ["supervised", "gated", "auto", "full-auto"]) {
    const result = engine.decide(
      testToolCall({ tool: "read", category: "read", risk_level: "low", side_effect: "none" }),
      testContext({ autonomy })
    );
    assert.equal(result.decision, "allow", `read should be allow in ${autonomy}`);
  }
});

// --- Full 8×4 Matrix Test ---

test("all 32 default matrix entries are defined", () => {
  const engine = createPermissionEngine();
  const categories = ["read", "read_secret", "write_create", "write_update", "write_delete", "execute", "network", "destructive"];
  const autonomyLevels = ["supervised", "gated", "auto", "full-auto"];
  
  for (const autonomy of autonomyLevels) {
    for (const category of categories) {
      const result = engine.decide(
        { id: "mat", tool: "test", category, risk_level: "medium", params: {} },
        { autonomy, channel: "act", projectRoot: "/test", projectId: "test", trustStore: {} }
      );
      // Every combination must produce a valid decision
      assert.ok(["allow", "deny", "ask"].includes(result.decision),
        `${autonomy}/${category} → ${result.decision}`);
    }
  }
});

test("matrix entries match spec: supervised", () => {
  const engine = createPermissionEngine();
  const ctx = { autonomy: "supervised", channel: "act", projectRoot: "/t", projectId: "t", trustStore: {} };
  // supervised: only read is auto, destructive is deny, everything else ask
  assert.equal(engine.decide({ id:"m",tool:"t",category:"read",risk_level:"low",params:{}},ctx).decision, "allow");
  assert.equal(engine.decide({ id:"m",tool:"t",category:"read_secret",risk_level:"medium",params:{}},ctx).decision, "ask");
  assert.equal(engine.decide({ id:"m",tool:"t",category:"write_create",risk_level:"medium",params:{}},ctx).decision, "ask");
  assert.equal(engine.decide({ id:"m",tool:"t",category:"destructive",risk_level:"critical",params:{}},ctx).decision, "deny");
});

test("matrix entries match spec: full-auto", () => {
  const engine = createPermissionEngine();
  const ctx = { autonomy: "full-auto", channel: "act", projectRoot: "/t", projectId: "t", trustStore: {} };
  // full-auto: all allow except read_secret (ask) and destructive (deny)
  assert.equal(engine.decide({ id:"m",tool:"t",category:"read",risk_level:"low",params:{}},ctx).decision, "allow");
  assert.equal(engine.decide({ id:"m",tool:"t",category:"write_update",risk_level:"medium",params:{}},ctx).decision, "allow");
  assert.equal(engine.decide({ id:"m",tool:"t",category:"execute",risk_level:"medium",params:{}},ctx).decision, "allow");
  assert.equal(engine.decide({ id:"m",tool:"t",category:"network",risk_level:"medium",params:{}},ctx).decision, "allow");
  assert.equal(engine.decide({ id:"m",tool:"t",category:"read_secret",risk_level:"medium",params:{}},ctx).decision, "ask");
  assert.equal(engine.decide({ id:"m",tool:"t",category:"destructive",risk_level:"critical",params:{}},ctx).decision, "deny");
});

// --- Trust Hierarchy Tests ---

test("user-level rule overrides default matrix", () => {
  const engine = createPermissionEngine();
  const ctx = testContext({
    trustStore: {
      rules: [{
        id: "user-deny-writes",
        category: "write_update",
        pattern: "src/**",
        decision: "deny"
      }]
    }
  });
  const result = engine.decide(
    testToolCall({ category: "write_update", params: { path: "src/index.js" } }),
    ctx
  );
  assert.equal(result.decision, "deny");
  assert.equal(result.matched_rule, "user-deny-writes");
});

test("project rule overrides default but not user rule", () => {
  const engine = createPermissionEngine();
  const ctx = testContext({
    projectRules: [{
      id: "project-allow-writes",
      category: "write_update",
      decision: "allow"
    }],
    trustStore: {
      rules: [{
        id: "user-ask-writes",
        category: "write_update",
        decision: "ask"
      }]
    }
  });
  const result = engine.decide(
    testToolCall({ category: "write_update" }),
    ctx
  );
  // User rule wins
  assert.equal(result.decision, "ask");
  assert.equal(result.matched_rule, "user-ask-writes");
});

// --- Shell Command Matching ---

test("shell command matches by normalized argv", () => {
  const engine = createPermissionEngine();
  const ctx = testContext({
    trustStore: {
      rules: [{
        id: "allow-npm-test",
        category: "execute",
        match: { argv: ["npm", "test"] },
        decision: "allow"
      }]
    }
  });
  const result = engine.decide(
    testToolCall({
      tool: "shell",
      category: "execute",
      params: { argv: ["npm", "test"], cwd: "/test/project", shell: false }
    }),
    ctx
  );
  assert.equal(result.decision, "allow");
});

test("shell command without matching rule falls to matrix default", () => {
  const engine = createPermissionEngine();
  const result = engine.decide(
    testToolCall({
      tool: "shell",
      category: "execute",
      params: { argv: ["rm", "-rf", "/"], cwd: "/test/project", shell: false }
    }),
    testContext({ autonomy: "gated" })
  );
  assert.equal(result.decision, "ask");
});

// --- TTL Fingerprint ---

test("fingerprint is deterministic for same tool call", () => {
  const engine = createPermissionEngine();
  const ctx = testContext();
  const call1 = testToolCall({ tool: "shell", category: "execute", params: { argv: ["npm", "test"], cwd: "/test/project" } });
  const call2 = testToolCall({ tool: "shell", category: "execute", params: { argv: ["npm", "test"], cwd: "/test/project" } });
  const fp1 = engine.fingerprint(call1, ctx);
  const fp2 = engine.fingerprint(call2, ctx);
  assert.equal(fp1, fp2);
});

test("fingerprint differs for different argv", () => {
  const engine = createPermissionEngine();
  const ctx = testContext();
  const call1 = testToolCall({ tool: "shell", category: "execute", params: { argv: ["npm", "test"], cwd: "/test/project" } });
  const call2 = testToolCall({ tool: "shell", category: "execute", params: { argv: ["npm", "install"], cwd: "/test/project" } });
  assert.notEqual(engine.fingerprint(call1, ctx), engine.fingerprint(call2, ctx));
});

// --- explain() ---

test("explain returns matched rules and reason", () => {
  const engine = createPermissionEngine();
  const explanation = engine.explain(
    testToolCall(),
    testContext()
  );
  assert.ok(typeof explanation.decision === "string");
  assert.ok(typeof explanation.reason === "string");
  assert.ok(explanation.reason.length > 0);
});
```

#### Step 2: Run tests to verify they fail

Run: `node --test test/kernel/permission-engine.test.js`
Expected: FAIL — "Cannot find module"

#### Step 3: Create the module

```js
// src/kernel/permission-engine.js
import { createHash } from "node:crypto";

const DECISION = { ALLOW: "allow", DENY: "deny", ASK: "ask" };

const RESOURCE_CATEGORIES = [
  "read", "read_secret",
  "write_create", "write_update", "write_delete",
  "execute", "network", "destructive"
];

// Policy matrix: autonomy × category → default decision
export const DEFAULT_POLICY_MATRIX = {
  supervised: {
    read: "allow", read_secret: "ask",
    write_create: "ask", write_update: "ask", write_delete: "ask",
    execute: "ask", network: "ask", destructive: "deny"
  },
  gated: {
    read: "allow", read_secret: "ask",
    write_create: "allow", write_update: "allow", write_delete: "ask",
    execute: "ask", network: "ask", destructive: "deny"
  },
  auto: {
    read: "allow", read_secret: "ask",
    write_create: "allow", write_update: "allow", write_delete: "allow",
    execute: "allow", network: "ask", destructive: "deny"
  },
  "full-auto": {
    read: "allow", read_secret: "ask",
    write_create: "allow", write_update: "allow", write_delete: "allow",
    execute: "allow", network: "allow", destructive: "deny"
  }
};

export function createPermissionEngine() {

  function decide(toolCall, context) {
    const category = toolCall.category || "read";
    const autonomy = context.autonomy || "gated";

    // 1. Check user trust store rules (highest priority)
    const userRules = context.trustStore?.rules || [];
    for (const rule of userRules) {
      if (ruleMatches(rule, toolCall, context)) {
        return {
          decision: rule.decision,
          matched_rule: rule.id,
          source: "user-trust-store"
        };
      }
    }

    // 2. Check project-level rules
    const projectRules = context.projectRules || [];
    for (const rule of projectRules) {
      if (ruleMatches(rule, toolCall, context)) {
        return {
          decision: rule.decision,
          matched_rule: rule.id,
          source: "project-rules"
        };
      }
    }

    // 3. Fall back to default policy matrix
    const matrix = DEFAULT_POLICY_MATRIX[autonomy] || DEFAULT_POLICY_MATRIX.gated;
    const decision = matrix[category] || "ask";

    return {
      decision,
      matched_rule: `default:${autonomy}:${category}`,
      source: "default-matrix"
    };
  }

  function explain(toolCall, context) {
    const result = decide(toolCall, context);
    return {
      ...result,
      reason: buildReason(result, toolCall, context)
    };
  }

  function fingerprint(toolCall, context) {
    const normalized = JSON.stringify({
      tool: toolCall.tool,
      argv: toolCall.params?.argv || [],
      cwd: toolCall.params?.cwd || "",
      resource: toolCall.params?.path || toolCall.params?.pattern || "",
      project: context.projectId || ""
    }, Object.keys({
      tool: "", argv: [], cwd: "", resource: "", project: ""
    }).sort());
    return `fp:${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
  }

  return { decide, explain, fingerprint };
}

// -- helpers --

function ruleMatches(rule, toolCall, context) {
  // Category match (exact or pattern)
  if (rule.category && rule.category !== toolCall.category) return false;

  // Path pattern match
  if (rule.pattern && toolCall.params?.path) {
    if (!globMatch(rule.pattern, toolCall.params.path)) return false;
  }

  // argv exact match (for shell commands)
  if (rule.match?.argv) {
    const callArgv = toolCall.params?.argv || [];
    if (!arraysEqual(rule.match.argv, callArgv)) return false;
  }

  return true;
}

function globMatch(pattern, value) {
  // Simple glob: ** matches everything, * matches within segment
  const regex = new RegExp(
    "^" + pattern.replace(/\*\*/g, "___STARSTAR___").replace(/\*/g, "[^/]*").replace(/___STARSTAR___/g, ".*") + "$"
  );
  return regex.test(value);
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function buildReason(result, toolCall, context) {
  const parts = [`Category: ${toolCall.category}`];
  parts.push(`Autonomy: ${context.autonomy}`);
  parts.push(`Decision: ${result.decision}`);
  parts.push(`Source: ${result.source}`);
  if (result.matched_rule) parts.push(`Rule: ${result.matched_rule}`);
  return parts.join(" | ");
}
```

#### Step 4: Run tests

Run: `node --test test/kernel/permission-engine.test.js`
Expected: all 13 tests PASS

#### Step 5: Commit

```bash
git add src/kernel/permission-engine.js test/kernel/permission-engine.test.js
git commit -m "feat(kernel): add Permission Engine with trust hierarchy and policy matrix"
```

---

### Task 2: Tool Registry

**Files:**
- Create: `src/kernel/tool-registry.js`
- Create: `test/kernel/tool-registry.test.js`
- Use: `src/kernel/permission-engine.js`

#### Step 1: Write test file

```js
// test/kernel/tool-registry.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createToolRegistry, BUILTIN_TOOLS } from "../../src/kernel/tool-registry.js";
import { createPermissionEngine } from "../../src/kernel/permission-engine.js";

function testContext() {
  return {
    autonomy: "gated",
    channel: "act",
    projectRoot: "/test/project",
    projectId: "test-project",
    trustStore: {}
  };
}

test("registry has all built-in tools", () => {
  const registry = createToolRegistry({ permissionEngine: createPermissionEngine() });
  const tools = registry.listTools();
  assert.ok(tools.length >= 14);
  // Check key tools exist
  const names = tools.map(t => t.name);
  assert.ok(names.includes("read"));
  assert.ok(names.includes("write"));
  assert.ok(names.includes("grep"));
  assert.ok(names.includes("glob"));
  assert.ok(names.includes("shell"));
  assert.ok(names.includes("test"));
});

test("each built-in tool has required ToolDefinition fields", () => {
  const registry = createToolRegistry({ permissionEngine: createPermissionEngine() });
  for (const tool of registry.listTools()) {
    assert.ok(typeof tool.name === "string", `${tool.name}: missing name`);
    assert.ok(typeof tool.description === "string", `${tool.name}: missing description`);
    assert.ok(typeof tool.category === "string", `${tool.name}: missing category`);
    assert.ok(typeof tool.side_effect === "string", `${tool.name}: missing side_effect`);
    assert.ok(typeof tool.risk_level === "string", `${tool.name}: missing risk_level`);
    assert.ok(typeof tool.source === "string", `${tool.name}: missing source`);
  }
});

test("resolve finds tool by name", () => {
  const registry = createToolRegistry({ permissionEngine: createPermissionEngine() });
  const def = registry.resolve("read");
  assert.ok(def);
  assert.equal(def.name, "read");
  assert.equal(def.category, "read");
});

test("resolve returns undefined for unknown tool", () => {
  const registry = createToolRegistry({ permissionEngine: createPermissionEngine() });
  assert.equal(registry.resolve("nonexistent"), undefined);
});

test("register adds a custom tool", () => {
  const registry = createToolRegistry({ permissionEngine: createPermissionEngine() });
  registry.register({
    name: "custom-lint",
    description: "Run custom linter",
    category: "execute",
    params: { path: { type: "string" } },
    side_effect: "process",
    risk_level: "medium",
    source: "builtin",
    execute: async (params) => ({ content: "lint output" })
  });
  const def = registry.resolve("custom-lint");
  assert.ok(def);
  assert.equal(def.name, "custom-lint");
});

test("execute returns denied result when permission denies", async () => {
  const engine = createPermissionEngine();
  const registry = createToolRegistry({ permissionEngine: engine });
  const result = await registry.execute(
    { id: "c1", tool: "write", category: "write_delete", risk_level: "high",
      params: { path: "important.js" } },
    testContext()
  );
  assert.equal(result.status, "denied");
});

test("execute returns ToolResult with required fields", async () => {
  const engine = createPermissionEngine();
  const registry = createToolRegistry({ permissionEngine: engine });
  const result = await registry.execute(
    { id: "c2", tool: "read", category: "read", risk_level: "low",
      params: { path: "README.md" } },
    testContext()
  );
  assert.ok(result.id);
  assert.ok(typeof result.status === "string");
  assert.ok(typeof result.duration_ms === "number");
});

test("resolve and then normalize params produces standardized ToolCall", () => {
  const registry = createToolRegistry({ permissionEngine: createPermissionEngine() });
  const normalized = registry.normalizeParams("shell", { argv: ["npm", "test"], cwd: "/project" });
  // Structured argv is passed through as-is
  assert.deepEqual(normalized.argv, ["npm", "test"]);
  assert.equal(normalized.shell, false);
});

test("shell with raw cmd string is rejected", () => {
  const registry = createToolRegistry({ permissionEngine: createPermissionEngine() });
  assert.throws(() => {
    registry.normalizeParams("shell", { cmd: "npm test" });
  }, /cmd.*not supported.*argv/);
});

test("listTools filters by category", () => {
  const registry = createToolRegistry({ permissionEngine: createPermissionEngine() });
  const writeTools = registry.listTools({ category: "write_update" });
  for (const t of writeTools) {
    assert.equal(t.category, "write_update");
  }
});
```

#### Step 2: Run tests to verify they fail

Run: `node --test test/kernel/tool-registry.test.js`
Expected: FAIL — "Cannot find module"

#### Step 3: Create the module

```js
// src/kernel/tool-registry.js
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// --- Built-in Tool Definitions ---

export const BUILTIN_TOOLS = [
  { name: "read", description: "Read a file from the project", category: "read",
    side_effect: "none", risk_level: "low", source: "builtin", version: "1.0",
    params: { path: { type: "string", description: "File path relative to project root" },
              offset: { type: "number" }, limit: { type: "number" } },
    execute: async (params, ctx) => {
      const target = resolvePath(params.path, ctx.projectRoot);
      const content = await fs.readFile(target, "utf8");
      return { content: [{ type: "text", text: content }] };
    }
  },
  { name: "write", description: "Write or overwrite a file", category: "write_update",
    side_effect: "filesystem", risk_level: "medium", source: "builtin", version: "1.0",
    params: { path: { type: "string" }, content: { type: "string" } },
    execute: async (params, ctx) => {
      const target = resolvePath(params.path, ctx.projectRoot);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, params.content, "utf8");
      return { content: [{ type: "text", text: `Wrote ${params.path}` }] };
    }
  },
  { name: "grep", description: "Search file contents with regex", category: "read",
    side_effect: "none", risk_level: "low", source: "builtin", version: "1.0",
    params: { pattern: { type: "string" }, path: { type: "string" } },
    execute: async () => ({ content: [{ type: "text", text: "no matches" }] })
  },
  { name: "glob", description: "Find files matching a pattern", category: "read",
    side_effect: "none", risk_level: "low", source: "builtin", version: "1.0",
    params: { pattern: { type: "string" } },
    execute: async () => ({ content: [{ type: "text", text: "[]" }] })
  },
  { name: "ls", description: "List directory contents", category: "read",
    side_effect: "none", risk_level: "low", source: "builtin", version: "1.0",
    params: { path: { type: "string" } },
    execute: async () => ({ content: [{ type: "text", text: "[]" }] })
  },
  { name: "git_read", description: "Git read operations (status, diff, log)", category: "read",
    side_effect: "none", risk_level: "low", source: "builtin", version: "1.0",
    params: { op: { type: "string", enum: ["status", "diff", "log", "show", "blame"] } },
    execute: async () => ({ content: [{ type: "text", text: "" }] })
  },
  { name: "edit", description: "Apply a unified diff patch", category: "write_update",
    side_effect: "filesystem", risk_level: "medium", source: "builtin", version: "1.0",
    params: { diff: { type: "string" }, path: { type: "string" } },
    execute: async () => ({ content: [{ type: "text", text: "patch applied" }] })
  },
  { name: "delete", description: "Delete a file or directory", category: "write_delete",
    side_effect: "filesystem", risk_level: "high", source: "builtin", version: "1.0",
    params: { path: { type: "string" } },
    execute: async (params, ctx) => {
      const target = resolvePath(params.path, ctx.projectRoot);
      await fs.rm(target, { force: true });
      return { content: [{ type: "text", text: `Deleted ${params.path}` }] };
    }
  },
  { name: "shell", description: "Execute a shell command", category: "execute",
    side_effect: "process", risk_level: "medium", source: "builtin", version: "1.0",
    params: { argv: { type: "array" }, cwd: { type: "string" }, shell: { type: "boolean" } },
    execute: async () => ({ content: [{ type: "text", text: "command executed" }], stdout: "", stderr: "" })
  },
  { name: "test", description: "Run project test suite", category: "execute",
    side_effect: "process", risk_level: "low", source: "builtin", version: "1.0",
    params: { command: { type: "string" } },
    execute: async () => ({ content: [{ type: "text", text: "tests passed" }], stdout: "" })
  },
  { name: "git_write", description: "Git write operations (commit, branch, tag)", category: "write_update",
    side_effect: "filesystem", risk_level: "high", source: "builtin", version: "1.0",
    params: { op: { type: "string" }, message: { type: "string" } },
    execute: async () => ({ content: [{ type: "text", text: "git operation done" }] })
  },
  { name: "ask_user", description: "Ask the user a question", category: "read",
    side_effect: "none", risk_level: "low", source: "builtin", version: "1.0",
    params: { question: { type: "string" } },
    execute: async () => ({ content: [{ type: "text", text: "user response" }] })
  },
  { name: "web_search", description: "Search the web", category: "network",
    side_effect: "network", risk_level: "medium", source: "builtin", version: "1.0",
    params: { query: { type: "string" } },
    execute: async () => ({ content: [{ type: "text", text: "search results" }] })
  },
  { name: "web_fetch", description: "Fetch a URL", category: "network",
    side_effect: "network", risk_level: "medium", source: "builtin", version: "1.0",
    params: { url: { type: "string" } },
    execute: async () => ({ content: [{ type: "text", text: "fetched content" }] })
  }
];

// --- Tool Registry ---

export function createToolRegistry({ permissionEngine }) {
  const tools = new Map();

  // Register built-in tools at creation time
  for (const def of BUILTIN_TOOLS) {
    tools.set(def.name, { ...def });
  }

  function register(toolDef) {
    tools.set(toolDef.name, { ...toolDef });
  }

  function resolve(name) {
    return tools.get(name);
  }

  function listTools(filter = {}) {
    let result = [...tools.values()];
    if (filter.category) {
      result = result.filter(t => t.category === filter.category);
    }
    if (filter.source) {
      result = result.filter(t => t.source === filter.source);
    }
    return result;
  }

  function normalizeParams(toolName, rawParams) {
    const def = tools.get(toolName);
    if (!def) throw new Error(`Unknown tool: ${toolName}`);

    // Shell: only accept structured argv. Reject raw cmd strings.
    if (toolName === "shell") {
      if (typeof rawParams.cmd === "string") {
        throw new Error("Shell cmd string is not supported. Use structured argv: { argv: ['npm', 'test'] }");
      }
      return {
        argv: rawParams.argv || [],
        cwd: rawParams.cwd || ".",
        shell: false
      };
    }

    return rawParams;
  }

  function resolvePath(rawPath, projectRoot) {
    if (!rawPath) throw new Error("path is required");
    const resolved = path.resolve(projectRoot, rawPath);
    const rel = path.relative(projectRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path escapes project root: ${rawPath}`);
    }
    return resolved;
  }

  async function execute(toolCall, context) {
    const def = tools.get(toolCall.tool);
    if (!def) {
      return makeResult(toolCall.id, "error", [{ type: "error", text: `Unknown tool: ${toolCall.tool}` }]);
    }

    // Normalize params
    const normalizedParams = normalizeParams(toolCall.tool, toolCall.params || {});

    // Build a full tool call for permission check
    const fullCall = {
      id: toolCall.id,
      tool: def.name,
      category: def.category,
      risk_level: def.risk_level,
      side_effect: def.side_effect,
      params: normalizedParams
    };

    // Permission check
    const permission = permissionEngine.decide(fullCall, context);
    if (permission.decision === "deny") {
      return makeResult(toolCall.id, "denied", [{ type: "error", text: `Permission denied: ${permission.matched_rule}` }]);
    }
    if (permission.decision === "ask") {
      return {
        id: toolCall.id || `result_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        status: "approval_required",
        content: [{ type: "text", text: `Approval required: ${permission.matched_rule}` }],
        metadata: { matched_rule: permission.matched_rule },
        duration_ms: 0
      };
    }

    // Execute
    const startTime = Date.now();
    try {
      const result = def.execute
        ? await def.execute(normalizedParams, context)
        : { content: [{ type: "text", text: "ok" }] };

      return {
        id: toolCall.id || `result_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        status: "success",
        ...result,
        duration_ms: Date.now() - startTime
      };
    } catch (error) {
      return makeResult(toolCall.id, "error", [{ type: "error", text: error.message }], {},
        Date.now() - startTime);
    }
  }

  return { register, resolve, listTools, normalizeParams, execute };
}

function makeResult(id, status, content, metadata = {}, duration_ms = 0) {
  return {
    id: id || `result_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    status,
    content,
    metadata,
    duration_ms
  };
}
```

#### Step 4: Run tests

Run: `node --test test/kernel/tool-registry.test.js`
Expected: all 9 tests PASS

#### Step 5: Commit

```bash
git add src/kernel/tool-registry.js test/kernel/tool-registry.test.js
git commit -m "feat(kernel): add Tool Registry with built-in tools and permission-gated execution"
```

---

### Task 3: Integration

#### Step 0: Update package.json check script

Add `src/kernel/permission-engine.js` and `src/kernel/tool-registry.js` to the explicit file list in the `check` script within `package.json`.

#### Step 1: Run all tests

Run: `node --test test/patch.test.js test/kernel/*.test.js`
Expected: all PASS (83 + 13 + 9 = 105)

#### Step 2: Run npm check

Run: `npm run check`
Expected: no output

#### Step 3: Commit

```bash
git commit -m "chore: Phase 2 integration complete"
```

---

### Phase 2 Completion Checklist

```
- [ ] src/kernel/permission-engine.js created and tested (13 tests, including full 8×4 matrix)
- [ ] src/kernel/tool-registry.js created and tested (9 tests, with workspace boundary protection)
- [ ] package.json "check" script updated with new kernel files
- [ ] npm run check passes
- [ ] All 105 tests pass
```
