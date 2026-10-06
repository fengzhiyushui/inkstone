import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import process from "node:process";

const SAFE_ENV_KEYS = [
  "PATH",
  "Path",
  "NODE_PATH",
  "SystemRoot",
  "SYSTEMROOT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TEMP",
  "TMP",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL"
];

function shouldRunInShell(command, explicitShell) {
  if (explicitShell !== undefined) {
    return Boolean(explicitShell);
  }
  if (process.platform !== "win32") {
    return false;
  }
  const lower = command.toLowerCase();
  if (
    lower.endsWith(".cmd") ||
    lower.endsWith(".bat") ||
    lower === "npx" ||
    lower === "npm" ||
    lower === "uvx"
  ) {
    return true;
  }
  return false;
}

export class StdioTransport extends EventEmitter {
  constructor({
    command,
    args = [],
    env = {},
    cwd = process.cwd(),
    shell = undefined,
    maxStderrLines = 100
  } = {}) {
    super();
    if (!command) {
      throw new Error("StdioTransport: 'command' is required");
    }
    this.command = command;
    this.args = Array.isArray(args) ? [...args] : [];
    this.env = { ...env };
    this.cwd = cwd;
    this.shell = shell;
    this.maxStderrLines = maxStderrLines;

    this.child = null;
    this.readline = null;
    this.state = "idle";
    this.stderrBuffer = [];
  }

  getSafeEnvironment() {
    const safeEnv = {};
    for (const key of SAFE_ENV_KEYS) {
      if (process.env[key] !== undefined) {
        safeEnv[key] = process.env[key];
      }
    }
    return { ...safeEnv, ...this.env };
  }

  start() {
    if (this.state === "running" || this.state === "starting") {
      return;
    }
    this.state = "starting";

    const finalEnv = this.getSafeEnvironment();
    const useShell = shouldRunInShell(this.command, this.shell);

    try {
      this.child = spawn(this.command, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: finalEnv,
        cwd: this.cwd,
        shell: useShell,
        windowsHide: true
      });
    } catch (err) {
      this.state = "error";
      this.emit("error", err);
      throw err;
    }

    this.state = "running";
    const child = this.child;

    if (this.child.stdout) {
      this.readline = createInterface({
        input: this.child.stdout,
        terminal: false,
        crlfDelay: Infinity
      });

      this.readline.on("line", (line) => {
        if (this.child !== child || this.state !== "running") return;
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed);
          this.emit("message", parsed);
        } catch (err) {
          this.emit("protocol_error", { line: trimmed, error: err });
        }
      });
    }

    if (this.child.stderr) {
      this.child.stderr.setEncoding("utf8");
      this.child.stderr.on("data", (chunk) => {
        if (this.child !== child || this.state !== "running") return;
        const text = String(chunk);
        const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
        for (const l of lines) {
          this.stderrBuffer.push(l);
          if (this.stderrBuffer.length > this.maxStderrLines) {
            this.stderrBuffer.shift();
          }
        }
        this.emit("stderr", text);
      });
    }

    this.child.on("error", (err) => {
      if (this.child !== child) return;
      this.state = "error";
      this.emit("error", err);
    });

    this.child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.state = "stopped";
      this.emit("close", { code, signal });
    });
  }

  send(message) {
    if (this.state !== "running" || !this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error(`StdioTransport: cannot send message while state is '${this.state}'`);
    }

    const payload = typeof message === "string" ? message : JSON.stringify(message);
    const toWrite = payload.endsWith("\n") ? payload : payload + "\n";
    this.child.stdin.write(toWrite);
  }

  getRecentStderr() {
    return this.stderrBuffer.join("\n");
  }

  async close() {
    if (this.state === "stopped" || this.state === "idle") {
      return;
    }
    this.state = "stopping";

    if (this.readline) {
      try {
        this.readline.close();
      } catch (_) {}
      this.readline = null;
    }

    if (this.child) {
      const closingChild = this.child;
      if (this.child.stdin && !this.child.stdin.destroyed) {
        try {
          this.child.stdin.end();
        } catch (_) {}
      }

      const pid = this.child.pid;
      if (pid) {
        if (process.platform === "win32") {
          try {
            spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
          } catch (_) {}
        } else {
          try {
            this.child.kill("SIGTERM");
          } catch (_) {}

          setTimeout(() => {
            if (closingChild.exitCode === null && closingChild.signalCode === null) {
              try {
                closingChild.kill("SIGKILL");
              } catch (_) {}
            }
          }, 2000).unref?.();
        }
      }
    }

    this.state = "stopped";
  }
}
