import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { inputFields, inputFieldHint, parseInputField } from "../mcp-input-form.js";
import { createMcpDisplayRedactor } from "../../security/mcp-content.js";

const terminalText = (value) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 1024);

export function createCliMcpInputPrompt({ kernel, write = console.log, input = process.stdin, output = process.stdout, question } = {}) {
  return async (request, { signal } = {}) => {
    if (!question && !input?.isTTY) {
      write("MCP input declined: an interactive terminal is required.");
      return { action: "decline" };
    }
    const clean = createMcpDisplayRedactor({ config: kernel?.config, hub: kernel?.mcp?.hub });
    const safe = (value) => terminalText(clean(String(value ?? "")));
    const fields = inputFields(request);
    write(`MCP input · ${safe(request.serverId)}`);
    write(safe(request.message));
    write("Values are hidden. Esc cancels; nothing is sent until you confirm.");
    const content = Object.create(null);
    for (const field of fields) {
      write(`${safe(field.rule.title || field.name)}${field.required ? " *" : " (optional)"} · ${safe(inputFieldHint(field))}`);
      if (field.rule.description) write(safe(field.rule.description));
      for (;;) {
        if (signal?.aborted) return { action: "cancel" };
        const raw = await (question || hiddenQuestion)("> ", { signal, input, output });
        if (raw == null) return { action: "cancel" };
        try {
          const result = parseInputField(field, String(raw));
          if (!result.omitted) content[field.name] = result.value;
          break;
        } catch (error) { write(error.message); }
      }
    }
    if (signal?.aborted) return { action: "cancel" };
    const confirm = await (question || hiddenQuestion)(`Send ${Object.keys(content).length} field(s) to ${safe(request.serverId)}? y/N > `, { signal, input, output });
    return /^y(es)?$/i.test(String(confirm || "").trim()) ? { action: "accept", content } : { action: confirm == null ? "cancel" : "decline" };
  };
}

async function hiddenQuestion(label, { signal, input, output }) {
  // readline owns raw mode but its output is suppressed, so values never reach
  // the terminal scrollback, shell history, or event renderer.
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  sink.isTTY = true;
  const local = new AbortController();
  const abort = () => local.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) local.abort();
  const rl = createInterface({ input, output: sink, terminal: true, historySize: 0 });
  const onKey = (_text, key) => { if (key?.name === "escape") abort(); };
  input.on("keypress", onKey);
  rl.on("SIGINT", abort);
  rl.on("close", abort);
  output.write(label);
  try { return await rl.question("", { signal: local.signal }); }
  catch (error) { if (local.signal.aborted) return null; throw error; }
  finally {
    signal?.removeEventListener("abort", abort);
    input.removeListener("keypress", onKey);
    rl.close();
    sink.end();
    output.write("\n");
  }
}
