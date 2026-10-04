import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { mkdtemp } from "../helpers/tmp.js";

test("kernel metrics exposes real DeepSeek usage stats", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-usage-metrics-"));
  await writeFile(path.join(root, "README.md"), "# demo\n");
  const usage = {
    requests: 1,
    total_prompt_tokens: 100,
    total_completion_tokens: 20,
    total_reasoning_tokens: 5,
    total_tokens: 120,
    cache_hit_tokens: 40,
    cache_miss_tokens: 60,
    cache_hit_rate: 0.4,
    avg_latency_ms: 33,
    by_channel: { act: { requests: 1, prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
    by_model: {}
  };
  const kernel = await createKernel(root, {
    sessionRoot: path.join(root, ".sessions"),
    sessionLog: null,
    context: { cacheRoot: path.join(root, ".context-cache") },
    modelGateway: {
      getUsageStats: () => usage,
      reply: async () => ({ content: "ok" })
    }
  });

  assert.deepEqual(kernel.metrics.getUsage(), usage);
  assert.equal(kernel.metrics.getContext().indexed_paths, 1);
  const redacted = await kernel.metrics.getSnapshot({ channel: "reply", classification: { task_type: "query" } });
  assert.equal(redacted.summary, undefined);
  assert.ok(redacted.units.some((u) => u.path === "README.md"));
  // Full snapshot (kernel.context) still has summary
  const full = await kernel.context.snapshot({ channel: "reply", classification: { task_type: "query" } });
  assert.ok(full.summary.includes("README.md"));
});

test("kernel metrics returns zero usage when gateway has no stats", async () => {
  const kernel = await createKernel(process.cwd(), {
    sessionLog: null,
    context: { disabled: true },
    modelGateway: { reply: async () => ({ content: "ok" }) }
  });

  assert.equal(kernel.metrics.getUsage().cache_hit_rate, 0);
  assert.equal(kernel.metrics.getUsage().requests, 0);
});
