import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "../../helpers/tmp.js";

import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  createWebFetchTool,
  collectCappedBody,
  WEB_FETCH_MAX_BODY_BYTES
} from "../../../src/tools/builtin/web-fetch.js";
import { createMemoryTool } from "../../../src/tools/builtin/memory.js";
import { createTaskTool } from "../../../src/tools/builtin/task.js";
import { createAskUserTool } from "../../../src/tools/builtin/ask-user.js";
import { createDeferredEditTools } from "../../../src/tools/builtin/edit-deferred.js";

test("web_fetch validates URL and truncates response", async () => {
  const tool = createWebFetchTool({
    lookup: async () => ({ address: "93.184.216.34" }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => "x".repeat(40000)
    })
  });

  const result = await tool.execute({ url: "https://example.com" }, {});

  assert.equal(result.content[0].text.length, 32000);
  assert.equal(result.metadata.original_length, 40000);
});

test("web_fetch gives network layer the prevalidated IP (no second DNS resolution)", async () => {
  let seen = null;
  const tool = createWebFetchTool({
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 }
    ],
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => "ok"
      };
    }
  });

  await tool.execute({ url: "https://example.com/path" }, {});
  assert.equal(seen.url, "https://example.com/path");
  assert.equal(seen.options.validatedAddress, "93.184.216.34");
  assert.equal(seen.options.redirect, "manual");
});

test("web_fetch blocks localhost", async () => {
  const tool = createWebFetchTool();
  await assert.rejects(() => tool.execute({ url: "http://localhost:3000" }, {}), /blocked/i);
});

test("collectCappedBody stores at most WEB_FETCH_MAX_BODY_BYTES but reports full length", async () => {
  const payload = Buffer.alloc(WEB_FETCH_MAX_BODY_BYTES + 5000, 0x61); // 'a'
  const stream = Readable.from([payload.subarray(0, 10000), payload.subarray(10000)]);
  const { text, originalLength } = await collectCappedBody(stream, WEB_FETCH_MAX_BODY_BYTES);
  assert.equal(originalLength, WEB_FETCH_MAX_BODY_BYTES + 5000);
  assert.equal(text.length, WEB_FETCH_MAX_BODY_BYTES);
  assert.equal(text, "a".repeat(WEB_FETCH_MAX_BODY_BYTES));
});

test("web_fetch metadata preserves originalLength from network layer", async () => {
  const tool = createWebFetchTool({
    lookup: async () => ({ address: "93.184.216.34" }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/plain"]]),
      originalLength: 90000,
      text: async () => "y".repeat(WEB_FETCH_MAX_BODY_BYTES)
    })
  });
  const result = await tool.execute({ url: "https://example.com/big" }, {});
  assert.equal(result.content[0].text.length, WEB_FETCH_MAX_BODY_BYTES);
  assert.equal(result.metadata.original_length, 90000);
});

test("memory tool maps categories by action and persists project memory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-proj-"));
  const memoryRoot = await mkdtemp(path.join(tmpdir(), "dsc-memory-"));
  const tool = createMemoryTool();

  assert.equal(tool.resolveCategory({ action: "write" }), "write_update");
  assert.equal(tool.resolveCategory({ action: "delete" }), "write_delete");

  await tool.execute({ action: "write", key: "style", value: "Use ESM" }, { projectRoot: root, memoryRoot });
  const read = await tool.execute({ action: "read", key: "style" }, { projectRoot: root, memoryRoot });

  assert.equal(read.content[0].text, "Use ESM");
});

test("task tool caps delegated tools to five", async () => {
  const result = await createTaskTool().execute({
    prompt: "inspect files",
    tools: ["read", "grep", "glob", "ls", "git", "shell"]
  }, {});

  assert.deepEqual(result.metadata.delegated_tools, ["read", "grep", "glob", "ls", "git"]);
});

test("ask_user creates an approval-style pending result", async () => {
  const result = await createAskUserTool().execute({ question: "Which file?" }, {});
  assert.equal(result.status, "awaiting_user");
  assert.equal(result.content[0].text, "Which file?");
});

test("deferred edit tools dispatch to configured editService", async () => {
  const calls = [];
  const editService = {
    preview: async (params) => {
      calls.push(["preview", params]);
      return { content: [{ type: "text", text: "previewed" }], metadata: { ok: true } };
    },
    apply: async (params) => {
      calls.push(["apply", params]);
      return { content: [{ type: "text", text: "applied" }], metadata: { ok: true } };
    },
    rollback: async (params) => {
      calls.push(["rollback", params]);
      return { content: [{ type: "text", text: "rolled back" }], metadata: { ok: true } };
    }
  };

  const [preview, apply, rollback, edit] = createDeferredEditTools({ editService });
  assert.equal((await preview.execute({ diff: "d" }, {})).content[0].text, "previewed");
  assert.equal((await apply.execute({ diff: "d", prompt: "p", approval_id: "a" }, {})).content[0].text, "applied");
  assert.equal((await rollback.execute({ change_id: "c" }, {})).content[0].text, "rolled back");
  assert.equal((await edit.execute({ diff: "d", prompt: "p" }, {})).content[0].text, "applied");

  assert.deepEqual(calls.map(([name]) => name), ["preview", "apply", "rollback", "apply"]);
});

test("deferred edit tools fail clearly without editService", async () => {
  const [preview] = createDeferredEditTools();
  await assert.rejects(
    () => preview.execute({ diff: "--- a\n" }, {}),
    /Edit service is not configured/
  );
});
