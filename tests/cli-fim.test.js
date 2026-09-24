import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFim } from "../src/cli.js";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const binPath = path.join(repoRoot, "bin", "inkstone.js");

// runFim 经 process.exitCode 报错(循 runTest 风格),而 node --test 以整个文件的
// 进程退出码判定成败——故每个可能置位的用例前后保存/恢复,避免失败用例把绿测染红。
async function captureExitCode(fn) {
  const original = process.exitCode;
  try {
    return await fn();
  } finally {
    process.exitCode = original;
  }
}

// 假 config:loadConfig(allowMissingKey:false) 的最小形态
// (maxTokens 默认值来源 + limits.modelTimeoutMs 透传)。
const fakeConfig = {
  apiKey: "sk-test",
  maxTokens: 4096,
  limits: { modelTimeoutMs: 120000 }
};

// 假内核:记录 fim.complete 入参;metrics.getUsage 在调用前返回空账、调用后返回
// fim 通道入账(循 model-gateway recordUsage 之后的真实形态);dispose 记录调用。
function createFakeKernel({ completion = "  return a + b;\n}", usage = null, failWith = null } = {}) {
  const recorded = { calls: [], disposed: false };
  return {
    get calls() { return recorded.calls; },
    get disposed() { return recorded.disposed; },
    fim: {
      async complete(prefix, suffix, options) {
        recorded.calls.push({ prefix, suffix, options });
        if (failWith) throw failWith;
        return completion;
      }
    },
    metrics: {
      getUsage: () => (recorded.calls.length === 0
        ? { by_channel: {}, by_model: {} }
        : usage || {
            by_channel: { fim: { requests: 1, prompt_tokens: 96, completion_tokens: 128, total_tokens: 224 } },
            by_model: { "deepseek-flash": { requests: 1, prompt_tokens: 96, completion_tokens: 128, total_tokens: 224 } }
          })
    },
    dispose() { recorded.disposed = true; }
  };
}

// runFim 的 deps 注入(循 kernel-runner 的 *Impl DI 模式):捕获 stdout/stderr、
// 假 config / 假内核、假文件读、确定性时钟(每次调用 +500ms → 完成耗时恒 500ms)。
function makeHarness({ kernel, config = fakeConfig, files = {}, loadConfigImpl } = {}) {
  const out = [];
  const err = [];
  const created = [];
  const builtWith = [];
  const fakeKernel = kernel || createFakeKernel();
  let clock = 0;
  const deps = {
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
    loadConfigImpl: loadConfigImpl || (async () => config),
    buildKernelOptionsImpl: async (root) => { builtWith.push(root); return { built: true }; },
    createKernelImpl: async (root, options) => { created.push({ root, options }); return fakeKernel; },
    readFileImpl: async (file) => {
      const key = path.resolve(file);
      if (!(key in files)) {
        throw Object.assign(new Error(`ENOENT: no such file, open '${key}'`), { code: "ENOENT" });
      }
      return files[key];
    },
    now: () => (clock += 500)
  };
  return { deps, out, err, kernel: fakeKernel, created, builtWith };
}

test("无 prefix 来源 → stderr 一行用法提示 + 退出码 1，不触达内核", async () => {
  await captureExitCode(async () => {
    const h = makeHarness();
    await runFim("/root", [], new Map(), h.deps);

    assert.equal(process.exitCode, 1);
    assert.equal(h.err.length, 1);
    assert.match(h.err[0], /^用法：inkstone fim --prefix <text>/);
    assert.deepEqual(h.out, []);
    assert.equal(h.builtWith.length, 0);
    assert.equal(h.created.length, 0);
  });
});

test("--prefix 空字符串同样走用法提示（空 prefix 无补全意义）", async () => {
  await captureExitCode(async () => {
    const h = makeHarness();
    await runFim("/root", [], new Map([["prefix", ""]]), h.deps);

    assert.equal(process.exitCode, 1);
    assert.match(h.err[0], /^用法：/);
    assert.equal(h.created.length, 0);
  });
});

test("--prefix 与 --file 同给 → 互斥报错，不读文件不建内核", async () => {
  await captureExitCode(async () => {
    const h = makeHarness({ files: { [path.resolve("/root/a.js")]: "content" } });
    await runFim("/root", [], new Map([["prefix", "p"], ["file", "a.js"]]), h.deps);

    assert.equal(process.exitCode, 1);
    assert.equal(h.err.length, 1);
    assert.match(h.err[0], /互斥/);
    assert.deepEqual(h.out, []);
    assert.equal(h.created.length, 0);
  });
});

test("--file 读取失败 → stderr 一行 + 退出码 1", async () => {
  await captureExitCode(async () => {
    const h = makeHarness({ files: {} });
    await runFim("/root", [], new Map([["file", "missing.js"]]), h.deps);

    assert.equal(process.exitCode, 1);
    assert.equal(h.err.length, 1);
    assert.match(h.err[0], /读取 --file 文件失败/);
    assert.equal(h.created.length, 0);
  });
});

test("--file 读文件全文作 prefix（未给 --prefix 时）", async () => {
  await captureExitCode(async () => {
    const filePath = path.resolve("/root", "src", "a.js");
    const h = makeHarness({ files: { [filePath]: "FILE PREFIX CONTENT" } });
    await runFim("/root", [], new Map([["file", path.join("src", "a.js")]]), h.deps);

    assert.equal(h.kernel.calls.length, 1);
    assert.equal(h.kernel.calls[0].prefix, "FILE PREFIX CONTENT");
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].root, "/root");
    assert.deepEqual(h.created[0].options, { built: true });
    assert.deepEqual(h.builtWith, ["/root"]);
  });
});

test("位置参数作 prefix（未给 --prefix/--file 时，循 search 的 join 约定）", async () => {
  await captureExitCode(async () => {
    const h = makeHarness();
    await runFim("/root", ["const", "x", "="], new Map(), h.deps);

    assert.equal(h.kernel.calls[0].prefix, "const x =");
  });
});

test("成功路径：正文原样 stdout + dim 用量摘要 + finally dispose", async () => {
  await captureExitCode(async () => {
    const h = makeHarness();
    await runFim("/root", [], new Map([["prefix", "function add(a, b) {"], ["suffix", "}"]]), h.deps);

    assert.ok(!process.exitCode, "成功路径不得留下非零退出码");
    assert.equal(h.kernel.calls.length, 1);
    const call = h.kernel.calls[0];
    assert.equal(call.prefix, "function add(a, b) {");
    assert.equal(call.suffix, "}");
    assert.equal(call.options.model, undefined, "未给 --model 时不覆盖 models.fim 解析");
    assert.equal(call.options.maxTokens, 4096, "默认取 config.maxTokens（4096）");
    assert.equal(call.options.timeoutMs, 120000, "config.limits.modelTimeoutMs 透传");
    assert.equal(h.out[0], "  return a + b;\n}", "补全正文原样落 stdout");
    assert.ok(h.out[1].includes("deepseek-flash"), "摘要含遥测解析出的模型");
    assert.ok(h.out[1].includes("128 completion tokens"));
    assert.ok(h.out[1].includes("500 ms"));
    assert.ok(h.out[1].includes("256 tps"));
    assert.equal(h.kernel.disposed, true);
  });
});

test("--model 显式覆盖并进摘要", async () => {
  await captureExitCode(async () => {
    const h = makeHarness();
    await runFim("/root", [], new Map([["prefix", "p"], ["model", "custom-fim"]]), h.deps);

    assert.equal(h.kernel.calls[0].options.model, "custom-fim");
    assert.ok(h.out[1].includes("custom-fim"));
  });
});

test("--max-tokens 缺省取 config.maxTokens（非 4096 时原样透传）", async () => {
  await captureExitCode(async () => {
    const h = makeHarness({ config: { ...fakeConfig, maxTokens: 2048 } });
    await runFim("/root", [], new Map([["prefix", "p"]]), h.deps);

    assert.equal(h.kernel.calls[0].options.maxTokens, 2048);
    assert.equal(h.err.length, 0, "未超限不提示");
  });
});

test("--max-tokens 超 4096 → 钳制为 4096 并提示，退出码不受影响", async () => {
  await captureExitCode(async () => {
    const h = makeHarness();
    await runFim("/root", [], new Map([["prefix", "p"], ["max-tokens", "99999"]]), h.deps);

    assert.equal(h.kernel.calls[0].options.maxTokens, 4096);
    assert.equal(h.err.length, 1);
    assert.match(h.err[0], /--max-tokens 99999 超过 4096 上限，已钳制为 4096/);
    assert.ok(!process.exitCode, "钳制是提示不是错误");
  });
});

test("fim.complete 失败 → stderr 静默一行 error message + 退出码 1 + 仍 dispose", async () => {
  await captureExitCode(async () => {
    const h = makeHarness({ kernel: createFakeKernel({ failWith: new Error("model request timed out after 120000ms") }) });
    await runFim("/root", [], new Map([["prefix", "p"]]), h.deps);

    assert.equal(process.exitCode, 1);
    assert.deepEqual(h.err, ["model request timed out after 120000ms"], "错误 message 原样一行，不加前缀");
    assert.deepEqual(h.out, [], "stdout 不漏错误文本");
    assert.equal(h.kernel.disposed, true);
  });
});

test("遥测缺账时摘要只含 latency（“若有”语义：不造假 tokens/model）", async () => {
  await captureExitCode(async () => {
    const h = makeHarness({ kernel: createFakeKernel({ usage: { by_channel: {}, by_model: {} } }) });
    await runFim("/root", [], new Map([["prefix", "p"]]), h.deps);

    assert.equal(h.out.length, 2);
    assert.equal(h.out[1], "500 ms");
  });
});

test("无 API 密钥 → loadConfig 抛出向上传播（循现有风格，由 bin 统一落 stderr + 退出码 1）", async () => {
  await captureExitCode(async () => {
    const h = makeHarness({
      loadConfigImpl: async () => {
        throw new Error("缺少 DeepSeek API 密钥。请运行 config init --api-key <key>，或设置 DEEPSEEK_API_KEY。");
      }
    });
    await assert.rejects(
      runFim("/root", [], new Map([["prefix", "p"]]), h.deps),
      /缺少 DeepSeek API 密钥/
    );
    assert.equal(h.created.length, 0, "密钥缺失不建内核");
  });
});

test("子进程：inkstone fim（无 prefix）→ 退出码 1 + stderr 用法提示", () => {
  const child = spawnSync(process.execPath, [binPath, "fim"], { encoding: "utf8" });

  assert.equal(child.status, 1, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
  assert.match(child.stderr, /用法：inkstone fim --prefix/);
  assert.equal(child.stdout, "");
});

test("子进程：inkstone help 输出含 fim 命令行", () => {
  const child = spawnSync(process.execPath, [binPath, "help"], { encoding: "utf8" });

  assert.equal(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
  assert.ok(child.stdout.includes("inkstone fim --prefix <text>"));
});
