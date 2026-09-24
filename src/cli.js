import { promises as fs } from "node:fs";
import path from "node:path";
import { describeChange, formatChange, listChanges, rollbackChange } from "./changes.js";
import { configureProject, DEFAULT_CONFIG, loadConfig } from "./config.js";
import { buildProjectContext } from "./context.js";
import { showDiff } from "./git.js";
import { testDeepSeekConnection } from "./provider.js";
import { searchProject } from "./search.js";
import { runTui } from "./tui.js";
import { banner, commandLine, section, statusLine } from "./theme.js";
import { buildEditPrompt, runKernelAgentCommand, runKernelChatCommand, runKernelTestCommand } from "./apps/cli/kernel-runner.js";

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
