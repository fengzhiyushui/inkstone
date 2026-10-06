import { promises as fs } from "node:fs";
import path from "node:path";
import { describeChange, formatChange, listChanges, rollbackChange } from "./changes.js";
import { configureProject, DEFAULT_CONFIG, loadConfig } from "./config.js";
import { buildProjectContext } from "./context.js";
import { showDiff } from "./git.js";
import { createKernel } from "./index.js";
import { testDeepSeekConnection } from "./provider.js";
import { createMcpDisplayRedactor } from "./security/mcp-content.js";
import { searchProject } from "./search.js";
import { runTui } from "./tui.js";
import { banner, color, commandLine, section, statusLine } from "./theme.js";
import { buildEditPrompt, buildKernelOptions, runKernelAgentCommand, runKernelChatCommand, runKernelTestCommand } from "./apps/cli/kernel-runner.js";
import { runMcpAuth } from "./apps/cli/mcp-auth.js";
import { runMcpLogs } from "./apps/cli/mcp-logs.js";

export async function runCli(argv, deps = {}) {
  const root = deps.root || process.cwd();
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
    case "mcp":
      await runMcp(root, args, flags, deps.mcp);
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
    const equalAt = raw.indexOf("=");
    const key = equalAt < 0 ? raw : raw.slice(0, equalAt);
    const inline = equalAt < 0 ? undefined : raw.slice(equalAt + 1);
    if (inline !== undefined) {
      appendFlag(flags, key, inline);
      continue;
    }

    if (command === "mcp" && rest[0] === "logs" && key === "json") {
      appendFlag(flags, key, true);
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

/**
 * v1.12.0:私网放行清单的收集。
 *
 * SSRF 默认拒绝私网/环回;自建内网 MCP Server 需显式放行。三个来源按优先级:
 *   --allow-private 命令行(可重复) > server 配置的 allowlist > 项目配置的 httpAllowlist
 */
function collectFlagAllowlist(flags) {
  const raw = flags?.get?.("allow-private");
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean);
}

function collectHttpAllowlist(srvConfig = {}, config = {}, flags = null) {
  const fromFlag = collectFlagAllowlist(flags);
  if (fromFlag.length) return fromFlag;
  // 合并而非覆盖:server 级 + 项目级都生效,任一条目命中即放行
  const merged = [
    ...(Array.isArray(srvConfig.allowlist) ? srvConfig.allowlist : []),
    ...(Array.isArray(config.httpAllowlist) ? config.httpAllowlist : [])
  ].map((s) => String(s).trim()).filter(Boolean);
  return [...new Set(merged)];
}

export async function runMcp(root, args, flags = new Map(), deps = {}) {
  const action = args[0] || "list";
  if (action === "logs") return runMcpLogs(root, args, flags, {
    createKernelImpl: createKernel, buildKernelOptionsImpl: buildKernelOptions, loadConfigImpl: loadConfig, ...deps
  });
  if (action === "resources" || action === "prompts") return runMcpContent(root, args, flags, deps);
  if (action === "auth") return runMcpAuth(root, args, flags, {
    createKernelImpl: createKernel, buildKernelOptionsImpl: buildKernelOptions, loadConfigImpl: loadConfig, ...deps
  });
  const config = await (deps.loadConfigImpl || loadConfig)(root, { allowMissingKey: true });
  const mcpServers = config.mcpServers || {};

  if (action === "list") {
    const serverKeys = Object.keys(mcpServers);
    if (!serverKeys.length) {
      console.log("当前项目未配置任何 MCP 服务。可在 .deepseek-code/config.json 中添加 \"mcpServers\" 配置。");
      return;
    }

    console.log(section(`已配置的 MCP 服务 (${serverKeys.length} 个)`));
    for (const [serverId, srv] of Object.entries(mcpServers)) {
      const stateBadge = srv.disabled ? color.dim("[已禁用]") : color.green("[已启用]");
      const type = srv.type || (srv.url ? "streamable-http" : "stdio");
      console.log(`\n• ${color.bold(serverId)} ${stateBadge} ${color.dim(`[${type}]`)}`);
      if (srv.url) {
        console.log(`  地址: ${srv.url}`);
        if (type === "sse") {
          console.log(`  ${color.yellow("注意: legacy SSE 传输已废弃,建议改用 streamable-http")}`);
        }
      } else {
        console.log(`  命令: ${srv.command} ${(srv.args || []).join(" ")}`);
      }
      // v1.13.0:trust 决定该 server 的 annotations 是否被采纳
      console.log(`  信任: ${srv.trust ? color.green("已信任(采纳其 annotations)") : color.dim("未信任(annotations 被忽略)")}`);
      if (srv.autoApprove?.length) {
        console.log(`  免审批工具: ${srv.autoApprove.join(", ")}`);
      }
    }
    console.log("\n提示: 运行 \"inkstone mcp check <serverId>\" 测试连通性与可用工具;\"inkstone mcp policy\" 管理持久放行。");
    return;
  }

  if (action === "policy") {
    const sub = args[1] || "list";
    const { createPolicyStore } = await import("./tools/mcp/tool-policy.js");
    const store = createPolicyStore({ projectRoot: root });
    if (sub === "list") {
      const grants = store.list();
      if (grants.length === 0) {
        console.log("当前没有持久放行记录(仅本次/本项目/永久)。");
        return;
      }
      console.log(section(`持久放行记录 (${grants.length} 条)`));
      for (const g of grants) {
        const scopeLabel = g.scope === "always" ? "永久" : "本项目";
        console.log(`  • ${color.bold(g.tool)}  [${scopeLabel}]  ${color.dim(g.granted_at || "")}`);
      }
      console.log(`\n${color.dim("破坏性(destructive)工具不可持久放行,只能逐次审批。")}`);
      return;
    }

    if (sub === "revoke") {
      const toolName = args[2];
      if (!toolName) {
        throw new Error("请指定要撤销的工具名，例如: inkstone mcp policy revoke mcp__srv__tool");
      }
      store.revoke(toolName, "always");
      store.revoke(toolName, "project");
      console.log(color.green(`已撤销 ${color.bold(toolName)} 的持久放行（永久与本项目两个作用域）。`));
      return;
    }
    throw new Error(`未知的 policy 子命令: ${sub}。可用: list | revoke <tool>`);
  }

  if (action === "check") {
    const serverId = args[1];
    if (!serverId) {
      throw new Error("请指定要测试的 MCP 服务标识，例如: inkstone mcp check <serverId>");
    }
    const srvConfig = mcpServers[serverId];
    if (!srvConfig) {
      throw new Error(`未找到名为 "${serverId}" 的 MCP 服务配置。`);
    }

    const type = srvConfig.type || (srvConfig.url ? "streamable-http" : "stdio");
    const write = deps.write || console.log;
    write(`正在连接 MCP 服务 "${serverId}" (${type})...`);
    // Use the same Hub auth and refresh path as other clients. A standalone
    // McpClient cannot access issuer-scoped OAuth credentials.
    const kernel = await (deps.createKernelImpl || createKernel)(root, {
      ...(await (deps.buildKernelOptionsImpl || buildKernelOptions)(root)),
      autoInitMcp: false,
      mcpServers: { [serverId]: {
        ...srvConfig,
        timeoutMs: srvConfig.timeoutMs || 15000,
        allowlist: collectHttpAllowlist(srvConfig, config, flags)
      } }
    });
    const clean = createMcpDisplayRedactor({ config, hub: kernel.mcp?.hub });
    try {
      await kernel.mcp.restartServer(serverId);
      const client = kernel.mcp.hub.getServer(serverId);
      write(color.green(clean(`✓ 连接成功！服务端信息: ${client.serverInfo?.name || "未知"} (v${client.serverInfo?.version || "未知"})`)));
      if (client.getProtocolMode) {
        write(color.dim(clean(`  协议: ${client.getProtocolMode()} / ${client.protocolVersion || "未协商"}`)));
      }
      if (client.deprecatedTransport) {
        write(color.yellow(clean(`  注意: ${client.deprecatedTransport}`)));
      }
      const tools = kernel.mcp.hub.serverTools.get(serverId) || [];
      write(`\n探测到 ${tools.length} 个可用工具:`);
      for (const tool of tools) {
        const desc = tool.description ? ` - ${tool.description}` : "";
        write(clean(`  • ${color.bold(tool.name)}${desc}`));
      }
    } catch (err) {
      (deps.writeError || console.error)(color.red(clean(`✗ 连接失败: ${err.message}`)));
      const stderr = kernel.mcp?.hub?.getServer(serverId)?.getRecentStderr?.();
      if (stderr) {
        (deps.writeError || console.error)(clean(`\n最近进程日志:\n${stderr}`));
      }
      throw new Error(clean(err?.message || String(err)));
    } finally {
      await kernel.dispose?.();
    }
    return;
  }

  if (action === "add") {
    const serverId = args[1];
    if (!serverId || !/^[a-zA-Z0-9_-]+$/.test(serverId)) {
      throw new Error("请指定有效的 MCP 服务标识（只支持英文字母、数字、下划线与中划线），例如: inkstone mcp add <serverId> --command <cmd>");
    }
    const command = flags.get("command");
    const url = flags.get("url");
    if (!command && !url) {
      throw new Error("添加 MCP 服务必须指定 --command（stdio）或 --url（远程），例如: inkstone mcp add fs --command npx --args \"-y,@modelcontextprotocol/server-filesystem,./src\"");
    }
    const rawArgs = flags.get("args");
    const parsedArgs = rawArgs
      ? (rawArgs.includes(",") ? rawArgs.split(",") : rawArgs.split(/\s+/)).map((s) => s.trim()).filter(Boolean)
      : [];
    const autoApproveRaw = flags.get("auto-approve") || flags.get("autoApprove");
    const autoApprove = autoApproveRaw ? autoApproveRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const disabled = flags.has("disabled");
    const cwd = flags.get("cwd") || undefined;
    const timeoutMs = flags.has("timeout") ? Number(flags.get("timeout")) : undefined;
    // v1.12.0:远程类型/请求头/私网放行
    const rawType = flags.get("type");
    const type = rawType ? String(rawType).trim().toLowerCase() : (url ? "streamable-http" : undefined);
    const rawHeaders = flags.get("headers");
    let headers = null;
    if (rawHeaders) {
      try {
        headers = JSON.parse(rawHeaders);
      } catch {
        throw new Error('--headers 必须是 JSON 对象，例如: --headers "{\\"Authorization\\":\\"Bearer ${input:tok}\\"}"');
      }
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
        throw new Error("--headers 必须是 JSON 对象");
      }
    }
    const allowPrivate = collectFlagAllowlist(flags);
    const oauthEnabled = boolFlag(flags, "oauth");
    if (["client-secret", "access-token", "refresh-token"].some((key) => flags.has(key))) {
      throw new Error("OAuth 凭据不能写入服务配置，请通过 inkstone mcp auth <server> 登录。");
    }
    if ((flags.has("client-id") || flags.has("scopes")) && !oauthEnabled) {
      throw new Error("--client-id 和 --scopes 需要同时指定 --oauth。");
    }
    if (oauthEnabled && (!url || command || type === "stdio")) {
      throw new Error("--oauth 仅用于通过 --url 配置的远程 MCP 服务。");
    }
    const clientId = flags.get("client-id");
    if (flags.has("client-id") && (typeof clientId !== "string" || !clientId.trim())) {
      throw new Error("--client-id 需要非空客户端标识。");
    }
    const rawScopes = flags.get("scopes");
    if (flags.has("scopes") && (typeof rawScopes !== "string" || !rawScopes.trim())) {
      throw new Error("--scopes 需要以空格或逗号分隔的授权范围。");
    }
    const scopes = typeof rawScopes === "string" ? [...new Set(rawScopes.split(/[\s,]+/).filter(Boolean))] : [];
    if (scopes.some((scope) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))) {
      throw new Error("--scopes 包含无效的 OAuth 授权范围。");
    }

    const srvConfig = {
      ...(command ? { command: command.trim() } : {}),
      ...(url ? { url: url.trim() } : {}),
      ...(parsedArgs.length ? { args: parsedArgs } : {}),
      ...(autoApprove.length ? { autoApprove } : {}),
      ...(disabled ? { disabled: true } : {}),
      ...(cwd ? { cwd } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(type ? { type } : {}),
      ...(headers ? { headers } : {}),
      ...(allowPrivate.length ? { allowlist: allowPrivate } : {}),
      ...(oauthEnabled ? { oauth: { enabled: true, ...(clientId ? { clientId: clientId.trim() } : {}), ...(scopes.length ? { scopes } : {}) } } : {}),
      // v1.13.0:trust 决定是否采纳该 server 自报的 annotations
      ...(flags.has("trust") ? { trust: true } : {})
    };

    const nextMcpServers = { ...mcpServers, [serverId]: srvConfig };
    const { configureProject } = await import("./config.js");
    await configureProject(root, { mcpServers: nextMcpServers });

    console.log(color.green(`✓ 已成功添加并保存 MCP 服务 "${serverId}" 到 .deepseek-code/config.json！`));
    if (url) {
      console.log(`  地址: ${url} (${type || "streamable-http"})`);
      if (type === "sse") {
        console.log(`  ${color.yellow("注意: legacy SSE 已废弃,建议改用 --type streamable-http")}`);
      }
    } else {
      console.log(`  命令: ${command} ${parsedArgs.join(" ")}`);
    }
    if (autoApprove.length) {
      console.log(`  免审批工具: ${autoApprove.join(", ")}`);
    }
    if (flags.has("trust")) {
      console.log(`  信任: 已信任 —— 该 server 自报的 annotations 将被采纳`);
      console.log(`  ${color.yellow("注意: 请只信任你自己部署/审计过的 server;不受信 server 的 annotations 一律忽略。")}`);
    }
    if (allowPrivate.length) {
      console.log(`  私网放行: ${allowPrivate.join(", ")}`);
    }
    if (oauthEnabled) console.log(`  OAuth: 已启用。运行 "inkstone mcp auth ${serverId}" 完成登录。`);
    console.log(`\n提示: 可运行 "inkstone mcp check ${serverId}" 测试连通性。`);
    return;
  }

  if (action === "remove" || action === "rm") {
    const serverId = args[1];
    if (!serverId) {
      throw new Error("请指定要移除的 MCP 服务标识，例如: inkstone mcp remove <serverId>");
    }
    if (!mcpServers[serverId]) {
      throw new Error(`未找到名为 "${serverId}" 的 MCP 服务配置。`);
    }
    const nextMcpServers = { ...mcpServers };
    delete nextMcpServers[serverId];
    const { configureProject } = await import("./config.js");
    await configureProject(root, { mcpServers: nextMcpServers });

    console.log(color.green(`✓ 已成功从配置文件中移除 MCP 服务 "${serverId}"。`));
    return;
  }

  if (action === "toggle") {
    const serverId = args[1];
    if (!serverId) {
      throw new Error("请指定要切换状态的 MCP 服务标识，例如: inkstone mcp toggle <serverId>");
    }
    if (!mcpServers[serverId]) {
      throw new Error(`未找到名为 "${serverId}" 的 MCP 服务配置。`);
    }
    const targetDisabled = flags.has("enable") ? false : flags.has("disable") ? true : !mcpServers[serverId].disabled;
    const nextMcpServers = {
      ...mcpServers,
      [serverId]: { ...mcpServers[serverId], disabled: targetDisabled }
    };
    const { configureProject } = await import("./config.js");
    await configureProject(root, { mcpServers: nextMcpServers });

    const badge = targetDisabled ? color.dim("已禁用") : color.green("已启用");
    console.log(color.green(`✓ 已将 MCP 服务 "${serverId}" 切换为 ${badge}。`));
    return;
  }

  throw new Error(`未知 MCP 操作 "${action}"。可使用 list、check、add、remove、toggle、policy、resources、prompts、logs 或 auth。运行 inkstone help 查看用法。`);
}

async function runMcpContent(root, args, flags, deps) {
  const { write = console.log, createKernelImpl = createKernel, buildKernelOptionsImpl = buildKernelOptions, loadConfigImpl = loadConfig } = deps;
  const [kind, serverId, sub = "list", target] = args;
  const usage = kind === "resources"
    ? "inkstone mcp resources <server> [list|templates|read <uri>]"
    : "inkstone mcp prompts <server> [list|get <name> --arguments JSON]";
  if (!serverId || !/^[a-zA-Z0-9_.-]+$/.test(serverId)) throw new Error(`请指定 MCP 服务标识。用法：${usage}`);
  const valid = kind === "resources" ? ["list", "templates", "read"] : ["list", "get"];
  if (!valid.includes(sub) || args.length > (sub === "read" || sub === "get" ? 4 : 3)) throw new Error(`用法：${usage}`);
  if ((sub === "read" || sub === "get") && !target?.trim()) throw new Error(`用法：${usage}`);
  const limit = (flag, fallback, max) => {
    if (!flags.has(flag)) return fallback;
    const raw = flags.get(flag);
    const value = typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`--${flag} 必须是 1–${max} 的整数。`);
    return value;
  };
  const options = {
    maxPages: limit("max-pages", 5, 100),
    maxItems: limit("max-items", 200, 10000),
    maxBytes: limit("max-bytes", 65536, 65536)
  };
  if (flags.has("cursor")) {
    const cursor = flags.get("cursor");
    if (typeof cursor !== "string" || !cursor) throw new Error("--cursor 需要非空游标。");
    if (cursor.startsWith("inkstone-page:")) throw new Error("该游标仅在原连接中有效；请重新列出并提高 --max-items/--max-pages 上限。");
    options.cursor = cursor;
  }
  let promptArgs = {};
  if (flags.has("arguments")) {
    if (kind !== "prompts" || sub !== "get") throw new Error("--arguments 仅用于 prompts get。");
    try {
      promptArgs = JSON.parse(flags.get("arguments"));
      if (!promptArgs || typeof promptArgs !== "object" || Array.isArray(promptArgs)
        || Object.values(promptArgs).some((value) => typeof value !== "string")) throw new Error();
    } catch { throw new Error("--arguments 必须为值均为字符串的 JSON 对象。"); }
  }
  const config = await loadConfigImpl(root, { allowMissingKey: true });
  const kernel = await createKernelImpl(root, { ...(await buildKernelOptionsImpl(root)), autoInitMcp: false });
  const clean = createMcpDisplayRedactor({ config: { ...config, arguments: promptArgs }, hub: kernel.mcp?.hub });
  try {
    const method = kind === "resources"
      ? sub === "read" ? "readResource" : sub === "templates" ? "listResourceTemplates" : "listResources"
      : sub === "get" ? "getPrompt" : "listPrompts";
    if (typeof kernel.mcp?.[method] !== "function") throw new Error("MCP 内容接口不可用。");
    const result = sub === "read" ? await kernel.mcp[method](serverId, target, options)
      : sub === "get" ? await kernel.mcp[method](serverId, target, promptArgs, options)
        : await kernel.mcp[method](serverId, options);
    if (result?.error) throw new Error(typeof result.error === "string" ? result.error : result.error.message || "MCP request failed");
    const safe = clean(result);
    if (safe?.supported === false) write("该 MCP 服务不支持此能力。");
    write(JSON.stringify(safe, null, 2));
    if (safe?.truncated) write("结果已截断；可调整 --max-pages / --max-items / --max-bytes 后重新读取。");
    if (safe?.nextCursor?.startsWith("inkstone-page:")) write("nextCursor 仅在当前连接中有效；下次命令请提高读取上限，不要复用此游标。");
    return safe;
  } catch (error) {
    throw new Error(clean(error?.message || String(error)));
  } finally {
    await kernel.dispose?.();
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
${commandLine("inkstone mcp [list|check]", "管理与检查 MCP 外部扩展服务与工具")}
${commandLine("inkstone mcp logs [server] [--limit 50] [--json]", "读取历史诊断日志；支持 --level/--category/--method/--search 过滤")}
${commandLine("inkstone mcp auth <server> [login|status|cancel|logout]", "OAuth 登录、查看状态、取消或清除本地凭据")}
${commandLine("inkstone mcp add <server> --url <url> --oauth", "添加 OAuth 服务；可指定 --client-id 和 --scopes")}
${commandLine("inkstone mcp resources <server> [list|templates]", "按需列出资源或 URI 模板")}
${commandLine("inkstone mcp resources <server> read <uri>", "通过 MCP 服务读取资源（不会直接访问 URI）")}
${commandLine("inkstone mcp prompts <server> [list|get <name>]", "列出或获取提示词；参数用 --arguments '{\"key\":\"value\"}'")}
${commandLine("  --max-pages 5 --max-items 200 --max-bytes 65536", "内容分页/字节上限；--cursor <server-cursor> 续读服务端游标")}

环境变量：
  DEEPSEEK_API_KEY     如果本地配置没有 apiKey，则使用这里的密钥
  DEEPSEEK_BASE_URL    默认 https://api.deepseek.com
  DEEPSEEK_MODEL       默认 deepseek-flash
  DEEPSEEK_REASONING_EFFORT 默认 high
`);
}
