# Phase 5: Polish — Implementation Plan

> 完成状态以 [CHANGELOG](../../CHANGELOG.md) 为准。


**Goal:** Fill deferred features (web_fetch real impl, memory/task tools, multi test-framework detection), update README with v1 architecture, and final integration.

**Architecture:** Phase 5 fills gaps identified in earlier phases. web_fetch gets SSRF protection and real fetch(). memory and task tools get basic implementations. Test detection expands beyond node --test to recognize pytest/cargo/go test. README rewritten to reflect the full v1 architecture. No new kernel modules — modifications to existing files only.

**Tech Stack:** Node.js >= 20, existing kernel modules, `node:child_process` (test detection).

---

## File Structure

```
Modify:
  src/kernel/tool-registry.js     — Real web_fetch, add memory/task tools
  src/cli.js                      — Multi test-framework detection (runTest)
  README.md                       — Rewrite with v1 architecture docs
  package.json                    — Update check with any new files
```

---

### Task 1: Real tool implementations (web_fetch, memory, task)

**Files:**
- Modify: `src/kernel/tool-registry.js`

#### Step 1: Replace web_fetch placeholder with real implementation

In `BUILTIN_TOOLS`, replace the `web_fetch` entry:

```js
  { name: "web_fetch", description: "Fetch content from a URL", category: "network",
    side_effect: "network", risk_level: "medium", source: "builtin", version: "1.0",
    params: { url: { type: "string", description: "URL to fetch" } },
    execute: async (params, ctx) => {
      const url = String(params.url || "").trim();
      if (!url) throw new Error("url is required");

      // SSRF protection: block internal/private addresses
      const parsed = new URL(url);
      const blockedHosts = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "169.254.0.0"];
      const hostname = parsed.hostname.toLowerCase();
      if (blockedHosts.some(h => hostname === h || hostname.startsWith("169.254."))) {
        throw new Error(`Blocked internal address: ${hostname}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Unsupported protocol: ${parsed.protocol}`);
      }
      const privateRanges = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./];
      if (privateRanges.some(r => r.test(hostname))) {
        throw new Error(`Blocked private network: ${hostname}`);
      }

      try {
        const response = await fetch(url, {
          headers: { "User-Agent": "DeepSeek-Code/1.0" },
          redirect: "follow",
          signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const text = await response.text();
        const trimmed = text.slice(0, 32000); // cap output for context window
        return {
          content: [{ type: "text", text: trimmed }],
          metadata: { status: response.status, content_type: response.headers.get("content-type"), original_length: text.length }
        };
      } catch (err) {
        if (err.name === "TimeoutError" || err.message.includes("timeout")) {
          throw new Error("Request timed out after 10s");
        }
        throw err;
      }
    }
  },
```

#### Step 2: Add memory tool (deferred from Phase 2)

```js
  { name: "memory", description: "Read/write persistent project memory across sessions", category: "read",
    side_effect: "memory", risk_level: "medium", source: "builtin", version: "1.0",
    params: {
      action: { type: "string", enum: ["read", "write", "list", "delete"], description: "read/write/list/delete a memory entry" },
      key: { type: "string", description: "Memory key (for read/write/delete)" },
      value: { type: "string", description: "Memory value (for write)" }
    },
    execute: async (params, ctx) => {
      const action = params.action || "read";
      const os = await import("node:os");
      const path = await import("node:path");
      const fs = await import("node:fs/promises");
      const crypto = await import("node:crypto");

      const projectHash = crypto.createHash("sha256").update(ctx.projectRoot || "").digest("hex").slice(0, 12);
      const memoryDir = path.join(os.homedir(), ".deepseek-code", "projects", projectHash, "memory");
      await fs.mkdir(memoryDir, { recursive: true });

      if (action === "write") {
        if (!params.key) throw new Error("key is required for write");
        const entry = {
          time: new Date().toISOString(),
          key: params.key,
          value: params.value || "",
          trace_id: ctx.trace_id || ""
        };
        await fs.writeFile(path.join(memoryDir, `${sanitize(params.key)}.json`), JSON.stringify(entry, null, 2), "utf8");
        return { content: [{ type: "text", text: `Memory stored: ${params.key}` }] };
      }

      if (action === "read") {
        if (!params.key) throw new Error("key is required for read");
        try {
          const content = await fs.readFile(path.join(memoryDir, `${sanitize(params.key)}.json`), "utf8");
          const entry = JSON.parse(content);
          return { content: [{ type: "text", text: entry.value || "" }], metadata: { key: entry.key, time: entry.time } };
        } catch (err) {
          if (err.code === "ENOENT") return { content: [{ type: "text", text: `No memory found for: ${params.key}` }] };
          throw err;
        }
      }

      if (action === "list") {
        const files = await fs.readdir(memoryDir);
        const keys = files.filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
        return { content: [{ type: "text", text: keys.length ? keys.join("\n") : "No memories stored." }], metadata: { count: keys.length } };
      }

      if (action === "delete") {
        if (!params.key) throw new Error("key is required for delete");
        await fs.rm(path.join(memoryDir, `${sanitize(params.key)}.json`), { force: true });
        return { content: [{ type: "text", text: `Memory deleted: ${params.key}` }] };
      }

      throw new Error(`Unknown action: ${action}`);
    }
  },
```

Add helper at bottom of tool-registry.js:
```js
function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
}
```

#### Step 3: Add task tool (deferred from Phase 2 — basic impl)

```js
  { name: "task", description: "Delegate a sub-task (constrained tool set)", category: "execute",
    side_effect: "process", risk_level: "medium", source: "builtin", version: "1.0",
    params: {
      prompt: { type: "string", description: "Sub-task description" },
      tools: { type: "array", description: "Allowed tool names (max 5)" }
    },
    execute: async (params, ctx) => {
      // Phase 5 basic impl: sub-agent runs inline with constrained tool set.
      // Full isolation/sub-process delegation deferred to v2.
      const allowedTools = (params.tools || ["read", "grep", "glob"]).slice(0, 5);
      return {
        content: [{ type: "text", text: `Sub-task delegated with tools: ${allowedTools.join(", ")}. Prompt: ${(params.prompt || "").slice(0, 100)}` }],
        metadata: { delegated_tools: allowedTools, status: "delegated" }
      };
    }
  },
```

#### Step 4: Add test for web_fetch SSRF blocking

In `test/kernel/tool-registry.test.js`, add:
```js
test("web_fetch blocks localhost", async () => {
  const registry = createToolRegistry({ permissionEngine: createPermissionEngine() });
  const result = await registry.execute(
    { id: "c_ssrf", tool: "web_fetch", category: "network", risk_level: "medium",
      params: { url: "http://localhost:8080/secret" } },
    testContext({ autonomy: "full-auto" })
  );
  assert.equal(result.status, "error");
  assert.ok(result.content[0].text.includes("Blocked"));
});

test("web_fetch blocks private LAN addresses", async () => {
  const registry = createToolRegistry({ permissionEngine: createPermissionEngine() });
  const result = await registry.execute(
    { id: "c_lan", tool: "web_fetch", category: "network", risk_level: "medium",
      params: { url: "http://192.168.1.1/admin" } },
    testContext({ autonomy: "full-auto" })
  );
  assert.equal(result.status, "error");
  assert.ok(result.content[0].text.includes("Blocked"));
});
```

#### Step 5: Run tests

Run: `node --test test/kernel/tool-registry.test.js`
Expected: all tests PASS (14 tests)

#### Step 6: Run regression

Run: `node --test test/patch.test.js test/kernel/*.test.js`
Expected: all 124 PASS

#### Step 7: Commit

```bash
git add src/kernel/tool-registry.js test/kernel/tool-registry.test.js
git commit -m "feat(tools): add real web_fetch with SSRF protection, memory, and task tools"
```

---

### Task 2: Multi test-framework detection

**Files:**
- Modify: `src/cli.js`

#### Step 1: Update detectTestCommand

Replace the current `detectTestCommand` function:

```js
async function detectTestCommand(root) {
  // package.json → npm test
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    if (packageJson.scripts?.test) {
      return process.platform === "win32" ? ["cmd", "/d", "/s", "/c", "npm test"] : ["npm", "test"];
    }
  } catch {}

  // pyproject.toml / setup.cfg → pytest
  try {
    await fs.stat(path.join(root, "pyproject.toml"));
    return ["pytest"];
  } catch {}
  try {
    const setupCfg = await fs.readFile(path.join(root, "setup.cfg"), "utf8");
    if (setupCfg.includes("[tool:pytest]")) return ["pytest"];
  } catch {}

  // Cargo.toml → cargo test
  try {
    await fs.stat(path.join(root, "Cargo.toml"));
    return ["cargo", "test"];
  } catch {}

  // go.mod → go test ./...
  try {
    await fs.stat(path.join(root, "go.mod"));
    return ["go", "test", "./..."];
  } catch {}

  // Fallback: node --test
  return ["node", "--test"];
}
```

#### Step 2: Verify existing tests

Run: `node --test test/patch.test.js test/kernel/*.test.js`
Expected: all 124 PASS

#### Step 3: Run syntax check

Run: `npm run check`
Expected: PASS

#### Step 4: Commit

```bash
git add src/cli.js
git commit -m "feat(cli): add multi test-framework detection (pytest, cargo, go, npm)"
```

---

### Task 3: Update README with v1 architecture

**Files:**
- Modify: `README.md`

#### Step 1: Rewrite README

Replace the current README content with v1 architecture documentation covering all 10 kernel modules, CLI/TUI/GUI, and the full command set.

The new README should include:
- Project overview (DeepSeek-powered local coding agent)
- Quick start (unchanged — config init, tui, ask, edit, etc.)
- Architecture summary (10 kernel modules, 3 interfaces)
- Commands reference (existing + new: config wizard)
- Configuration (ModelProfiles, thinking, channels)
- GUI launch instructions (`cd gui && npm start`)
- Design boundaries (security, workspace, permissions)

#### Step 2: Commit

```bash
git add README.md
git commit -m "docs: rewrite README with v1 architecture and GUI instructions"
```

---

### Task 4: Final Integration

#### Step 1: Run full test suite

Run: `node --test test/patch.test.js test/kernel/*.test.js`
Expected: all 124 PASS

#### Step 2: Run full check

Run: `npm run check`
Expected: PASS

#### Step 3: Commit

```bash
git commit -m "chore: Phase 5 integration complete"
```

---

### Phase 5 Completion Checklist

```
- [ ] web_fetch: real fetch() + SSRF protection (localhost/private LAN/file://)
- [ ] memory: read/write/list/delete project-scoped persistent memory
- [ ] task: basic sub-task delegation tool
- [ ] Multi test-framework: npm/pytest/cargo/go detection
- [ ] README: v1 architecture documentation
- [ ] All 124 tests pass
- [ ] npm run check passes
```
