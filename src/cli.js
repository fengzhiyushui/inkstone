import { promises as fs } from "node:fs";
import path from "node:path";
import { describeChange, formatChange, listChanges, rollbackChange } from "./changes.js";
import { configureProject, DEFAULT_CONFIG, loadConfig } from "./config.js";
import { buildProjectContext } from "./context.js";
import { showDiff } from "./git.js";
import { createKernel } from "./index.js";
import { testDeepSeekConnection } from "./provider.js";
import { searchProject } from "./search.js";
import { runTui } from "./tui.js";
import { banner, color, commandLine, section, statusLine } from "./theme.js";
import { buildEditPrompt, buildKernelOptions, runKernelAgentCommand, runKernelChatCommand, runKernelTestCommand } from "./apps/cli/kernel-runner.js";

export async function runCli(argv) {
  const root = process.cwd();
  const { command, args, flags } = parseArgs(argv);

  switch (command) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return;
    case "ask":
      await runAsk(root, args, flags);
      return;
    case "chat":
      await runChat(root, args, flags);
      return;
    case "tui":
      await runTui(root);
      return;
    case "edit":
      await runEdit(root, args, flags);
      return;
    case "scan":
      await runScan(root, flags);
      return;
    case "search":
      await runSearch(root, args, flags);
      return;
    case "fim":
      await runFim(root, args, flags);
      return;
    case "test":
      await runTest(root, args);
      return;
    case "diff":
      await runDiff(root);
      return;
    case "config":
      await runConfig(root, args, flags);
      return;
    case "changes":
      await runChanges(root, args, flags);
      return;
    case "rollback":
      await runRollback(root, args);
      return;
    case "resume":
      await runResume(root);
      return;
    default:
      throw new Error(`未知命令 "${command}"。运行 "inkstone help" 查看帮助。`);
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = [];
  const flags = new Map();

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) {
      args.push(value);
      continue;
    }

    const raw = value.slice(2);
    const [key, inline] = raw.split("=", 2);
    if (inline !== undefined) {
      appendFlag(flags, key, inline);
      continue;
    }

    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      appendFlag(flags, key, next);
      index += 1;
    } else {
      appendFlag(flags, key, true);
    }
  }

  return { command, args, flags };
}

function appendFlag(flags, key, value) {
  if (!flags.has(key)) {
    flags.set(key, value);
    return;
  }

  const current = flags.get(key);
  if (Array.isArray(current)) {
    current.push(value);
  } else {
    flags.set(key, [current, value]);
  }
}

async function runAsk(root, args, flags) {
  const prompt = args.join(" ").trim();
  if (!prompt) {
    throw new Error("ask command requires a question.");
  }

  await runKernelAgentCommand({
    root,
    prompt,
    autonomy: stringFlag(flags, "autonomy") || "gated",
    sendOptions: commonOptions(flags),
    ...semanticKernelOptions(flags)
  });
}

async function runChat(root, args, flags) {
  const prompt = args.join(" ").trim();
  await runKernelChatCommand({
    root,
    prompt,
    sendOptions: commonOptions(flags),
    ...semanticKernelOptions(flags)
  });
}

async function runEdit(root, args, flags) {
  const prompt = args.join(" ").trim();
  if (!prompt) {
    throw new Error("edit command requires an edit request.");
  }

  const dryRun = boolFlag(flags, "dry-run");
  const yes = boolFlag(flags, "yes");
  const files = arrayFlag(flags, "file");
  const fileHint = files.length ? `\n\nRelevant files: ${files.join(", ")}` : "";

  await runKernelAgentCommand({
    root,
    prompt: buildEditPrompt(`${prompt}${fileHint}`, { dryRun }),
    autonomy: yes ? "gated" : "supervised",
    sendOptions: commonOptions(flags),
    ...semanticKernelOptions(flags)
  });
}

async function runScan(root, flags) {
  const context = await buildProjectContext(root, commonOptions(flags));
  console.log(banner());
  console.log("");
  console.log(context.indexText);
}

async function runSearch(root, args, flags) {
  const pattern = args.join(" ").trim();
  if (!pattern) {
    throw new Error("搜索命令需要输入关键词。");
  }

  const matches = await searchProject(root, pattern, {
    maxMatches: numberFlag(flags, "max", 80)
  });

  if (!matches.length) {
    console.log(statusLine("搜索", "没有找到匹配结果。"));
    return;
  }

  console.log(section("搜索结果"));
  console.log("");
  for (const match of matches) {
    console.log(`${match.path}:${match.line}:${match.column}: ${match.text}`);
  }
}

// v1.9.0 M3 A3:`inkstone fim` —— FIM 补全的 CLI 落点。D3 拍板:prefix 取
// --prefix 文本或 --file 文件全文(两者互斥),不支持光标内联。转调组合根门面
// kernel.fim.complete → modelGateway.fimComplete(models.fim 解析、timeoutMs→
// signal、recordUsage 均在内核侧完成)。补全正文原样写 stdout,随后一行 dim
// 用量摘要(缺项即省);失败只往 stderr 打一行错误 message,退出码非零,stdout
// 不漏错误文本。loadConfig 无密钥的报错循现有风格直接上抛(bin 统一处理)。
// deps 为测试注入点(循 kernel-runner 的 *Impl DI 模式),生产路径全走默认值。
export async function runFim(root, args, flags, deps = {}) {
  const {
    write = console.log,
    writeError = (line) => console.error(line),
    loadConfigImpl = loadConfig,
    buildKernelOptionsImpl = buildKernelOptions,
    createKernelImpl = createKernel,
    readFileImpl = (file) => fs.readFile(file, "utf8"),
    now = () => Date.now()
  } = deps;

  const prefixFlag = stringFlag(flags, "prefix");
  const fileFlag = stringFlag(flags, "file");
  if (prefixFlag !== undefined && fileFlag !== undefined) {
    process.exitCode = 1;
    writeError("--prefix 与 --file 互斥，请只提供一个 prefix 来源。");
    return;
  }

  let prefix;
  if (fileFlag !== undefined) {
    try {
      prefix = String(await readFileImpl(path.resolve(root, fileFlag)));
    } catch (error) {
      process.exitCode = 1;
      writeError(`读取 --file 文件失败：${error.message}`);
      return;
    }
  } else if (prefixFlag !== undefined) {
    prefix = prefixFlag;
  } else {
    prefix = args.join(" ").trim();
  }

  if (!prefix) {
    process.exitCode = 1;
    writeError("用法：inkstone fim --prefix <text> [--suffix <text>] [--file <path>] [--max-tokens <n>] [--model <id>]");
    return;
  }

  // 语法期先解析(非数字即抛,循 numberFlag 既有约定);默认值在 loadConfig 之后与 config 合并。
  const requestedMaxTokens = numberFlag(flags, "max-tokens", undefined);
  const model = stringFlag(flags, "model");
  const suffix = stringFlag(flags, "suffix") ?? "";
  // 无密钥时报错循现有风格:loadConfig(allowMissingKey:false)直接抛
  // 「缺少 DeepSeek API 密钥…」,由 bin/inkstone.js 顶层 catch 统一落 stderr + 退出码 1。
  const config = await loadConfigImpl(root, { allowMissingKey: false });

  let maxTokens = requestedMaxTokens ?? config.maxTokens ?? FIM_MAX_TOKENS;
  if (maxTokens > FIM_MAX_TOKENS) {
    writeError(`--max-tokens ${maxTokens} 超过 ${FIM_MAX_TOKENS} 上限，已钳制为 ${FIM_MAX_TOKENS}。`);
    maxTokens = FIM_MAX_TOKENS;
  }

  const kernel = await createKernelImpl(root, await buildKernelOptionsImpl(root));
  const usageBefore = readFimUsage(kernel);
  const startedAt = now();
  try {
    const completion = await kernel.fim.complete(prefix, suffix, {
      model,
      maxTokens,
      timeoutMs: config.limits?.modelTimeoutMs
    });
    const usageSummary = formatFimUsageSummary(kernel, usageBefore, model, now() - startedAt);
    write(String(completion ?? ""));
    if (usageSummary) write(color.dim(usageSummary));
  } catch (error) {
    // 失败静默一行:错误 message 原样进 stderr(不加前缀),非零退出码。
    process.exitCode = 1;
    writeError(String(error?.message || error));
  } finally {
    kernel.dispose?.();
  }
}

// FIM_MAX_TOKENS 与 src/deepseek/fim-client.js 的同名常量同值(beta/completions
// 的 4K 上限)。CLI 侧先钳制并提示,客户端侧仍会再钳一次(双保险,行为不变)。
const FIM_MAX_TOKENS = 4096;

// kernel.metrics.getUsage() 的安全读取(遥测不可读不当失败)。
function readFimUsage(kernel) {
  try {
    return kernel?.metrics?.getUsage?.() ?? null;
  } catch {
    return null;
  }
}

// 用量摘要文案(不含 dim,由调用方着色)。取 kernel.metrics.getUsage() 的 fim
// 通道增量:before 在 complete 前取,after 在 complete 后取;进程内此前无 fim
// 调用时增量即本次。网关注销用量(usage 为 null 不入账)时该通道缺失,
// completion tokens / model 段即省("若有")。latency 由 CLI 侧计时;tps 循
// src/core/execution/executor-loop.js:148 约定:completion tokens/(latency/1000)
// 保留 1 位小数,tokens 或 latency 缺失/为 0 时不附段。
function formatFimUsageSummary(kernel, before, model, latencyMs) {
  let completionTokens = null;
  let resolvedModel = model || null;
  try {
    const after = readFimUsage(kernel);
    const afterChannel = after?.by_channel?.fim;
    if (afterChannel && afterChannel.requests > (before?.by_channel?.fim?.requests ?? 0)) {
      completionTokens = afterChannel.completion_tokens - (before?.by_channel?.fim?.completion_tokens ?? 0);
      resolvedModel = resolvedModel || firstGrownModel(after.by_model, before?.by_model);
    }
  } catch {
    // 遥测不可读不阻断补全输出("若有"语义)。
  }

  const parts = [];
  if (resolvedModel) parts.push(resolvedModel);
  if (Number.isFinite(completionTokens)) parts.push(`${completionTokens} completion tokens`);
  parts.push(`${latencyMs} ms`);
  if (Number.isFinite(completionTokens) && completionTokens > 0 && latencyMs > 0) {
    parts.push(`${Math.round((completionTokens / (latencyMs / 1000)) * 10) / 10} tps`);
  }
  return parts.join(" · ");
}

// by_model 里 requests 增长的键即本次调用所用模型(delta 视角,取首个)。
function firstGrownModel(afterModels, beforeModels) {
  for (const [model, stats] of Object.entries(afterModels || {})) {
    const previous = beforeModels?.[model];
    if (!previous || stats.requests > previous.requests) return model;
  }
  return null;
}

async function runTest(root, args) {
  const result = await runKernelTestCommand({ root, argv: args });
  if (result.status === "error" || result.status === "denied") {
    process.exitCode = 1;
  } else if (result.metadata?.exit_code != null && result.metadata.exit_code !== 0) {
    process.exitCode = result.metadata.exit_code;
  }
}

async function runDiff(root) {
  const diff = await showDiff(root);
  console.log(section("Git 差异"));
  console.log("");
  console.log(diff || "没有可显示的 Git 差异。");
}

async function runConfig(root, args, flags) {
  const action = args[0] || "show";
  if (action === "show") {
    const config = await loadConfig(root, { allowMissingKey: true });
    console.log(JSON.stringify(redactConfig(config), null, 2));
    return;
  }

  if (action === "test") {
    const config = await loadConfig(root);
    await testDeepSeekConnection(config);
    console.log("DeepSeek API 连接测试通过。");
    return;
  }

  if (action === "init") {
    const { target } = await configureProject(root, {
      apiKey: stringFlag(flags, "api-key") || "",
      model: stringFlag(flags, "model") || DEFAULT_CONFIG.model,
      baseUrl: stringFlag(flags, "base-url") || DEFAULT_CONFIG.baseUrl,
      thinking: boolFlag(flags, "thinking") ? { type: "enabled" } : DEFAULT_CONFIG.thinking,
      reasoningEffort: stringFlag(flags, "reasoning-effort") || DEFAULT_CONFIG.reasoningEffort
    });
    console.log(`已写入 ${path.relative(root, target)}`);
    return;
  }

  throw new Error(`未知配置操作 "${action}"。可使用 "config show"、"config init" 或 "config test"。`);
}

async function runChanges(root, args, flags) {
  const action = args[0] || "list";
  if (action === "list") {
    const records = await listChanges(root, numberFlag(flags, "limit", 20));
    if (!records.length) {
      console.log("还没有变更记录。");
      return;
    }
    for (const record of records) {
      const files = record.summary.map((item) => item.path).join(", ");
      console.log(`${record.id}  ${record.time}  ${files}`);
    }
    return;
  }

  if (action === "show") {
    const record = await describeChange(root, args[1] || "latest");
    console.log(formatChange(record));
    return;
  }

  throw new Error(`未知变更操作 "${action}"。可使用 "changes list" 或 "changes show latest"。`);
}

async function runRollback(root, args) {
  const record = await rollbackChange(root, args[0] || "latest");
  console.log(`已回退变更：${record.id}`);
}

async function runResume(root) {
  const logPath = path.join(root, ".deepseek-code", "sessions.jsonl");
  try {
    const content = await fs.readFile(logPath, "utf8");
    const lines = content.trim().split(/\r?\n/).filter(Boolean).slice(-10);
    console.log(lines.join("\n") || "没有会话记录。");
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("还没有会话日志。");
      return;
    }
    throw error;
  }
}

function commonOptions(flags) {
  return {
    stream: !boolFlag(flags, "no-stream"),
    maxFiles: numberFlag(flags, "max-files", 400),
    maxBytes: numberFlag(flags, "max-bytes", 60_000)
  };
}

export function semanticOverrideFromFlags(flags) {
  if (boolFlag(flags, "include-method-hints")) return { enabled: true, includeMethodHints: true };
  if (boolFlag(flags, "semantic-context")) return { enabled: true };
  return null;
}

function semanticKernelOptions(flags) {
  const semantic = semanticOverrideFromFlags(flags);
  return semantic ? { createKernelOptions: { context: { semantic } } } : {};
}

function boolFlag(flags, key) {
  const value = flags.get(key);
  return value === true || value === "true";
}

function stringFlag(flags, key) {
  const value = flags.get(key);
  if (Array.isArray(value)) {
    return String(value.at(-1));
  }
  return value === undefined || value === true ? undefined : String(value);
}

function arrayFlag(flags, key) {
  const value = flags.get(key);
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function numberFlag(flags, key, fallback) {
  const value = stringFlag(flags, key);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${key} 必须是非负数字。`);
  }
  return parsed;
}

function redactConfig(config) {
  return {
    ...config,
    apiKey: config.apiKey ? `${config.apiKey.slice(0, 6)}...` : ""
  };
}

function printHelp() {
  console.log(`${banner()}

用法：
${commandLine("inkstone tui", "打开交互式终端界面")}
${commandLine("inkstone ask \"问题\"", "基于项目上下文提问")}
${commandLine("inkstone chat [问题]", "连续对话，自动保存上下文")}
${commandLine("inkstone ask \"问题\" --semantic-context", "启用符号级语义上下文")}
${commandLine("inkstone ask \"问题\" --include-method-hints", "语义上下文 + 方法调用提示(probable)")}
${commandLine("inkstone edit \"需求\" --file src/a.js", "生成补丁，确认后修改文件")}
${commandLine("inkstone search \"TODO\"", "搜索项目代码")}
${commandLine("inkstone fim --prefix <text>", "FIM 代码补全，支持 --suffix / --file")}
${commandLine("inkstone scan", "扫描并打印项目上下文")}
${commandLine("inkstone test [命令...]", "运行测试")}
${commandLine("inkstone diff", "查看 Git 差异")}
${commandLine("inkstone config init --api-key <key>", "写入本地配置")}
${commandLine("inkstone config show", "查看当前生效配置")}
${commandLine("inkstone config test", "测试 DeepSeek API 连接")}
${commandLine("inkstone changes list", "查看修改记录")}
${commandLine("inkstone changes show latest", "查看修改详情")}
${commandLine("inkstone rollback latest", "回退最近修改")}
${commandLine("inkstone resume", "查看最近会话记录")}

环境变量：
  DEEPSEEK_API_KEY     如果本地配置没有 apiKey，则使用这里的密钥
  DEEPSEEK_BASE_URL    默认 https://api.deepseek.com
  DEEPSEEK_MODEL       默认 deepseek-flash
  DEEPSEEK_REASONING_EFFORT 默认 high
`);
}
