// src/apps/tui/slash.js — slash 命令注册表与解析(纯)。执行器在 tui-app 闭包里。
export const SLASH_COMMANDS = [
  { name: "help", descKey: "slash.help.desc" },
  { name: "config", descKey: "slash.config.desc" },
  { name: "diff", descKey: "slash.diff.desc" },
  { name: "changes", descKey: "slash.changes.desc" },
  { name: "mode", descKey: "slash.mode.desc" },
  { name: "lang", descKey: "slash.lang.desc" },
  { name: "theme", descKey: "slash.theme.desc" },
  { name: "shell", descKey: "slash.shell.desc" },
  { name: "clear", descKey: "slash.clear.desc" },
  { name: "recovery", descKey: "slash.recovery.desc" },
  { name: "branch", descKey: "slash.branch.desc" },
  { name: "rewind", descKey: "slash.rewind.desc" },
  { name: "fim", descKey: "slash.fim.desc" },
  { name: "quit", descKey: "slash.quit.desc" }
];

export function filterCommands(prefix) {
  const p = String(prefix || "").toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(p));
}

export function parseSlash(line) {
  const text = String(line || "").trim();
  if (!text.startsWith("/") || text.length < 2) return null;
  const body = text.slice(1);
  const space = body.indexOf(" ");
  if (space === -1) return { name: body, arg: "" };
  return { name: body.slice(0, space), arg: body.slice(space + 1).trim() };
}
