import { spawn } from "node:child_process";
import { classifyCommand } from "./command-policy.js";

export function normalizeShellParams(raw = {}) {
  if (typeof raw.cmd === "string") {
    throw new Error("Shell cmd string is not supported. Use structured argv.");
  }
  const argv = raw.argv;
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("argv must contain at least one command entry");
  }
  if (!argv.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error("argv entries must be non-empty strings");
  }
  return {
    argv,
    cwd: typeof raw.cwd === "string" && raw.cwd.length > 0 ? raw.cwd : ".",
    timeout_ms: clampTimeout(raw.timeout_ms),
    shell: false
  };
}

export function limitOutput(text = "", maxChars = 32000) {
  const value = String(text);
  return {
    text: value.slice(0, maxChars),
    truncated: value.length > maxChars,
    original_length: value.length
  };
}

function clampTimeout(value) {
  const numeric = Number(value || 30000);
  if (!Number.isFinite(numeric) || numeric <= 0) return 30000;
  return Math.min(numeric, 120000);
}

const CHILD_ENV_ALLOW = new Set([
  "path", "pathext", "systemroot", "comspec", "windir",
  "home", "userprofile", "homedrive", "homepath",
  "tmp", "temp", "tmpdir",
  "lang", "lc_all", "lc_ctype", "language"
]);

export function buildChildEnv(baseEnv = process.env, { allowExtra = [] } = {}) {
  const out = {};
  const lowerToActual = new Map();
  for (const key of Object.keys(baseEnv || {})) {
    const lower = key.toLowerCase();
    if (!lowerToActual.has(lower)) lowerToActual.set(lower, key);
  }
  for (const allowed of CHILD_ENV_ALLOW) {
    const actual = lowerToActual.get(allowed);
    if (actual != null && baseEnv[actual] != null) out[actual] = baseEnv[actual];
  }
  for (const extra of allowExtra) {
    if (typeof extra === "string" && Object.prototype.hasOwnProperty.call(baseEnv || {}, extra)) {
      out[extra] = baseEnv[extra];
    }
  }
  return out;
}

export function runProcess(argv, { cwd, timeoutMs = 30000, env, signal = null } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer = null;
    let child = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    }

    function spawnErrorResult(message) {
      const errOut = limitOutput(stderr || message);
      return {
        content: [{ type: "text", text: `spawn error: ${message}` + (errOut.text ? `\n${errOut.text}` : "") }],
        stdout: "",
        stderr: errOut.text || message,
        metadata: {
          exit_code: null,
          signal: null,
          spawn_error: message,
          stdout_truncated: false,
          stderr_truncated: errOut.truncated
        }
      };
    }

    // 兜底仅拦 forbidden(dangerous 属审批层职责,拦了会打断 test 工具的包装 shell 嵌套回路)。
    if (classifyCommand(argv) === "forbidden") {
      finish(spawnErrorResult(`command policy: forbidden command refused: ${argv[0]}`));
      return;
    }

    try {
      child = spawn(argv[0], argv.slice(1), { cwd, shell: false, windowsHide: true, env: env ?? buildChildEnv(process.env) });
    } catch (err) {
      finish(spawnErrorResult(err.message));
      return;
    }

    if (signal) {
      if (signal.aborted) {
        try { child.kill(); } catch {}
      } else {
        signal.addEventListener("abort", () => {
          try { child.kill(); } catch {}
        }, { once: true });
      }
    }

    timer = setTimeout(() => { child.kill(); }, timeoutMs);

    const maxBuffer = 64000;
    child.stdout.on("data", (chunk) => {
      if (stdout.length < maxBuffer) {
        stdout += chunk.toString();
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < maxBuffer) {
        stderr += chunk.toString();
      }
    });

    child.on("error", (err) => {
      finish(spawnErrorResult(err.message));
    });

    child.on("close", (code, signal) => {
      const out = limitOutput(stdout);
      const err = limitOutput(stderr);
      finish({
        content: [{ type: "text", text: out.text + (err.text ? `\n${err.text}` : "") }],
        stdout: out.text,
        stderr: err.text,
        metadata: {
          exit_code: code,
          signal,
          stdout_truncated: out.truncated,
          stderr_truncated: err.truncated
        }
      });
    });
  });
}
